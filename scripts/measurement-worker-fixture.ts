import { registerNativeFixtureRtk } from "./test-native-guard";
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
    let live:import("../packages/ui-sdk/src/server/worker-launcher").LaunchedWorker|undefined;
    return { maintenance, request: { workerSandbox, workerStartupView,workerStarted(worker:Parameters<NonNullable<import("../packages/ui-sdk/src/server/backend").StartTurnRequest["workerStarted"]>>[0]){if(!("pid" in worker)||typeof worker.pid!=="number")throw Error("native fixture RTK worker identity unavailable");live=worker as import("../packages/ui-sdk/src/server/worker-launcher").LaunchedWorker;} },
      qualifyRtk(){if(!live)throw Error("native fixture RTK worker unavailable");registerNativeFixtureRtk(live);},cleanup() {
      try { workerStartupView.cleanup(); } finally { maintenance.cleanup(); }
    } };
  } catch (error) { maintenance.cleanup(); throw error; }
}
