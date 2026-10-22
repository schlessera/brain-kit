/**
 * Diagnostics for whole-repository planning calls that intermittently exceed
 * their test deadline on CI (#2465). `observePlanning` runs the call unchanged
 * and writes one bounded JSON record (see `defaultOutput`). It separates three
 * explanations:
 *
 * - CPU contention: wall time ≈ own CPU + run-queue wait, with host CPU
 *   pressure, and the busiest other processes named.
 * - Planner cost: wall time ≈ own CPU, with little run-queue wait.
 * - Blocking: wall time well above both, as when waiting on a synchronous child
 *   (its CPU appears as waited-for child CPU) or on I/O.
 *
 * It never changes the call's result, error or deadline. A failure to observe
 * or to write is reported in the record (or on stderr) and otherwise ignored.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";

export const PLANNING_OBSERVER_LIMITS = { intervalMs: 250, maxSamples: 240, maxProcesses: 10, maxRecordBytes: 256 * 1024, stopMs: 2_000 } as const;

export interface PlanningRecord {
  version: 1;
  label: string;
  pid: number;
  outcome: "returned" | "threw";
  wallMs: number;
  /** Process CPU (all threads, including the sampler) over the call. */
  processCpuMs: number;
  /** CPU of child processes this process waited for during the call, such as synchronous spawns. */
  waitedChildrenCpuMs: number | null;
  /** The blocked main thread: time on CPU and time runnable but waiting for one. */
  mainThread: { cpuMs: number; runQueueWaitMs: number } | null;
  /** Host-wide PSI "some" CPU stall over the call; null where PSI is unavailable. */
  hostCpuPressureMs: number | null;
  loadAverage: { before: number[] | null; after: number[] | null };
  samples: { atMs: number; mainCpuNs: number | null; mainWaitNs: number | null; pressureUs: number | null }[];
  /** Busiest processes alive at the end of the call, by CPU used during it. Processes that exited earlier are not listed. */
  processes: { pid: number; comm: string; cpuMs: number; self: boolean; newDuringWindow: boolean; command: string }[];
  limits: typeof PLANNING_OBSERVER_LIMITS;
  /** Any reason the record is incomplete; an incomplete record supports no conclusion. */
  incomplete: string[];
}

/** utime+stime of waited-for children, in ms (USER_HZ = 100). */
const childrenCpuMs = () => {
  try { const stat = readFileSync("/proc/self/stat", "utf8"); const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" "); return (Number(fields[13]) + Number(fields[14])) * 10; }
  catch { return null; }
};
const loadAverage = () => { try { return readFileSync("/proc/loadavg", "utf8").split(" ").slice(0, 3).map(Number); } catch { return null; } };
const pressureUs = () => { try { const total = /some .*total=(\d+)/.exec(readFileSync("/proc/pressure/cpu", "utf8"))?.[1]; return total ? Number(total) : null; } catch { return null; } };
const mainSchedstat = () => {
  try { const [cpu, wait] = readFileSync(`/proc/self/task/${process.pid}/schedstat`, "utf8").trim().split(/\s+/).map(Number); return { cpu: cpu!, wait: wait! }; }
  catch { return null; }
};

/**
 * On GitHub Actions the record goes under the workspace's `tmp/`, which unit
 * workers preserve. Elsewhere it goes to the system temp directory: records
 * name host processes and paths, which must not land in the tree.
 */
function defaultOutput(root: string): string {
  return process.env.GITHUB_ACTIONS === "true" ? join(root, "tmp/unit-consumer-planning") : join(tmpdir(), "brain-unit-consumer-planning");
}

/** Run `call` unchanged and record how its wall time divided between CPU, waiting and the rest. */
export async function observePlanning<T>(root: string, label: string, call: () => T, output = defaultOutput(root)): Promise<T> {
  if (process.platform !== "linux") return call();
  const incomplete: string[] = [];
  let sampler: Worker | undefined;
  try {
    sampler = new Worker(new URL("./planning-sampler.ts", import.meta.url), { workerData: { mainTid: process.pid, ...PLANNING_OBSERVER_LIMITS } });
    // Let the sampler take its first reading before the call blocks this thread.
    await new Promise(resolve => setTimeout(resolve, PLANNING_OBSERVER_LIMITS.intervalMs));
  } catch (error) { incomplete.push(`sampler did not start: ${String(error)}`); sampler = undefined; }
  const before = { at: performance.now(), cpu: process.cpuUsage(), children: childrenCpuMs(), main: mainSchedstat(), pressure: pressureUs(), load: loadAverage() };
  let outcome: PlanningRecord["outcome"] = "returned";
  let result: T | undefined;
  let failure: unknown;
  try { result = call(); } catch (error) { outcome = "threw"; failure = error; }
  const after = { at: performance.now(), cpu: process.cpuUsage(before.cpu), children: childrenCpuMs(), main: mainSchedstat(), pressure: pressureUs(), load: loadAverage() };

  let sampled: { samples: PlanningRecord["samples"]; truncated: boolean; processes: PlanningRecord["processes"]; processesTruncated: boolean } | undefined;
  if (sampler) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      sampled = await Promise.race([
        new Promise<typeof sampled>(resolve => { sampler!.once("message", resolve); sampler!.postMessage("stop"); }),
        new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), PLANNING_OBSERVER_LIMITS.stopMs); }),
      ]);
    } finally { clearTimeout(timer); void sampler.terminate(); }
    if (!sampled) incomplete.push("sampler did not answer within its stop budget");
    else {
      if (sampled.truncated) incomplete.push(`more than ${PLANNING_OBSERVER_LIMITS.maxSamples} samples`);
      if (sampled.processesTruncated) incomplete.push(`more than ${PLANNING_OBSERVER_LIMITS.maxProcesses} busy processes; only the busiest are listed`);
    }
  }
  if (!before.main || !after.main) incomplete.push("main-thread schedstat unavailable");
  const record: PlanningRecord = {
    version: 1, label, pid: process.pid, outcome,
    wallMs: Math.round(after.at - before.at),
    processCpuMs: Math.round((after.cpu.user + after.cpu.system) / 1000),
    waitedChildrenCpuMs: before.children !== null && after.children !== null ? after.children - before.children : null,
    mainThread: before.main && after.main ? { cpuMs: Math.round((after.main.cpu - before.main.cpu) / 1e6), runQueueWaitMs: Math.round((after.main.wait - before.main.wait) / 1e6) } : null,
    hostCpuPressureMs: before.pressure !== null && after.pressure !== null ? Math.round((after.pressure - before.pressure) / 1000) : null,
    loadAverage: { before: before.load, after: after.load },
    samples: sampled?.samples ?? [], processes: sampled?.processes ?? [], limits: PLANNING_OBSERVER_LIMITS, incomplete,
  };
  try {
    let text = JSON.stringify(record, null, 1);
    if (text.length > PLANNING_OBSERVER_LIMITS.maxRecordBytes) {
      record.samples = []; record.incomplete.push("record over its byte cap; samples dropped");
      text = JSON.stringify(record, null, 1);
    }
    mkdirSync(output, { recursive: true });
    writeFileSync(join(output, `${label}-${process.pid}.json`), text);
  } catch (error) { console.error(`planning observer could not write its record: ${String(error)}`); }
  if (outcome === "threw") throw failure;
  return result as T;
}
