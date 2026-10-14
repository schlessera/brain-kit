/** Real hosted admission with explicit copied storage for non-storage subprocess probes. */
import type { Database } from "bun:sqlite";
import { createNativeBrainManagerClient } from "@schlessera/brain-ui-sdk/internal";
import { createNativeAppFixture } from "../../packages/ui-server/tests/helpers/native-app-fixture.js";
import { createHostExecution } from "../../packages/ui-server/src/brain/host-execution.js";
import { createGovernedTurns } from "../../packages/ui-server/src/brain/governed-turn.js";
import { boundaryPlanner } from "../../packages/ui-server/src/brain/application.js";

export function createFixtureTurnHost(brainPath: string, db: Database, profile: "strict" | "governed" = "strict") {
  const native = createNativeAppFixture(brainPath);
  const nativeManager = createNativeBrainManagerClient(native.nativeBrain);
  const execution = createHostExecution({ brainPath, dbPath: ":memory:", nativeManager });
  execution.attach(db);
  const governedTurns = createGovernedTurns({ brainPath, nativeManager, execution, profile, maskPaths: [],
    index: async () => {}, report(message) { throw new Error(message); } });
  return { nativeManager, execution, governedTurns, applicationPlanner: boundaryPlanner(execution.boundary),
    maintenance: execution.boundary.maintenance,
    async close() { try { await governedTurns.close(); } finally { try { execution.release(); } finally { await native.close(); } } },
  };
}
