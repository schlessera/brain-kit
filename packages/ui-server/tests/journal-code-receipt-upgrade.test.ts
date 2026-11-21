import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createUiDb } from "../src/db/client.js";
import { JOURNAL_SCHEMA, journalDatabasePath } from "../src/db/journal-database.js";
import { createJournalAccounting } from "../src/brain/journal-accounting.js";
import { openSqliteWriter } from "../src/db/write-worker.js";
import { createTurnJournal } from "../src/brain/turn-journal.js";
import { SELF } from "../src/brain/writer-gate.js";
import { createNativeJournalFixture } from "./helpers/native-journal-fixture.js";
import { createFixtureMaintenanceHost } from "../../ui-sdk/tests/helpers/worker-startup-view-fixture.js";

const tables = ["turn_journal_code_receipts", "turn_journal_code_reverts", "turn_journal_code_failures"];
test("upgrading a near-cap journal preserves writes and admits receipt tables only for a checkout with room", async () => {
  const root = mkdtempSync("/var/tmp/odysseus-code-upgrade-"), path = join(root, "ui.db"), brain = join(root, "brain"), objects = join(root, "objects");
  mkdirSync(brain);
  let db = createUiDb(path), journal: ReturnType<typeof createTurnJournal> | undefined, other: ReturnType<typeof createUiDb> | undefined;
  const native = createNativeJournalFixture(brain, root), maintenance = createFixtureMaintenanceHost(brain);
  let externalWriter: ReturnType<typeof openSqliteWriter> | undefined;
  try {
    for (const table of tables) db.exec(`DROP TABLE IF EXISTS journal.${table}`);
    db.query("DELETE FROM journal.turn_journal_migrations WHERE filename='096_code_change_receipts.journal.sql'").run();
    const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", reserved = 1024 * 1024;
    db.query("INSERT INTO turn_journal_reservations(id,bytes,pid,pid_start,created_at,hash,kind) VALUES (?,?,?,?,0,NULL,'temporary')").run(id, reserved, SELF.pid, SELF.start);
    db.exec("VACUUM journal"); db.exec("PRAGMA journal.wal_checkpoint(TRUNCATE)");
    const pageSize = (db.query("PRAGMA journal.page_size").get() as { page_size: number }).page_size, pages = statSync(journalDatabasePath(path)).size / pageSize;
    const standingWal = 32 + (pages + Math.ceil(pages / (pageSize / 4 - 2))) * (pageSize + 24), cap = pages * pageSize + standingWal + reserved + 4096;
    db.close(); db = createUiDb(path);
    const accounting = createJournalAccounting(db, path, { capBytes: cap });
    expect(() => accounting.write(() => db.query("UPDATE turn_journal_allocation SET index_purge=1 WHERE id=1").run()), "NEAR_CAP_RECEIPT_UPGRADE_WRITES_REMAIN_USABLE").not.toThrow();
    expect(accounting.ensureCodeReceiptTables(), "NEAR_CAP_RECEIPT_SCHEMA_IS_REFUSED").toBe(false);
    expect(() => accounting.write(() => {}), "RECEIPT_SCHEMA_REFUSAL_LEAVES_WRITES_USABLE").not.toThrow();
    const schema = () => db.query("SELECT name FROM journal.sqlite_schema WHERE type='table' AND name GLOB 'turn_journal_code_*' ORDER BY name").all();
    expect(schema(), "UNUSED_RECEIPT_SCHEMA_STAYS_ABSENT").toEqual([]);
    journal = createTurnJournal(db, { nativeManager: native.manager, brainPath: brain, dbPath: path, objectsRoot: objects, capBytes: cap, codeChanges: { maintenance } });
    await journal.ready;
    expect(journal.details("ithaca", "missing")).toBeNull();
    expect(journal.summary("missing").state).toBe("unknown");
    expect(schema(), "STARTUP_NEVER_ADMITS_UNUSED_RECEIPT_SCHEMA").toEqual([]);
    await expect(journal.withCodeEvidence("ithaca", "missing", "workspaces/argo", async () => {})).rejects.toThrow("checkout receipt unavailable");
    accounting.write(() => db.query("DELETE FROM turn_journal_reservations WHERE id=?").run(id));
    const checkout = join(brain, "workspaces/argo"); mkdirSync(checkout, { recursive: true });
    const git = (...args: string[]) => {
      const result = Bun.spawnSync(["git", "-C", checkout, "-c", "user.name=Odysseus", "-c", "user.email=odysseus@ithaca.example", ...args], { env: { PATH: "/usr/bin:/bin", HOME: "/nonexistent", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } });
      expect(result.exitCode, result.stderr.toString()).toBe(0);
    };
    git("init", "-q", "-b", "main"); writeFileSync(join(checkout, "chart.md"), "Ithaca\n"); git("add", "."); git("commit", "-qm", "Set sail");
    // Refuse only the schema admission on the first real checkout capture.
    // The next turn retries without a restart; unrelated note history stays usable.
    await journal.close();
    const writer = openSqliteWriter(db, { attach: [{ schema: JOURNAL_SCHEMA, path: journalDatabasePath(path) }] });
    let refused = false;
    journal = createTurnJournal(db, { nativeManager: native.manager, brainPath: brain, dbPath: path, objectsRoot: objects, capBytes: cap, codeChanges: { maintenance },
      writer: { ...writer, channel(module, options, revive) {
        const channel = writer.channel(module, options, revive);
        return { ...channel, call<T>(name: string, ...args: unknown[]): Promise<T> {
          if (name === "ensureCodeReceiptTables" && !refused) { refused = true; return Promise.resolve(false as T); }
          return channel.call<T>(name, ...args);
        } };
      } },
    });
    // This writer is externally owned, so the final teardown closes it too.
    externalWriter = writer;
    const metadata = { sessionId: "ithaca", actor: "interactive", profile: "governed", model: null, policyHash: null } as const;
    await expect(journal.begin("refused", { ...metadata, workspaceReadOnly: false, workspacesWritable: true }, () => {}), "SCHEMA_REFUSAL_NAMES_ONLY_FAILED_CHECKOUT_CAPTURE").rejects.toThrow("checkout_receipt_schema_not_admitted");
    expect(journal.cleanupStatus().lastFailure).toMatchObject({ kind: "code_capture_failed", scope: "checkout", turnId: "refused", checkout: "workspaces/argo", cause: expect.stringContaining("checkout_receipt_schema_not_admitted") });
    expect(schema()).toEqual([]);
    expect(journal.details("ithaca", "refused")!.missing, "SCHEMA_ADMISSION_REFUSAL_DOES_NOT_INVENT_A_CAPACITY_CAUSE").toContainEqual({ path: ".", reason: "journal_unavailable" });
    await journal.begin("notes", { ...metadata, workspaceReadOnly: true }, () => {});
    writeFileSync(join(brain, "penelope.md"), "Penelope returns\n"); await journal.observe(); await journal.finish("notes");
    expect(journal.details("ithaca", "notes")!.changes.map(row => row.path), "REFUSED_CHECKOUT_LEAVES_NOTE_HISTORY_USABLE").toEqual(["penelope.md"]);
    other = createUiDb(path); createJournalAccounting(other, path, { capBytes: cap });
    await journal.begin("sail", { sessionId: "ithaca", actor: "interactive", profile: "governed", model: null, policyHash: null, workspaceReadOnly: false, workspacesWritable: true }, () => {});
    expect(schema(), "CHECKOUT_RETRIES_SCHEMA_AFTER_CAPACITY_IS_FREED").toEqual(tables.toSorted().map(name => ({ name })));
    await journal.finish("sail");
    expect(journal.details("ithaca", "sail")!.codeChanges).toMatchObject([{ checkout: "workspaces/argo", state: "complete" }]);
    expect(() => other!.query("DELETE FROM turn_journal_code_receipts").run(), "LATE_RECEIPT_SCHEMA_PROTECTS_OLDER_CONNECTIONS").toThrow("outside capacity accounting");
    expect(accounting.usage()).toBeLessThanOrEqual(cap);
  } finally { other?.close(); await journal?.close(); await externalWriter?.close(); maintenance.cleanup(); await native.close(); db.close(); rmSync(root, { recursive: true, force: true }); }
});

