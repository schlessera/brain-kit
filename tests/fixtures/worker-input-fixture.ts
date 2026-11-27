/** Explicit copied inputs for non-storage adapter probes; native qualification is separate. */
import type { AgentBackend, StartTurnRequest } from "@schlessera/brain-ui-sdk/server";
import { createFixtureWorkerStartupView } from "../../packages/ui-sdk/tests/helpers/worker-startup-view-fixture.js";
import { replaceNativeStartupAcquisitionForFixture } from "../../packages/ui-server/tests/helpers/fixture-native-startup.js";

/**
 * `viewReady` runs once the copied startup view exists, just before the
 * backend starts: a probe times backend startup from there, so the copy a
 * hosted turn replaces with a native snapshot is not charged to it (#4286).
 */
export async function startFixtureTurn(backend: AgentBackend, brain: string, request: StartTurnRequest, observe: { viewReady?(): void } = {}): Promise<void> {
  const restore = replaceNativeStartupAcquisitionForFixture();
  let view: ReturnType<typeof createFixtureWorkerStartupView> | undefined;
  try { view = createFixtureWorkerStartupView(brain); observe.viewReady?.(); await backend.startTurn({ ...request, workerStartupView: view }); }
  finally { try { await view?.cleanup(); } finally { restore(); } }
}
