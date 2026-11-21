/** Explicit copied execution inputs for offline, non-storage runtime measurements. */
import { prepareWorkerSandbox } from "../packages/ui-sdk/src/server/worker-launcher.js";
import { createFixtureMaintenanceHost, createFixtureWorkerStartupView } from "../packages/ui-sdk/tests/helpers/worker-startup-view-fixture.js";

/** Keep the real launcher, tool hooks and inference transport; only storage acquisition is a fixture. */
export function createMeasurementWorkerFixture(brain: string, home?: string) {
  const maintenance = createFixtureMaintenanceHost(brain);
  try {
    // Measurements write only ephemeral WORKER_SCRATCH. No persistent areas
    // need an output keeper or its namespace-only temporary mount aliases.
    const workerSandbox = prepareWorkerSandbox(brain, { home, maintenance, areas: [] });
    const workerStartupView = createFixtureWorkerStartupView(brain);
    return { maintenance, request: { workerSandbox, workerStartupView }, cleanup() {
      try { workerStartupView.cleanup(); } finally { maintenance.cleanup(); }
    } };
  } catch (error) { maintenance.cleanup(); throw error; }
}
