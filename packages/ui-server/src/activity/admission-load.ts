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

function delaySampler(): () => Pick<AdmissionLoad, "eventLoopMaxMs" | "eventLoopP99Ms"> {
  const resolution = 10;
  const histogram = createHistogram();
  let monitor: ReturnType<typeof monitorEventLoopDelay> | undefined;
  try {
    monitor = monitorEventLoopDelay({ resolution });
    monitor.enable();
  } catch { monitor = undefined; }
  let previous = performance.now();
  // One sample per timer interval. A native tick can precede the first JS tick
  // or miss a stall at shutdown, so also measure the full elapsed interval.
  const sample = (terminal: boolean) => {
    const now = performance.now();
    const gap = now - previous;
    previous = now;
    const native = monitor?.count ? monitor.max / 1e6 : undefined;
    if (native !== undefined) monitor!.reset();
    // A partial interval at shutdown is not a delayed tick.
    if (terminal && gap < resolution && native === undefined) return;
    const elapsed = terminal && gap < resolution ? native! : Math.max(gap, native ?? 0);
    histogram.record(Math.max(1, Math.round(elapsed * 1e6)));
  };
  const timer = setInterval(() => {
    try { sample(false); } catch { /* A diagnostic failure cannot interrupt the turn. */ }
  }, resolution);
  timer.unref();
  return () => {
    clearInterval(timer);
    monitor?.disable();
    sample(true);
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
