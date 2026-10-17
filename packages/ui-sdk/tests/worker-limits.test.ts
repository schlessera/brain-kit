import { launchFixtureAgentWorker as launchAgentWorker } from "./helpers/worker-startup-view-fixture.js";
/**
 * Worker resource limits (#1660): the real launcher, real bubblewrap, real
 * prlimit. Each fixture runs inside a worker and is observed from outside.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statfsSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { WORKER_FILESYSTEM_FILTER_PROGRAM } from "../src/server/worker-filesystem-filter";
import { workerCommand, WorkerHostError } from "../src/server/worker-launcher";
import {
  cgroupMemoryCeiling, defaultWorkerLimits, effectiveRlimits, parseWorkerLimits, PRLIMIT_REQUIREMENT, prlimitArgs, ROOT_NPROC_REASON,
  workerLimitsPlan, workerLimitsStatus, workerNoteLimits, type WorkerLimitsPlan,
} from "../src/server/worker-limits";
import { establishWorkerCgroups, hostCgroupEnvironment } from "../src/server/worker-cgroup";
import { workerSandboxNote } from "../src/server/worker-sandbox";

const ROOT = resolve(import.meta.dir, "../../..");
const GIB = 1024 ** 3, MIB = 1024 ** 2;
const NO_CGROUP = { available: false as const, reason: "fixture: no delegated cgroup" };

function brain() {
  mkdirSync(join(ROOT, "tmp"), { recursive: true });
  const root = mkdtempSync(join(ROOT, "tmp/worker-limits-"));
  mkdirSync(join(root, "brain"));
  writeFileSync(join(root, "brain/odysseus.md"), "Odysseus counts the oars.\n");
  return { brain: join(root, "brain"), cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

async function collect(stream: NodeJS.ReadableStream): Promise<string> {
  let output = "";
  for await (const chunk of stream as AsyncIterable<Buffer>) output += chunk.toString();
  return output;
}

/** Runs `command` in a real worker under `spec` (rlimits only, no cgroup) and returns what it printed. */
async function run(spec: string, command: string[], plan?: WorkerLimitsPlan) {
  const f = brain();
  try {
    const limits = plan ?? workerLimitsPlan({ spec, cgroup: NO_CGROUP });
    const worker = launchAgentWorker({ brainPath: f.brain, command, env: { PATH: "/usr/bin:/bin" }, limits });
    worker.stdin.end();
    const [code, stdout, stderr] = await Promise.all([worker.exited, collect(worker.stdout), collect(worker.stderr)]);
    return { code, stdout, stderr, report: worker.limitReport() };
  } finally { f.cleanup(); }
}

