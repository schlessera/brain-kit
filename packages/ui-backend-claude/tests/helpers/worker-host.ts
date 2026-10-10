/** Mock only the host probe for hand-driven SDK streams; native proof never imports this. */
import { afterEach, beforeEach, spyOn } from "bun:test";
import { workerHostBoundary } from "@schlessera/brain-ui-sdk/internal";
export function mockWorkerHostForSdkStream() {
  let probe: ReturnType<typeof spyOn>;
  beforeEach(() => { probe = spyOn(workerHostBoundary, "probe").mockReturnValue({ ok: true }); });
  afterEach(() => probe.mockRestore());
}
