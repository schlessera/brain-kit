/**
 * Resource limits for every agent worker (#1660, G1 in
 * docs/decisions/governed-writable-workers.md, "Resource limits (G1)").
 *
 * Two layers, both applied before any agent code runs:
 *
 * - **rlimits**, which need no privilege. `prlimit` sets them as the first
 *   program inside the worker's user namespace, then execs the worker command.
 *   Inside the namespace matters for `RLIMIT_NPROC`: the kernel counts it per
 *   user and namespace, so set outside it would count every process of the
 *   server's uid and refuse the namespace itself. Set inside, it counts only
 *   the worker's own tasks. No process inside can raise a hard limit: that
 *   needs `CAP_SYS_RESOURCE` in the initial namespace.
 * - **a cgroup v2 child per worker** (`memory.max`, `pids.max`, `cpu.max`),
 *   only when the server runs alone in a delegated cgroup
 *   (`worker-cgroup.ts`). Otherwise the status and the agent's note say which
 *   limits are absent.
 *
 * The per-process memory bound is `RLIMIT_DATA`, not `RLIMIT_AS`. Chromium
 * reserves over a terabyte of address space at start: under `RLIMIT_AS` it
 * crashed at 8, 16 and 32 GiB and hung at 64 GiB, and started only from
 * 1 TiB, where the limit bounds nothing. `RLIMIT_DATA` counts private
 * writable memory, not reservations; Chromium, Bun and Claude Code started
 * under 1 GiB and an allocation past it failed inside the process
 * (measured 2026-10-12, docs/hosting/agent-workers.md#resource-limits).
 */
import { availableParallelism, totalmem } from "node:os";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { workerLimitsSpec } from "../config/env.js";
import { workerCgroupHost, type WorkerCgroupHost } from "./worker-cgroup.js";
import type { WorkerNoteLimit } from "./worker-sandbox.js";

import type { WorkerLimitName, WorkerLimitSource, WorkerLimitsStatus } from "../protocol.js";

export type { WorkerLimitName, WorkerLimitSource, WorkerLimitsStatus };

/** Resolved worker limits. `null` means the host turned the limit off. */
export interface WorkerResourceLimits {
  /** `RLIMIT_NPROC` inside the worker's user namespace: its tasks, threads included. */
  processes: number | null;
  /** `RLIMIT_DATA`, bytes, per process. */
  data: number | null;
  /** `RLIMIT_FSIZE`, bytes, per file. */
  file_size: number | null;
  /** `RLIMIT_NOFILE`, per process. */
  open_files: number | null;
  /** cgroup `memory.max`, bytes, for the whole worker. */
  memory: number | null;
  /** cgroup `pids.max` for the whole worker. */
  pids: number | null;
  /** cgroup `cpu.max`, in CPUs, for the whole worker. */
  cpu: number | null;
  /** `false` when the host disabled the per-worker cgroup. */
  cgroup: boolean;
}

export const WORKER_LIMIT_SOURCES: Readonly<Record<WorkerLimitName, WorkerLimitSource>> = Object.freeze({
  processes: "rlimit", data: "rlimit", file_size: "rlimit", open_files: "rlimit",
  memory: "cgroup", pids: "cgroup", cpu: "cgroup",
});

/** The host configuration variable; see {@link parseWorkerLimits}. */
export const WORKER_LIMITS_ENV = "BRAIN_UI_WORKER_LIMITS";

const GIB = 1024 ** 3;

export interface WorkerLimitHost {
  /**
   * The memory the server and its workers share: physical memory, or less
   * when a cgroup above the server caps it (a `MemoryMax=` unit, a container
   * started with `--memory`).
   */
  totalMemory: number;
  /** CPUs this process may use. */
  cpus: number;
}

const readOrEmpty = (path: string) => { try { return readFileSync(path, "utf8"); } catch { return ""; } };

