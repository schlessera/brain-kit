/** Deterministic crash barriers around receipt coverage; only the named process dies. */
import { join } from "node:path";
import { createUiDb } from "../../src/db/client.js";
import { mock } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import * as policy from "../../src/brain/native-journal-policy.js";
import { journalDatabasePath } from "../../src/db/journal-database.js";
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
// Wrap the actual exclusion operation, so moving it before capture also moves
// this barrier. The independent connection cannot see an uncommitted receipt.
const freeze = policy.freezeNativeJournalPolicy;
mock.module("../../src/brain/native-journal-policy.js", () => ({ ...policy,
  freezeNativeJournalPolicy: async (...args: Parameters<typeof freeze>) => {
    const frozen = await freeze(...args);
    return { ...frozen, excludeCheckout(path: string) {
      frozen.excludeCheckout(path);
      if (phase !== "after") return;
      const committed = new Database(journalDatabasePath(dbPath), { readonly: true });
      const receipt = committed.query(`SELECT c.pack_hash FROM turn_journal_code_receipts c JOIN turn_journal_object_refs r
        ON r.turn_id=c.turn_id AND r.hash=c.pack_hash WHERE c.turn_id='crash-sail' AND c.checkout=?`).get(path) as { pack_hash: string } | null;
      committed.close();
      if (!receipt || !existsSync(join(root, "objects", receipt.pack_hash))) {
        console.error("EXCLUSION_REQUIRES_COMMITTED_RECEIPT_AND_PINNED_PACK"); process.exit(1);
      }
      console.log("EXCLUSION_HAS_COMMITTED_RECEIPT_AND_PINNED_PACK");
      crash();
    } };
  },
}));
const { createTurnJournal } = await import("../../src/brain/turn-journal.js");
const journal = createTurnJournal(db, { nativeManager: native.manager, brainPath: brain, dbPath, objectsRoot: join(root, "objects"), codeChanges: { maintenance } });
await journal.begin("crash-sail", { sessionId: "ithaca", actor: "interactive", model: null, profile: "governed", policyHash: null, workspaceReadOnly: false, workspacesWritable: true }, () => {});
throw Error("Crash barrier was not reached");