describe("configuration", () => {
  test("defaults are generous and scale with the host", () => {
    const limits = defaultWorkerLimits({ totalMemory: 32 * GIB, cpus: 8 });
    expect(limits).toEqual({ processes: 4096, data: 16 * GIB, file_size: 16 * GIB, open_files: 65536,
      memory: 16 * GIB, pids: 4096, cpu: 7, cgroup: true });
    // A small host keeps a usable floor, and the server keeps a quarter.
    expect(defaultWorkerLimits({ totalMemory: GIB, cpus: 1 })).toMatchObject({ data: 768 * MIB, memory: 768 * MIB, cpu: 1 });
    expect(defaultWorkerLimits({ totalMemory: 4 * GIB, cpus: 2 })).toMatchObject({ data: 2 * GIB, memory: 2 * GIB, cpu: 1 });
  });

  test("the memory a cgroup above the server caps, not physical memory, sizes the defaults", () => {
    const mount = mkdtempSync(join(ROOT, "tmp/worker-limits-ceiling-"));
    try {
      mkdirSync(join(mount, "system.slice/brain.service"), { recursive: true });
      writeFileSync(join(mount, "system.slice/memory.max"), "max\n");
      writeFileSync(join(mount, "system.slice/brain.service/memory.max"), `${2 * GIB}\n`);
      expect(cgroupMemoryCeiling("0::/system.slice/brain.service\n", mount)).toBe(2 * GIB);
      expect(cgroupMemoryCeiling("0::/system.slice\n", mount)).toBeUndefined();
      expect(cgroupMemoryCeiling("", mount)).toBeUndefined();
    } finally { rmSync(mount, { recursive: true, force: true }); }
  });

  test("the host overrides single limits, turns one off, or skips the cgroup", () => {
    const base = defaultWorkerLimits({ totalMemory: 8 * GIB, cpus: 4 });
    expect(parseWorkerLimits("memory=2GiB, pids=512 ,cpu=1.5,file_size=100MiB,data=unlimited,cgroup=off", base))
      .toEqual({ ...base, memory: 2 * GIB, pids: 512, cpu: 1.5, file_size: 100 * MIB, data: null, cgroup: false });
    expect(parseWorkerLimits(undefined, base)).toEqual(base);
  });

  test.each([
    ["memory=lots", /memory=lots is not a size/], ["processes=2GiB", /not a whole number/], ["oars=12", /unknown limit "oars"/],
    ["cgroup=maybe", /cgroup=maybe must be on or off/], ["cpu=-1", /not a CPU count/], ["pids=0", /out of range/],
  ])("a malformed entry (%s) throws instead of being dropped", (spec, message) => {
    expect(() => parseWorkerLimits(spec)).toThrow(message);
  });

  test("a malformed host configuration refuses the launch, naming the entry", () => {
    const f = brain();
    const previous = process.env.BRAIN_UI_WORKER_LIMITS;
    process.env.BRAIN_UI_WORKER_LIMITS = "memory=lots";
    try {
      expect(() => workerCommand({ brainPath: f.brain, command: ["/bin/true"], env: {} }))
        .toThrow(new WorkerHostError("BRAIN_UI_WORKER_LIMITS is malformed: memory=lots is not a size such as 8GiB"));
      expect(workerLimitsStatus().enforced).toEqual([]);
    } finally {
      if (previous === undefined) delete process.env.BRAIN_UI_WORKER_LIMITS; else process.env.BRAIN_UI_WORKER_LIMITS = previous;
      f.cleanup();
    }
  });

  test("rlimits are lowered to the server's own hard limits, which nothing unprivileged can raise", () => {
    const limits = parseWorkerLimits("open_files=65536,processes=4096", defaultWorkerLimits({ totalMemory: 8 * GIB, cpus: 4 }));
    expect(effectiveRlimits(limits, { open_files: 1024, processes: null, data: null, file_size: null }))
      .toEqual([{ limit: "processes", value: 4096 }, { limit: "data", value: 4 * GIB }, { limit: "file_size", value: 16 * GIB }, { limit: "open_files", value: 1024 }]);
    expect(prlimitArgs([{ limit: "processes", value: 64 }])).toEqual(["--nproc=64:64"]);
  });

  test("a host without prlimit refuses the launch rather than running unlimited", () => {
    const f = brain();
    try {
      const limits = workerLimitsPlan({ spec: "", prlimit: null, cgroup: NO_CGROUP });
      expect(() => workerCommand({ brainPath: f.brain, command: ["/bin/true"], env: {}, limits }))
        .toThrow(new WorkerHostError(PRLIMIT_REQUIREMENT));
    } finally { f.cleanup(); }
  });

  test("argv: prlimit is the first program inside the namespaces, before the worker command", () => {
    const f = brain();
    try {
      const limits = workerLimitsPlan({ spec: "processes=64,data=1GiB,file_size=1MiB,open_files=256", prlimit: "/usr/bin/prlimit",
        hard: {}, cgroup: NO_CGROUP });
      const argv = workerCommand({ brainPath: f.brain, command: ["/bin/true", "odysseus"], env: {}, limits });
      expect(argv.slice(argv.lastIndexOf("--") - 5)).toEqual(["/usr/bin/prlimit", "--nproc=64:64", `--data=${GIB}:${GIB}`,
        `--fsize=${MIB}:${MIB}`, "--nofile=256:256", "--", "/bin/true", "odysseus"]);
      const bwrap = Bun.which("bwrap")!;
      const prefix = statfsSync(f.brain).type === 0x9123683e
        ? [realpathSync(Bun.which("python3")!), "-I", "-S", "-c", WORKER_FILESYSTEM_FILTER_PROGRAM, bwrap]
        : [bwrap];
      expect(argv.slice(0, prefix.length), "LIMITS_TRUSTED_FILESYSTEM_PREFIX").toEqual(prefix);
    } finally { f.cleanup(); }
  });
});

