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
  // A turn can enter the backend before an overdue timer gets a chance to fire.
  // Keep its deadline so stopping the monitor can include this final delay.
  let due = performance.now() + resolution;
  const recordDelay = (delay: number) => histogram.record(Math.max(1, Math.round(delay * 1e6)));
  const timer = setInterval(() => {
    const now = performance.now();
    if (!monitor) recordDelay(now - due);
    due = now + resolution;
  }, resolution);
  timer.unref();
  return () => {
    const overdue = performance.now() - due;
    clearInterval(timer);
    if (monitor) {
      monitor.disable();
      histogram.add(monitor);
    }
    if (overdue > 0) recordDelay(overdue);
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
