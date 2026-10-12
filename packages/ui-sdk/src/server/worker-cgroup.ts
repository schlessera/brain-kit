/**
 * A cgroup v2 child per agent worker (#1660), when the host delegates one.
 *
 * cgroup v2 enables a controller for children only in a cgroup without
 * processes of its own. So the server, when it runs alone in a cgroup it can
 * write, moves itself into a `brain-server` leaf and gives each worker a
 * child of `brain-workers`:
 *
 * ```
 * <the server's cgroup>/            subtree_control: +memory +pids +cpu
 *   brain-server/                   the server
 *   brain-workers/                  subtree_control: +memory +pids +cpu
 *     w-<pid>-<id>/                 memory.max, memory.swap.max, pids.max, cpu.max
 * ```
 *
 * That is the layout systemd expects under `Delegate=yes` (a service, or
 * `systemd-run --user --scope -p Delegate=yes`), whose command starts alone
 * in its cgroup. A cgroup holding any other process is not taken over: its
 * accounting is not the server's to move. Docker mounts the cgroup filesystem
 * read-only, so a container gets the rlimits only. Whatever cannot be
 * established is stated, with its reason.
 *
 * The worker's trusted bootstrap joins its cgroup before `execve`, so no
 * worker process ever runs outside it. The worker sees `/sys` read-only. A
 * worker that mounts its own cgroup2 from a nested user and cgroup namespace
 * sees its cgroup as that namespace's root, and `nsdelegate` makes a
 * namespace root's limits unwritable from inside it. Without `nsdelegate` a
 * worker could raise its own limits, so the cgroup is not used.
 */