for (const admitted of [false, true, "legacy"] as const) test(`backups preserve ${admitted === "legacy" ? "legacy" : admitted ? "admitted" : "absent"} receipt tables`, async () => {
  const { exportInboxSnapshot, restoreInboxSnapshot } = await import("../src/inbox/snapshot.js");
  const root = mkdtempSync("/var/tmp/odysseus-code-backup-"), source = join(root, "source"), target = join(root, "target");
  mkdirSync(source); mkdirSync(target);
  const path = join(source, "ui.db"), db = createUiDb(path), accounting = createJournalAccounting(db, path);
  let restored: ReturnType<typeof createUiDb> | undefined;
  try {
    if (admitted) {
      expect(accounting.ensureCodeReceiptTables()).toBe(true);
      accounting.write(() => {
        db.query("INSERT INTO turn_journal_turns(turn_id,actor,profile,started_at,state) VALUES ('sail','interactive','governed',0,'partial')").run();
        db.query("INSERT INTO turn_journal_code_failures VALUES ('sail','workspaces/argo',?)").run(JSON.stringify({ message: "Odysseus capture refused" }));
      });
      if (admitted === "legacy") {
        const { JOURNAL_CODE_GUARDS } = await import("../src/db/journal-database.js");
        for (const guard of JOURNAL_CODE_GUARDS) db.exec(`DROP TRIGGER journal.${guard.name}`);
      }
    }
    const snapshot = await exportInboxSnapshot(db, source);
    await expect(restoreInboxSnapshot(snapshot, join(target, "ui.db"), target), "BACKUP_ACCEPTS_OPTIONAL_RECEIPT_SCHEMA").resolves.toMatchObject({ resumed: false });
    restored = createUiDb(join(target, "ui.db"));
    expect(restored.query("SELECT name FROM journal.sqlite_schema WHERE type='table' AND name GLOB 'turn_journal_code_*' ORDER BY name").all(), "BACKUP_PRESERVES_RECEIPT_SCHEMA_PRESENCE").toEqual(admitted ? tables.toSorted().map(name => ({ name })) : []);
    if (admitted) {
      expect(restored.query("SELECT checkout,cause FROM turn_journal_code_failures").all()).toEqual([{ checkout: "workspaces/argo", cause: JSON.stringify({ message: "Odysseus capture refused" }) }]);
      if (admitted === true) expect(() => restored!.query("DELETE FROM turn_journal_code_failures").run(), "RESTORED_RECEIPT_GUARDS_REMAIN_ACTIVE").toThrow("outside capacity accounting");
    }
  } finally { restored?.close(); db.close(); rmSync(root, { recursive: true, force: true }); }
});
