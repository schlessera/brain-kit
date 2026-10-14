/** Explicit copied execution inputs for offline, non-storage runtime measurements. */
import { spyOn } from "bun:test";
import * as workerOutput from "../packages/ui-sdk/src/server/worker-native-output.js";
import { prepareWorkerSandbox } from "../packages/ui-sdk/src/server/worker-launcher.js";
import { createFixtureMaintenanceHost, createFixtureWorkerStartupView, prepareFixtureNativeWorkerOutput } from "../packages/ui-sdk/tests/helpers/worker-startup-view-fixture.js";

/** Keep the real launcher, tool hooks and inference transport; only storage acquisition is a fixture. */
export function createMeasurementWorkerFixture(brain: string, home?: string) {
  const maintenance = createFixtureMaintenanceHost(brain);
  const output = spyOn(workerOutput, "prepareNativeWorkerOutput").mockImplementation(prepareFixtureNativeWorkerOutput);
  try {
    const workerSandbox = prepareWorkerSandbox(brain, { home, maintenance });
    // Host setup creates writable-area mount points before the immutable input is acquired.
    const workerStartupView = createFixtureWorkerStartupView(brain);
    return { maintenance, request: { workerSandbox, workerStartupView }, cleanup() {
      try { workerStartupView.cleanup(); } finally { output.mockRestore(); maintenance.cleanup(); }
    } };
  } catch (error) { output.mockRestore(); maintenance.cleanup(); throw error; }
}