import { accessSync, constants, existsSync, mkdirSync, readFileSync, readdirSync, rmdirSync, statfsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { WorkerLimitHit, WorkerResourceLimits } from "./worker-limits.js";

const CGROUP2_MAGIC = 0x63677270;
const CONTROLLERS = ["memory", "pids", "cpu"] as const;
type Controller = typeof CONTROLLERS[number];
const CPU_PERIOD = 100_000;

export type WorkerCgroupHost =
  | { available: true; workers: string; controllers: readonly Controller[] }
  | { available: false; reason: string };

export interface WorkerCgroupEnvironment {
  /** Where the cgroup v2 hierarchy is mounted. */
  mount: string;
  /** This process's `/proc/self/cgroup`. */
  selfCgroup: string;
  /** This process's `/proc/self/mountinfo`. */
  mountInfo: string;
  pid: number;
}

const readOrEmpty = (path: string) => { try { return readFileSync(path, "utf8"); } catch { return ""; } };

export function hostCgroupEnvironment(): WorkerCgroupEnvironment {
  return { mount: "/sys/fs/cgroup", selfCgroup: readOrEmpty("/proc/self/cgroup"), mountInfo: readOrEmpty("/proc/self/mountinfo"), pid: process.pid };
}

const readList = (path: string) => readFileSync(path, "utf8").split(/\s+/).filter(Boolean);
const code = (error: unknown) => (error as NodeJS.ErrnoException).code ?? (error instanceof Error ? error.message : String(error));

/** The super options of the cgroup2 filesystem mounted at `mount`, from mountinfo. */
function cgroup2Options(mountInfo: string, mount: string): string[] | undefined {
  for (const line of mountInfo.split("\n").reverse()) {
    const [mountFields, superFields] = line.split(" - ");
    if (!mountFields || !superFields) continue;
    if (mountFields.split(" ")[4] !== mount) continue;
    const [type, , options] = superFields.split(" ");
    return type === "cgroup2" ? (options ?? "").split(",") : undefined;
  }
  return undefined;
}

/**
 * Establishes the layout above once, or says why it cannot. Never throws.
 * `cgroup=off` in the host configuration skips it.
 */
export function establishWorkerCgroups(env: WorkerCgroupEnvironment = hostCgroupEnvironment()): WorkerCgroupHost {
  const line = env.selfCgroup.split("\n").find(entry => entry.startsWith("0::"));
  if (!line) return { available: false, reason: "the server is not in a cgroup v2 hierarchy" };
  const relative = line.slice(3).trim();
  let own = join(env.mount, relative);
  try {
    if (statfsSync(env.mount).type !== CGROUP2_MAGIC) return { available: false, reason: `${env.mount} is not a cgroup v2 filesystem` };
  } catch (error) { return { available: false, reason: `${env.mount} cannot be read (${code(error)})` }; }
  if (!cgroup2Options(env.mountInfo, env.mount)?.includes("nsdelegate")) {
    return { available: false, reason: "the cgroup2 filesystem is mounted without nsdelegate, so a worker could raise its own limits" };
  }
  // Already set up by this process: a second call.
  if (relative.endsWith("/brain-server")) own = own.slice(0, -"/brain-server".length);
  const server = join(own, "brain-server");
  const workers = join(own, "brain-workers");
  try {
    const available = readList(join(own, "cgroup.controllers"));
    const controllers = CONTROLLERS.filter(name => available.includes(name));
    if (!controllers.includes("memory") && !controllers.includes("pids")) {
      return { available: false, reason: "the server's cgroup is not delegated the memory or pids controller" };
    }
    try { accessSync(join(own, "cgroup.procs"), constants.W_OK); } catch (error) {
      return { available: false, reason: `the server's cgroup is not writable (${code(error)}). Docker mounts the cgroup filesystem`
        + " read-only; elsewhere, run the server in a delegated cgroup (systemd Delegate=yes)" };
    }
    // Alone: no other process, not even one the server started, whose pid
    // could be reused between this check and a move.
    const members = readList(join(own, "cgroup.procs")).map(Number);
    if (members.some(pid => pid !== env.pid)) {
      return { available: false, reason: "the server's cgroup holds other processes; run the server alone in a delegated cgroup (systemd Delegate=yes)" };
    }
    if (!existsSync(server)) mkdirSync(server);
    // "0" moves the writing process itself, never a pid that could be reused.
    if (members.length) writeFileSync(join(server, "cgroup.procs"), "0");
    const enable = controllers.map(name => `+${name}`).join(" ");
    writeFileSync(join(own, "cgroup.subtree_control"), enable);
    if (!existsSync(workers)) mkdirSync(workers);
    writeFileSync(join(workers, "cgroup.subtree_control"), enable);
    // Workers of an earlier server life in this unit are gone with their PID
    // namespaces. A live server's (its pid leads the name) are left alone.
    for (const name of readdirSync(workers)) {
      const owner = /^w-(\d+)-/.exec(name)?.[1];
      if (!owner || existsSync(`/proc/${owner}`)) continue;
      try { rmdirSync(join(workers, name)); } catch { /* still draining */ }
    }
    return { available: true, workers, controllers };
  } catch (error) {
    return { available: false, reason: `the server's cgroup is not writable as a delegated subtree (${code(error)})` };
  }
}

let established: WorkerCgroupHost | undefined;

/** The process-wide cgroup host, established on first use. */
export function workerCgroupHost(limits: WorkerResourceLimits): WorkerCgroupHost {
  if (!limits.cgroup) return { available: false, reason: "turned off by the host (cgroup=off)" };
  if (process.platform !== "linux") return { available: false, reason: "cgroups need Linux" };
  established ??= establishWorkerCgroups();
  return established;
}

/**
 * A worker's cgroup could not be created after the host was established:
 * from now on the host has none, and the status and the agent's note say so.
 */
export function workerCgroupHostFailed(reason: string): void {
  established = { available: false, reason: `a worker cgroup could not be created (${reason})` };
}

export interface WorkerCgroup {
  path: string;
  freeze(): void;
  resume(): void;
  /** Limits written to this cgroup, by name. */
  applied: Array<{ limit: "memory" | "pids" | "cpu"; value: number }>;
  /** What the kernel recorded against those limits so far. */
  hits(): WorkerLimitHit[];
  /** The worker's peak memory and task count so far. */
  peak(): { memoryBytes?: number; tasks?: number };
  /** Times the worker reached its own memory.max, and OOM kills of its processes by any OOM killer. */
  memoryCounters(): { oom: number; oomKill: number };
  /** Removes the cgroup once its processes are gone. Never throws. */
  remove(): void;
}

function counter(file: string, key: string): number {
  try {
    const line = readFileSync(file, "utf8").split("\n").find(entry => entry.startsWith(`${key} `));
    return line ? Number(line.slice(key.length + 1)) : 0;
  } catch { return 0; }
}

let sequence = 0;

/** Creates and configures one worker's cgroup. Throws when the host cannot. */
export function createWorkerCgroup(host: Extract<WorkerCgroupHost, { available: true }>, limits: WorkerResourceLimits): WorkerCgroup {
  const path = join(host.workers, `w-${process.pid}-${Date.now().toString(36)}-${++sequence}`);
  mkdirSync(path);
  const applied: WorkerCgroup["applied"] = [];
  try {
    // A worker that mounts cgroup2 for itself could create child cgroups,
    // which would outlive it. It gets none; nsdelegate keeps it from raising this.
    writeFileSync(join(path, "cgroup.max.descendants"), "0");
    if (host.controllers.includes("memory") && limits.memory !== null) {
      // No memory.oom.group: the kernel kills the largest process, usually the
      // runaway command, and the agent keeps running to try something else.
      writeFileSync(join(path, "memory.max"), String(limits.memory));
      // Without this a runaway worker swaps past its limit and fills the host's swap instead.
      if (existsSync(join(path, "memory.swap.max"))) writeFileSync(join(path, "memory.swap.max"), "0");
      applied.push({ limit: "memory", value: limits.memory });
    }
    if (host.controllers.includes("pids") && limits.pids !== null) {
      writeFileSync(join(path, "pids.max"), String(limits.pids));
      applied.push({ limit: "pids", value: limits.pids });
    }
    if (host.controllers.includes("cpu") && limits.cpu !== null) {
      writeFileSync(join(path, "cpu.max"), `${Math.max(1000, Math.round(limits.cpu * CPU_PERIOD))} ${CPU_PERIOD}`);
      applied.push({ limit: "cpu", value: limits.cpu });
    }
  } catch (error) {
    try { rmdirSync(path); } catch { /* best effort */ }
    throw error;
  }
  return {
    path,
    freeze() {
      writeFileSync(join(path, "cgroup.freeze"), "1");
      const deadline = Date.now() + 5_000;
      while (counter(join(path, "cgroup.events"), "frozen") !== 1) {
        if (Date.now() >= deadline) throw new Error("Worker cgroup did not confirm its frozen state");
        Bun.sleepSync(1);
      }
    },
    resume() { writeFileSync(join(path, "cgroup.freeze"), "0"); },
    applied,
    hits() {
      const out: WorkerLimitHit[] = [];
      for (const { limit, value } of applied) {
        // memory: "oom" counts the times this worker's own limit was reached
        // with an allocation about to fail. "oom_kill" also counts kills by a
        // host or ancestor OOM, which are not this limit's doing.
        const events = limit === "memory" ? counter(join(path, "memory.events"), "oom")
          : limit === "pids" ? counter(join(path, "pids.events"), "max")
          : counter(join(path, "cpu.stat"), "nr_throttled");
        if (events > 0) out.push({ limit, source: "cgroup", value, events });
      }
      return out;
    },
    peak() {
      const read = (file: string) => {
        try { const value = Number(readFileSync(join(path, file), "utf8").trim()); return Number.isFinite(value) ? value : undefined; } catch { return undefined; }
      };
      const memoryBytes = read("memory.peak"), tasks = read("pids.peak");
      return { ...(memoryBytes !== undefined ? { memoryBytes } : {}), ...(tasks !== undefined ? { tasks } : {}) };
    },
    memoryCounters() {
      return { oom: counter(join(path, "memory.events"), "oom"), oomKill: counter(join(path, "memory.events"), "oom_kill") };
    },
    remove() { removeTree(path); },
  };
}

/** Removes a cgroup and anything below it, deepest first. Never throws. */
function removeTree(path: string): void {
  let children: string[] = [];
  try { children = readdirSync(path, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name); } catch { return; }
  for (const child of children) removeTree(join(path, child));
  for (let attempt = 0; attempt < 50; attempt++) {
    try { rmdirSync(path); return; } catch (error) {
      if (code(error) !== "EBUSY") return;
      // A worker's last processes may still be exiting; end them.
      try { writeFileSync(join(path, "cgroup.kill"), "1"); } catch { /* older kernel */ }
      Bun.sleepSync(10);
    }
  }
}