/** The lowest `memory.max` on this process's cgroup path, when one caps it. */
export function cgroupMemoryCeiling(selfCgroup = readOrEmpty("/proc/self/cgroup"), mount = "/sys/fs/cgroup"): number | undefined {
  const relative = selfCgroup.split("\n").find(entry => entry.startsWith("0::"))?.slice(3).trim();
  if (relative === undefined) return undefined;
  let ceiling: number | undefined;
  const parts = relative.split("/").filter(Boolean);
  for (let depth = parts.length; depth >= 0; depth--) {
    const value = readOrEmpty(join(mount, ...parts.slice(0, depth), "memory.max")).trim();
    if (/^\d+$/.test(value)) ceiling = Math.min(ceiling ?? Infinity, Number(value));
  }
  return ceiling;
}

export function currentLimitHost(): WorkerLimitHost {
  return { totalMemory: Math.min(totalmem(), cgroupMemoryCeiling() ?? Infinity), cpus: availableParallelism() };
}

/**
 * Defaults. Each is far above what a normal turn uses (the measured peaks are
 * in docs/hosting/agent-workers.md#resource-limits) and low enough that one
 * runaway worker leaves the host responsive: half the memory the server
 * shares with its workers, all CPUs but one, a few thousand tasks. On a small
 * host the memory limits keep at least 1 GiB, but never more than three
 * quarters of that memory, so the server keeps headroom.
 */
export function defaultWorkerLimits(host: WorkerLimitHost = currentLimitHost()): WorkerResourceLimits {
  const memory = Math.max(Math.floor(host.totalMemory / 2), Math.min(GIB, Math.floor(host.totalMemory * 0.75)));
  return {
    processes: 4096,
    data: memory,
    file_size: 16 * GIB,
    open_files: 65536,
    memory,
    pids: 4096,
    cpu: Math.max(1, host.cpus - 1),
    cgroup: true,
  };
}

const UNITS: Record<string, number> = { "": 1, k: 1024, kib: 1024, m: 1024 ** 2, mib: 1024 ** 2, g: GIB, gib: GIB, t: 1024 ** 4, tib: 1024 ** 4 };
const BYTE_LIMITS = new Set<WorkerLimitName>(["data", "file_size", "memory"]);

