/** Explicit copied inputs for non-storage adapter probes; native qualification is separate. */
import type { AgentBackend, StartTurnRequest } from "@schlessera/brain-ui-sdk/server";
import { createFixtureWorkerStartupView } from "../../packages/ui-sdk/tests/helpers/worker-startup-view-fixture.js";
import { replaceNativeStartupAcquisitionForFixture } from "../../packages/ui-server/tests/helpers/fixture-native-startup.js";

export async function startFixtureTurn(backend: AgentBackend, brain: string, request: StartTurnRequest): Promise<void> {
  const restore = replaceNativeStartupAcquisitionForFixture();
  let view: ReturnType<typeof createFixtureWorkerStartupView> | undefined;
  try { view = createFixtureWorkerStartupView(brain); await backend.startTurn({ ...request, workerStartupView: view }); }
  finally { try { await view?.cleanup(); } finally { restore(); } }
}