describe("status and the agent's note", () => {
  test("a host without delegation reports the rlimits enforced and each cgroup limit absent, with why", () => {
    // The real hierarchy, seen by a pid that is not alone in its cgroup.
    const env = { ...hostCgroupEnvironment(), pid: 2 ** 30 };
    const cgroup = establishWorkerCgroups(env);
    expect(cgroup.available).toBe(false);
    const status = workerLimitsStatus({ spec: "", host: { totalMemory: 8 * GIB, cpus: 4 }, hard: {}, prlimit: "/usr/bin/prlimit", cgroup, uid: 1000 });
    expect(status.enforced).toEqual([
      { limit: "processes", source: "rlimit", value: 4096 }, { limit: "data", source: "rlimit", value: 4 * GIB },
      { limit: "file_size", source: "rlimit", value: 16 * GIB }, { limit: "open_files", source: "rlimit", value: 65536 }]);
    expect(status.absent.map(entry => entry.limit)).toEqual(["memory", "pids", "cpu"]);
    for (const entry of status.absent) expect(entry.reason).toBe((cgroup as { reason: string }).reason);
  });

  test("a hierarchy that is not cgroup v2, and a server outside one, say so", () => {
    const dir = mkdtempSync(join(ROOT, "tmp/worker-limits-cg-"));
    try {
      expect(establishWorkerCgroups({ mount: dir, selfCgroup: "0::/odysseus", mountInfo: "", pid: process.pid }))
        .toEqual({ available: false, reason: `${dir} is not a cgroup v2 filesystem` });
      expect(establishWorkerCgroups({ mount: dir, selfCgroup: "", mountInfo: "", pid: process.pid }))
        .toEqual({ available: false, reason: "the server is not in a cgroup v2 hierarchy" });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("a cgroup2 mount without nsdelegate is not used: a worker could raise its own limits", () => {
    const real = hostCgroupEnvironment();
    // Needs a cgroup v2 host; the reason on any other host is covered above.
    if (!real.selfCgroup.includes("0::") || statfsSync(real.mount).type !== 0x63677270) return;
    const withoutNsdelegate = real.mountInfo.split("\n")
      .map(line => line.includes(" - cgroup2 ") ? line.replace(/,?nsdelegate/, "") : line).join("\n");
    expect(establishWorkerCgroups({ ...real, mountInfo: withoutNsdelegate, pid: 2 ** 30 }))
      .toEqual({ available: false, reason: "the cgroup2 filesystem is mounted without nsdelegate, so a worker could raise its own limits" });
  });

  test("a root-run server's workers report the process limit absent: the kernel exempts uid 0", () => {
    const status = workerLimitsStatus({ spec: "", host: { totalMemory: 8 * GIB, cpus: 4 }, hard: {}, prlimit: "/usr/bin/prlimit",
      cgroup: NO_CGROUP, uid: 0 });
    expect(status.enforced.map(entry => entry.limit)).toEqual(["data", "file_size", "open_files"]);
    expect(status.absent[0]).toEqual({ limit: "processes", source: "rlimit", reason: ROOT_NPROC_REASON });
  });

  test("the note states each enforced limit, how hitting it looks, and what this host does not enforce", () => {
    const status = workerLimitsStatus({ spec: "", host: { totalMemory: 8 * GIB, cpus: 4 }, hard: {},
      prlimit: "/usr/bin/prlimit", cgroup: NO_CGROUP, uid: 1000 });
    const smaller = "do the work in smaller pieces instead of retrying the same command.";
    expect(workerNoteLimits(status)).toEqual([
      { name: "Processes and threads", value: "4096", onHit: `A step that hits it fails with \`fork: Resource temporarily unavailable\`: ${smaller}` },
      { name: "Memory per process", value: "4 GiB", onHit: `A step that hits it fails with \`Out of memory\` or \`Cannot allocate memory\`: ${smaller}` },
      { name: "Size of one file", value: "16 GiB", onHit: `A step that hits it fails with \`File too large\` or \`File size limit exceeded\`: ${smaller}` },
      { name: "Open files per process", value: "65536", onHit: `A step that hits it fails with \`Too many open files\`: ${smaller}` },
      ...["Memory for the whole worker", "Processes for the whole worker", "CPU"]
        .map(name => ({ name, value: "not enforced on this host", onHit: "This host cannot apply it." })),
    ]);
    // A limit the operator turned off is not news to the agent.
    expect(workerNoteLimits(workerLimitsStatus({ spec: "cgroup=off", hard: {}, prlimit: "/usr/bin/prlimit", uid: 1000 }))
      .map(entry => entry.value)).not.toContain("not enforced on this host");
    // It lands in the sandbox note's limits list, after the areas.
    const note = workerSandboxNote({ brain: "/srv/ithaca", restricted: true, areas: [], scratchAliasesRemoved: [] },
      { limits: workerNoteLimits(status) });
    expect(note).toContain("Limits in this turn:\n- **Processes and threads: 4096.** A step that hits it fails with");
  });
});

describe("real workers under their limits", () => {
  test("a fixture that forks without bound is stopped at RLIMIT_NPROC and the host stays responsive", async () => {
    // Forks until the kernel refuses, up to 2000 sleepers: far past the limit
    // of 64, and still harmless to the host if the limit were missing.
    const program = `import {readdirSync} from "node:fs";
      const sleepers=[]; let refused="";
      for(let i=0;i<2000;i++){ try{ sleepers.push(Bun.spawn(["/usr/bin/sleep","20"],{stdio:["ignore","ignore","ignore"]})); }
        catch(e){ refused=e.code??String(e); break; } }
      const started=sleepers.length, tasks=readdirSync("/proc").filter(n=>/^\\d+$/.test(n)).length;
      for(const s of sleepers) s.kill("SIGKILL");
      await Promise.all(sleepers.map(s=>s.exited));
      // The worker tries to lift its own limit once there is room to run prlimit.
      const raise=Bun.spawnSync(["/usr/bin/prlimit","--pid",String(process.pid),"--nproc=100000:100000"]);
      console.log(JSON.stringify({started,refused,tasks,raised:raise.exitCode===0}));
      process.exit(0);`;
    const started = performance.now();
    const pending = run("processes=64", [process.execPath, "-e", program]);
    // While the worker forks, the host still starts processes at once.
    const probe = Bun.spawnSync(["/bin/true"], { timeout: 2_000 });
    expect(probe.exitCode).toBe(0);
    const { code, stdout } = await pending;
    expect(code).toBe(0);
    const result = JSON.parse(stdout) as { started: number; refused: string; tasks: number; raised: boolean };
    expect(result.refused).toBe("EAGAIN");
    expect(result.started).toBeLessThan(64);
    expect(result.tasks).toBeLessThanOrEqual(64);
    expect(result.raised).toBe(false);
    // The PID namespace ends with the worker: no sleeper outlives it.
    expect(performance.now() - started).toBeLessThan(10_000);
  }, 15_000);

  test("an allocation past the per-process memory limit fails inside the worker only", async () => {
    const program = `const held=[];try{for(let i=0;i<64;i++)held.push(Buffer.alloc(64*1024*1024,1));console.log("allocated",held.length)}
      catch(e){console.log("refused-after-mib",held.length*64)}`;
    const { code, stdout } = await run("data=512MiB", [process.execPath, "-e", program]);
    expect(code).toBe(0);
    const refused = Number(/refused-after-mib (\d+)/.exec(stdout)?.[1]);
    expect(refused).toBeGreaterThan(0);
    expect(refused).toBeLessThan(512);
    // This process kept running and can still allocate.
    expect(Buffer.alloc(64 * MIB).length).toBe(64 * MIB);
  }, 15_000);

  test("a write past the file size limit terminates the writer with SIGXFSZ inside the worker", async () => {
    const { code, stdout, stderr, report } = await run("file_size=1MiB", ["/bin/sh", "-c",
      "/usr/bin/dd if=/dev/zero of=/tmp/raft bs=1M count=4; echo \"dd=$? size=$(stat -c %s /tmp/raft)\""]);
    expect(code).toBe(0);
    // Noninteractive shells need not print a signal diagnostic. The status
    // is 128 + SIGXFSZ (25), rather than dd's EFBIG exit 1.
    expect(stdout).toContain(`dd=153 size=${MIB}`);
    expect(stderr).not.toContain("File too large");
    expect(report).toEqual({ hits: [], fatal: false });
  }, 15_000);

  test("the worker sees exactly the planned limits as hard limits and cannot leave its cgroup", async () => {
    const { stdout } = await run("processes=300,data=2GiB,file_size=8GiB,open_files=512", ["/bin/sh", "-c",
      `grep -E '^Max (processes|data size|file size|open files)' /proc/self/limits;
       cg=/sys/fs/cgroup$(cut -d: -f3 /proc/self/cgroup); echo $$ > "$cg/cgroup.procs" 2>/dev/null && echo moved || echo stayed`]);
    const row = (name: string) => stdout.split("\n").find(line => line.startsWith(name))!.slice(name.length).trim().split(/\s+/).slice(0, 2);
    expect(row("Max processes")).toEqual(["300", "300"]);
    expect(row("Max data size")).toEqual([String(2 * GIB), String(2 * GIB)]);
    expect(row("Max file size")).toEqual([String(8 * GIB), String(8 * GIB)]);
    expect(row("Max open files")).toEqual(["512", "512"]);
    expect(stdout).toContain("stayed");
  }, 15_000);
});

/**
 * The cgroup half needs a delegated cgroup v2 subtree. A systemd user manager
 * provides one (`systemd-run --user --scope -p Delegate=yes`); CI runners
 * have none, and there the status test above is the proof.
 */
function delegatedScope(): string | undefined {
  const systemdRun = Bun.which("systemd-run");
  if (!systemdRun) return undefined;
  const check = Bun.spawnSync([systemdRun, "--user", "--scope", "-p", "Delegate=yes", "--quiet", "/bin/true"], { stdout: "ignore", stderr: "ignore", timeout: 5_000 });
  return check.exitCode === 0 ? systemdRun : undefined;
}
const systemdRun = delegatedScope();
if (!systemdRun) console.log("worker cgroup proof skipped: no systemd user manager to delegate a cgroup v2 subtree");

describe.skipIf(!systemdRun)("real workers under their delegated cgroup", () => {
  test("pids.max stops a fork bomb and memory.max OOM-kills inside the worker only; both are reported and cleaned up", () => {
    mkdirSync(join(ROOT, "tmp"), { recursive: true });
    const run = Bun.spawnSync([systemdRun!, "--user", "--scope", "-p", "Delegate=yes", "--quiet", process.execPath,
      join(import.meta.dir, "fixtures/worker-cgroup-probe.ts"), join(ROOT, "tmp")], { stdout: "pipe", stderr: "pipe", timeout: 60_000 });
    expect(run.stderr.toString()).toBe("");
    expect(run.exitCode).toBe(0);
    const result = JSON.parse(run.stdout.toString().trim().split("\n").at(-1)!);
    // The server moved itself into its leaf; each worker had its own cgroup, now removed.
    expect(result.server).toEndWith("/brain-server");
    expect(result.pids.enforced).toEqual(expect.arrayContaining(["memory", "pids"]));
    expect(JSON.parse(result.pids.stdout)).toEqual({ started: expect.any(Number), refused: "EAGAIN" });
    expect(JSON.parse(result.pids.stdout).started).toBeLessThan(48);
    expect(result.pids.report).toMatchObject({ fatal: false, hits: [{ limit: "pids", source: "cgroup", value: 48 }] });
    expect(result.pids.report.hits[0].events).toBeGreaterThan(0);
    expect(result.pids.report.peak.tasks).toBeLessThanOrEqual(48);
    expect(result.pids.leftover).toEqual([]);
    // The allocating worker was killed; the server after it kept running.
    expect(result.memory.code).toBe(137);
    expect(result.memory.stdout).toBe("");
    expect(result.memory.report).toMatchObject({ fatal: true, hits: [{ limit: "memory", source: "cgroup", value: 192 * MIB }] });
    expect(result.memory.report.peak.memoryBytes).toBeLessThanOrEqual(192 * MIB);
    expect(result.memory.leftover).toEqual([]);
    // CPU throttling is a hit too, though never a fatal one.
    expect(result.cpu.code).toBe(0);
    expect(result.cpu.report).toMatchObject({ fatal: false, hits: [{ limit: "cpu", source: "cgroup", value: 0.1 }] });
    expect(result.cpu.report.hits[0].events).toBeGreaterThan(0);
    // A worker's own fresh cgroup2 mount shows its cgroup as the namespace
    // root, and nsdelegate keeps that root's limits out of its reach.
    expect(result.escape.stdout).toContain("mounted");
    expect(result.escape.stdout).toContain("memory-refused");
    expect(result.escape.stdout).toContain("pids-refused");
    expect(result.escape.stdout).toContain(`memory.max=${300 * MIB} pids.max=300`);
    expect(result.escape.stdout).toMatch(/brain-workers\/w-\d+-/);
    // Nor can it leave child cgroups behind: it gets none, and cannot raise that.
    expect(result.escape.stdout).toContain("descendants-refused");
    expect(result.escape.stdout).toContain("child-refused");
    expect(result.escape.leftover).toEqual([]);
    // An OOM kill the worker survived is a hit, but its own later exit 137 is not the limit's doing.
    expect(result.survived.code).toBe(137);
    expect(result.survived.stdout).toBe("child=137");
    expect(result.survived.report).toMatchObject({ fatal: false, hits: [{ limit: "memory", source: "cgroup" }] });
    expect(result.alive).toBe(true);
  }, 90_000);
});