function parseValue(name: WorkerLimitName, raw: string): number | null {
  if (raw === "unlimited" || raw === "off") return null;
  if (name === "cpu") {
    const cpus = Number(raw);
    if (!/^\d+(\.\d+)?$/.test(raw) || !(cpus >= 0.01)) throw new Error(`${name}=${raw} is not a CPU count`);
    return cpus;
  }
  const match = /^(\d+)\s*([a-z]*)$/i.exec(raw);
  const unit = match?.[2]?.toLowerCase() ?? "";
  if (!match || !(unit in UNITS) || (!BYTE_LIMITS.has(name) && unit !== "")) {
    throw new Error(`${name}=${raw} is not ${BYTE_LIMITS.has(name) ? "a size such as 8GiB" : "a whole number"}`);
  }
  const value = Number(match[1]) * UNITS[unit]!;
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name}=${raw} is out of range`);
  return value;
}

/**
 * The host's override, `BRAIN_UI_WORKER_LIMITS`: comma-separated
 * `name=value` pairs over the defaults, for example
 * `memory=8GiB,pids=2048,cpu=2`. Sizes take `KiB`, `MiB`, `GiB` or `TiB`;
 * `unlimited` turns one limit off; `cgroup=off` skips the per-worker cgroup.
 * A malformed entry throws: a limit the operator asked for is never dropped
 * silently.
 */
export function parseWorkerLimits(spec: string | undefined, defaults: WorkerResourceLimits = defaultWorkerLimits()): WorkerResourceLimits {
  const limits = { ...defaults };
  for (const entry of (spec ?? "").split(",").map(part => part.trim()).filter(Boolean)) {
    const eq = entry.indexOf("=");
    const key = (eq < 0 ? entry : entry.slice(0, eq)).trim();
    const raw = eq < 0 ? "" : entry.slice(eq + 1).trim();
    if (key === "cgroup") {
      if (raw !== "on" && raw !== "off") throw new Error(`cgroup=${raw} must be on or off`);
      limits.cgroup = raw === "on";
    } else if (key in WORKER_LIMIT_SOURCES) {
      limits[key as WorkerLimitName] = parseValue(key as WorkerLimitName, raw);
    } else {
      throw new Error(`unknown limit "${key}"`);
    }
  }
  return limits;
}

const RLIMIT_ROWS: Record<"processes" | "data" | "file_size" | "open_files", string> = {
  processes: "Max processes", data: "Max data size", file_size: "Max file size", open_files: "Max open files",
};
const PRLIMIT_FLAGS: Record<keyof typeof RLIMIT_ROWS, string> = {
  processes: "--nproc", data: "--data", file_size: "--fsize", open_files: "--nofile",
};

/** This process's hard rlimits, by limit name; `null` for unlimited. */
export function hardRlimits(limitsFile = "/proc/self/limits"): Partial<Record<keyof typeof RLIMIT_ROWS, number | null>> {
  const out: Partial<Record<keyof typeof RLIMIT_ROWS, number | null>> = {};
  let text: string;
  try { text = readFileSync(limitsFile, "utf8"); } catch { return out; }
  for (const [name, row] of Object.entries(RLIMIT_ROWS) as Array<[keyof typeof RLIMIT_ROWS, string]>) {
    const line = text.split("\n").find(l => l.startsWith(row));
    const hard = line?.slice(row.length).trim().split(/\s+/)[1];
    if (hard) out[name] = hard === "unlimited" ? null : Number(hard);
  }
  return out;
}

/**
 * The rlimits a worker actually gets: the configured value, lowered to this
 * process's hard limit where that is lower (an unprivileged process cannot
 * raise it, and `prlimit` would refuse the launch).
 */
export function effectiveRlimits(limits: WorkerResourceLimits, hard = hardRlimits()): Array<{ limit: keyof typeof RLIMIT_ROWS; value: number }> {
  const out: Array<{ limit: keyof typeof RLIMIT_ROWS; value: number }> = [];
  for (const limit of Object.keys(RLIMIT_ROWS) as Array<keyof typeof RLIMIT_ROWS>) {
    const wanted = limits[limit];
    if (wanted === null) continue;
    const ceiling = hard[limit];
    out.push({ limit, value: ceiling === undefined || ceiling === null ? wanted : Math.min(wanted, ceiling) });
  }
  return out;
}

/** The `prlimit` arguments that set each effective rlimit, soft and hard. */
export function prlimitArgs(rlimits: ReadonlyArray<{ limit: keyof typeof RLIMIT_ROWS; value: number }>): string[] {
  return rlimits.map(({ limit, value }) => `${PRLIMIT_FLAGS[limit]}=${value}:${value}`);
}

/** One limit a worker hit, as the activity event and the governance record carry it. */
export interface WorkerLimitHit {
  limit: Exclude<WorkerLimitName, "open_files">;
  source: WorkerLimitSource;
  /** The configured limit. */
  value: number;
  /** How many times the kernel recorded the hit; `null` when it does not count them. */
  events: number | null;
}

/** What a finished (or still running) worker's limits recorded. */
export interface WorkerLimitReport {
  hits: WorkerLimitHit[];
  /** The worker itself was ended by a limit, not just one of its steps. */
  fatal: boolean;
  /** With a cgroup, once the worker has exited: its peak memory and task count. */
  peak?: { memoryBytes?: number; tasks?: number };
}

/** Several workers' reports as one: each limit once, its events summed. */
export function mergeLimitReports(reports: readonly WorkerLimitReport[]): WorkerLimitReport {
  const byLimit = new Map<string, WorkerLimitHit>();
  for (const hit of reports.flatMap(report => report.hits)) {
    const key = `${hit.source}:${hit.limit}`;
    const seen = byLimit.get(key);
    byLimit.set(key, seen ? { ...seen, events: seen.events === null || hit.events === null ? null : seen.events + hit.events } : { ...hit });
  }
  return { hits: [...byLimit.values()], fatal: reports.some(report => report.fatal) };
}

/**
 * Turns successive reports into what is new since the last call, so a
 * backend can report each hit once, next to the step that caused it.
 */
export function createLimitTracker() {
  const seen = new Map<string, number>();
  return (report: WorkerLimitReport): WorkerLimitHit[] => report.hits.flatMap(hit => {
    const key = `${hit.source}:${hit.limit}`;
    const total = hit.events ?? 1, before = seen.get(key) ?? 0;
    if (total <= before) return [];
    seen.set(key, total);
    return [{ ...hit, events: hit.events === null ? null : total - before }];
  });
}

/** The failure message a turn ends with when a limit ended its worker. */
export function limitFailureMessage(hits: readonly WorkerLimitHit[]): string {
  return `The agent worker was stopped by this server's ${describeLimitHits(hits)}. `
    + "The host sets these limits (docs/hosting/agent-workers.md#resource-limits).";
}

