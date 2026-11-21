/** Deterministic crash barriers around receipt coverage; only the named process dies. */
import { join } from "node:path";
import { createUiDb } from "../../src/db/client.js";
import { createTurnJournal } from "../../src/brain/turn-journal.js";
import { createNativeJournalFixture } from "./native-journal-fixture.js";
import { createFixtureMaintenanceHost } from "../../../ui-sdk/tests/helpers/worker-startup-view-fixture.js";

const [root, phase] = process.argv.slice(2) as [string, string];
const brain = join(root, "brain"), dbPath = join(root, "ui.db");
const db = createUiDb(dbPath), native = createNativeJournalFixture(brain, root), maintenance = createFixtureMaintenanceHost(brain);
function crash() {
  console.log(`CRASH_POINT ${phase}`);
  process.kill(process.pid, "SIGKILL");
}
const checkpoint = native.manager.checkpoint.bind(native.manager);
native.manager.checkpoint = async (...args) => {
  if (phase === "before" && db.query("SELECT 1 FROM turn_journal_turns WHERE turn_id='crash-sail'").get()) crash();
  return checkpoint(...args);
};
const journal = createTurnJournal(db, { nativeManager: native.manager, brainPath: brain, dbPath, objectsRoot: join(root, "objects"), codeChanges: { maintenance } });
await journal.begin("crash-sail", { sessionId: "ithaca", actor: "interactive", model: null, profile: "governed", policyHash: null, workspaceReadOnly: false }, () => {});
if (phase === "after") crash();
throw Error("Crash barrier was not reached");
