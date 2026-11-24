import { availableParallelism, loadavg, platform } from "node:os";
import { createHistogram, monitorEventLoopDelay } from "node:perf_hooks";
import type { ActivityTurnLifecycle } from "@schlessera/brain-ui-sdk/protocol";

type AdmissionLoad = NonNullable<ActivityTurnLifecycle["admissionLoad"]>;

function hostLoad(): AdmissionLoad["atDequeue"] {
  const sample: NonNullable<AdmissionLoad["atDequeue"]> = {};
  try {
    const [load] = loadavg();
    if (platform() !== "win32" && Number.isFinite(load) && load! >= 0) sample.load1 = load;
  } catch { /* unavailable */ }
  try {
    const count = availableParallelism();
    if (Number.isInteger(count) && count > 0) sample.cpuCount = count;
  } catch { /* unavailable */ }
  return sample;
}

/** Combine the native observations with the at most two delays crossing its sampling boundaries. */
function nativeDelayStats(monitor: ReturnType<typeof monitorEventLoopDelay>, boundaryMs: number[]) {
  const n = monitor.count;
  if (!boundaryMs.length) return { eventLoopMaxMs: monitor.max / 1e6, eventLoopP99Ms: monitor.percentile(99) / 1e6 };
  const rank = Math.ceil(.99 * (n + boundaryMs.length));
  // Inserting k values shifts rank by at most k. Only this slice of native ranks can supply p99.
  const first = Math.max(1, rank - boundaryMs.length);
  const candidates = [...boundaryMs];
  for (let i = first; i <= Math.min(rank, n); i++) candidates.push(monitor.percentile(100 * i / n) / 1e6);
  candidates.sort((a, b) => a - b);
  return { eventLoopMaxMs: Math.max(monitor.max / 1e6, ...boundaryMs), eventLoopP99Ms: candidates[rank - first]! };
}

function delaySampler(): () => Pick<AdmissionLoad, "eventLoopMaxMs" | "eventLoopP99Ms"> {
  const resolution = 10;
  const histogram = createHistogram();
  let monitor: ReturnType<typeof monitorEventLoopDelay> | undefined;
  try {
    monitor = monitorEventLoopDelay({ resolution });
    monitor.enable();
  } catch { monitor = undefined; }
  // A turn can enter the backend before an overdue timer gets a chance to fire.
  // Keep its deadline so stopping the monitor can include this final delay.
  let due = performance.now() + resolution, firstTick = true;
  const boundaryMs: number[] = [];
  const recordDelay = (delay: number) => histogram.record(Math.max(1, Math.round(delay * 1e6)));
  const timer = setInterval(() => {
    const now = performance.now();
    if (!monitor) recordDelay(now - due);
    else if (firstTick && !monitor.count && now > due) boundaryMs.push(now - due);
    firstTick = false;
    due = now + resolution;
  }, resolution);
  timer.unref();
  return () => {
    const overdue = performance.now() - due;
    clearInterval(timer);
    monitor?.disable();
    if (overdue > 0) boundaryMs.push(overdue);
    if (monitor?.count) return nativeDelayStats(monitor, boundaryMs);
    for (const delay of boundaryMs) recordDelay(delay);
    return histogram.count ? { eventLoopMaxMs: histogram.max / 1e6, eventLoopP99Ms: histogram.percentile(99) / 1e6 } : {};
  };
}

export function startAdmissionLoad(record: ActivityTurnLifecycle): (backendStarted: boolean) => void {
  const load: AdmissionLoad = { atDequeue: hostLoad() };
  record.admissionLoad = load;
  let stop: ReturnType<typeof delaySampler> | undefined;
  try { stop = delaySampler(); } catch { /* No delay sampler on this runtime. */ }
  return backendStarted => {
    if (backendStarted) load.atBackendStart = hostLoad();
    try { Object.assign(load, stop?.()); } catch { /* Timing is best effort. */ }
  };
}