/** A human sentence naming each limit, for a log line or a failure message. */
export function describeLimitHits(hits: readonly WorkerLimitHit[]): string {
  return hits.map(hit => `${LIMIT_LABEL[hit.limit]} (${formatLimit(hit.limit, hit.value)}, ${hit.source})`).join(", ");
}

const LIMIT_LABEL: Record<WorkerLimitName, string> = {
  processes: "process limit", data: "per-process memory limit", file_size: "file size limit", open_files: "open file limit",
  memory: "memory limit", pids: "process count limit", cpu: "CPU limit",
};

export function formatLimit(limit: WorkerLimitName, value: number): string {
  if (BYTE_LIMITS.has(limit)) {
    for (const [unit, size] of [["TiB", 1024 ** 4], ["GiB", GIB], ["MiB", 1024 ** 2], ["KiB", 1024]] as const) {
      if (value >= size) return `${Number((value / size).toFixed(1))} ${unit}`;
    }
    return `${value} bytes`;
  }
  if (limit === "cpu") return `${value} CPU${value === 1 ? "" : "s"}`;
  return String(value);
}

type RlimitName = keyof typeof RLIMIT_ROWS;

/** Everything a launch and the status need, resolved once from the same inputs. */
export interface WorkerLimitsPlan {
  limits: WorkerResourceLimits;
  /** The rlimits each worker gets, lowered to the server's own hard limits. */
  rlimits: Array<{ limit: RlimitName; value: number }>;
  /** The trusted `prlimit` binary, or null when the host has none. */
  prlimit: string | null;
  cgroup: WorkerCgroupHost;
  status: WorkerLimitsStatus;
}

/** Fixed system locations only: the binary must also be visible inside the restricted envelope. */
const PRLIMIT_PATHS = ["/usr/bin/prlimit", "/bin/prlimit", "/usr/sbin/prlimit", "/sbin/prlimit"];

export function findPrlimit(candidates: readonly string[] = PRLIMIT_PATHS): string | null {
  for (const path of candidates) {
    try { if (statSync(path).isFile()) return path; } catch { /* next */ }
  }
  return null;
}

export const PRLIMIT_REQUIREMENT = "prlimit (util-linux) is missing; it sets each worker's resource limits";

export interface WorkerLimitsPlanOptions {
  /** The configuration; default: `BRAIN_UI_WORKER_LIMITS`. */
  spec?: string | undefined;
  host?: WorkerLimitHost;
  prlimit?: string | null;
  hard?: ReturnType<typeof hardRlimits>;
  cgroup?: WorkerCgroupHost;
  /** The server's real uid; workers run as it. */
  uid?: number | undefined;
}

export const ROOT_NPROC_REASON = "the kernel does not apply RLIMIT_NPROC to uid 0, so a root-run server's workers are bounded only by a cgroup pids.max";

/**
 * Resolves the host's limits (`BRAIN_UI_WORKER_LIMITS` over the defaults),
 * the rlimits a worker gets, and the cgroup host. Throws on a malformed
 * configuration; the launcher turns that into a named host requirement.
 */
