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
  try {
    const histogram = monitorEventLoopDelay({ resolution });
    histogram.enable();
    return () => {
      histogram.disable();
      return histogram.count ? { eventLoopMaxMs: histogram.max / 1e6, eventLoopP99Ms: histogram.percentile(99) / 1e6 } : {};
    };
  } catch {
    const histogram = createHistogram();
    let previous = performance.now();
    const timer = setInterval(() => {
      const now = performance.now();
      histogram.record(Math.max(1, Math.round((now - previous - resolution) * 1e6)));
      previous = now;
    }, resolution);
    timer.unref();
    return () => {
      clearInterval(timer);
      return histogram.count ? { eventLoopMaxMs: histogram.max / 1e6, eventLoopP99Ms: histogram.percentile(99) / 1e6 } : {};
    };
  }
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
