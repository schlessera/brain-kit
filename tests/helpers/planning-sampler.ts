/**
 * Sampler thread for `observePlanning` (#2465). The observed planning call is
 * synchronous and blocks the main thread, so everything measured during it is
 * read from here: the main thread's run-queue wait, CPU pressure, and which
 * other processes on the host were using CPU.
 */
import { readFileSync, readdirSync } from "node:fs";
import { parentPort, workerData } from "node:worker_threads";

const { mainTid, intervalMs, maxSamples, maxProcesses } = workerData as { mainTid: number; intervalMs: number; maxSamples: number; maxProcesses: number };
const CLOCK_TICKS = 100; // USER_HZ on Linux; /proc/<pid>/stat CPU fields count these.

/** Main-thread CPU and run-queue wait in nanoseconds, or null when unreadable. */
function mainThread(): { cpuNs: number; waitNs: number } | null {
  try {
    const [cpu, wait] = readFileSync(`/proc/self/task/${mainTid}/schedstat`, "utf8").trim().split(/\s+/).map(Number);
    return Number.isFinite(cpu) && Number.isFinite(wait) ? { cpuNs: cpu!, waitNs: wait! } : null;
  } catch { return null; }
}

/** Cumulative microseconds some task waited for CPU, host-wide; null when PSI is unavailable. */
function cpuPressureUs(): number | null {
  try { const total = /some .*total=(\d+)/.exec(readFileSync("/proc/pressure/cpu", "utf8"))?.[1]; return total ? Number(total) : null; }
  catch { return null; }
}

/** CPU ticks per live process, keyed by pid and start time so a reused pid is a new process. */
function processTicks(): Map<string, { pid: number; ticks: number; comm: string }> {
  const ticks = new Map<string, { pid: number; ticks: number; comm: string }>();
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const stat = readFileSync(`/proc/${entry}/stat`, "utf8");
      const close = stat.lastIndexOf(")");
      const fields = stat.slice(close + 2).split(" ");
      // After "pid (comm) ": state=0, utime=11, stime=12, starttime=19.
      ticks.set(`${entry}:${fields[19]}`, { pid: Number(entry), ticks: Number(fields[11]) + Number(fields[12]), comm: stat.slice(stat.indexOf("(") + 1, close) });
    } catch { /* Exited between listing and reading. */ }
  }
  return ticks;
}

const startedAt = performance.now();
const firstTicks = processTicks();
const samples: { atMs: number; mainCpuNs: number | null; mainWaitNs: number | null; pressureUs: number | null }[] = [];
let truncated = false;
const sample = () => {
  if (samples.length >= maxSamples) { truncated = true; return; }
  const thread = mainThread();
  samples.push({ atMs: Math.round(performance.now() - startedAt), mainCpuNs: thread?.cpuNs ?? null, mainWaitNs: thread?.waitNs ?? null, pressureUs: cpuPressureUs() });
};
sample();
const timer = setInterval(sample, intervalMs);

parentPort!.once("message", () => {
  clearInterval(timer);
  sample();
  const lastTicks = processTicks();
  const busiest = [...lastTicks].map(([key, last]) => ({ ...last, cpuMs: Math.round((last.ticks - (firstTicks.get(key)?.ticks ?? 0)) * 1000 / CLOCK_TICKS) }))
    .filter(row => row.cpuMs > 0).sort((a, b) => b.cpuMs - a.cpuMs);
  const processes = busiest.slice(0, maxProcesses).map(row => {
    let command = "";
    try { command = readFileSync(`/proc/${row.pid}/cmdline`, "utf8").replaceAll("\0", " ").trim().slice(0, 200); } catch { /* Gone. */ }
    return { pid: row.pid, comm: row.comm, cpuMs: row.cpuMs, self: row.pid === process.pid, newDuringWindow: ![...firstTicks.values()].some(first => first.pid === row.pid), command };
  });
  parentPort!.postMessage({ samples, truncated, processes, processesTruncated: busiest.length > maxProcesses });
});