export function workerLimitsPlan(options: WorkerLimitsPlanOptions = {}): WorkerLimitsPlan {
  const limits = parseWorkerLimits("spec" in options ? options.spec : workerLimitsSpec(), defaultWorkerLimits(options.host));
  const rlimits = effectiveRlimits(limits, options.hard);
  const prlimit = "prlimit" in options ? options.prlimit ?? null : findPrlimit();
  const cgroup = options.cgroup ?? workerCgroupHost(limits);
  const uid = "uid" in options ? options.uid : process.getuid?.();
  const status: WorkerLimitsStatus = { enforced: [], absent: [] };
  for (const limit of Object.keys(RLIMIT_ROWS) as RlimitName[]) {
    const applied = rlimits.find(entry => entry.limit === limit);
    if (!applied) status.absent.push({ limit, source: "rlimit", reason: "turned off by the host (unlimited)" });
    else if (!prlimit) status.absent.push({ limit, source: "rlimit", reason: PRLIMIT_REQUIREMENT });
    // The kernel exempts real uid 0 from RLIMIT_NPROC, capabilities or not.
    else if (limit === "processes" && uid === 0) status.absent.push({ limit, source: "rlimit", reason: ROOT_NPROC_REASON });
    else status.enforced.push({ limit, source: "rlimit", value: applied.value });
  }
  for (const limit of ["memory", "pids", "cpu"] as const) {
    const value = limits[limit];
    if (value === null) status.absent.push({ limit, source: "cgroup", reason: "turned off by the host (unlimited)" });
    else if (!cgroup.available) status.absent.push({ limit, source: "cgroup", reason: cgroup.reason });
    else if (!cgroup.controllers.includes(limit)) {
      status.absent.push({ limit, source: "cgroup", reason: `the ${limit} controller is not delegated to the server's cgroup` });
    } else status.enforced.push({ limit, source: "cgroup", value });
  }
  return { limits, rlimits, prlimit, cgroup, status };
}

/** The status, also for a malformed configuration: then nothing is enforced, and each limit says why. */
export function workerLimitsStatus(options: WorkerLimitsPlanOptions = {}): WorkerLimitsStatus {
  try { return workerLimitsPlan(options).status; } catch (error) {
    const reason = `${WORKER_LIMITS_ENV} is malformed: ${error instanceof Error ? error.message : String(error)}`;
    return { enforced: [], absent: (Object.keys(WORKER_LIMIT_SOURCES) as WorkerLimitName[])
      .map(limit => ({ limit, source: WORKER_LIMIT_SOURCES[limit], reason })) };
  }
}

const NOTE_LABEL: Record<WorkerLimitName, string> = {
  processes: "processes and threads", data: "memory per process", file_size: "size of one file",
  open_files: "open files per process", memory: "memory for the whole worker", pids: "processes for the whole worker",
  cpu: "CPU",
};
const NOTE_SYMPTOM: Partial<Record<WorkerLimitName, string>> = {
  processes: "`fork: Resource temporarily unavailable`",
  pids: "`fork: Resource temporarily unavailable`",
  data: "`Out of memory` or `Cannot allocate memory`",
  memory: "the largest process being killed (`Killed`, exit 137)",
  file_size: "`File too large` or `File size limit exceeded`",
  open_files: "`Too many open files`",
};


/**
 * The limits this worker runs under, for the "Limits in this turn" list of
 * the sandbox note (#1654's `WorkerNoteFacts`): each enforced limit with its
 * value and how hitting it looks, and each limit this host cannot enforce.
 * Rendered from the same plan the launcher applies.
 */
export function workerNoteLimits(status: WorkerLimitsStatus): WorkerNoteLimit[] {
  const label = (limit: WorkerLimitName) => NOTE_LABEL[limit].charAt(0).toUpperCase() + NOTE_LABEL[limit].slice(1);
  const enforced = status.enforced.map(({ limit, value }): WorkerNoteLimit => {
    const symptom = NOTE_SYMPTOM[limit];
    return { name: label(limit), value: formatLimit(limit, value), onHit: symptom
      ? `A step that hits it fails with ${symptom}: do the work in smaller pieces instead of retrying the same command.`
      : "Work past it is slowed, not refused." };
  });
  const absent = status.absent.filter(entry => !entry.reason.startsWith("turned off"))
    .map(({ limit }): WorkerNoteLimit => ({ name: label(limit), value: "not enforced on this host", onHit: "This host cannot apply it." }));
  return [...enforced, ...absent];
}
