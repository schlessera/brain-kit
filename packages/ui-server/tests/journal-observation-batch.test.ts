import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUiDb } from "../src/db/client.js";
import { createJournalAccounting } from "../src/brain/journal-accounting.js";
import { createJournalObjects } from "../src/brain/journal-objects.js";
import { journalWriteBatch } from "../src/brain/journal-write-batch.js";
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

test("ready reservations share one durable batch and every caller receives its own result", async () => {
  const committed: number[][] = [];
  const reserve = journalWriteBatch<number, number>(async entries => { committed.push(entries); return entries.map(value => value + 1); });
  expect(await Promise.all(Array.from({ length: 20 }, (_, i) => reserve(i)))).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
  expect(committed, "TWENTY_READY_PATHS_ONE_COMMIT").toEqual([Array.from({ length: 20 }, (_, i) => i)]);
});

for (const boundary of ["reserved", "first_published", "all_published", "finished"] as const) test(`batched retention recovers and retries both versions after a crash at ${boundary}`, () => {
  const root = mkdtempSync(join(tmpdir(), "odysseus-batch-crash-")), path = join(root, "ui.db"), objects = join(root, "objects");
  const db = createUiDb(path), accounting = createJournalAccounting(db, path), store = createJournalObjects(objects, accounting);
  const content = ["Ithaca before", "Ithaca after"], entries = content.map(text => ({ hash: sha(text), bytes: Buffer.byteLength(text) }));
  try {
    accounting.write(() => db.query("INSERT INTO turn_journal_turns (turn_id,actor,profile,started_at,state) VALUES ('voyage','interactive','governed',0,'recording')").run());
    const ids = accounting.reserveBatch(entries);
    if (boundary !== "reserved") writeFileSync(join(objects, entries[0]!.hash), content[0]!);
    if (boundary === "all_published" || boundary === "finished") writeFileSync(join(objects, entries[1]!.hash), content[1]!);
    if (boundary === "finished") accounting.finishBatch(entries.map((entry, i) => ({ ...entry, id: ids[i]! })), ["voyage"]);
    // Simulated process death at a durable boundary; startup is the same
    // recovery routine used for individually reserved objects.
    accounting.write(() => db.query("UPDATE turn_journal_reservations SET pid=2147483647,pid_start='ended'").run());
    expect(accounting.recover(store), "BATCH_CRASH_RECOVERY_RESOLVES_EVERY_RESERVATION").toEqual({ unresolvedRecords: 0, firstCause: null });
    expect(db.query("SELECT count(*) AS n FROM turn_journal_reservations").get()).toEqual({ n: 0 });
    // Retry the observation from its still-owned sealed checkpoint. Previously
    // published versions may deduplicate; no missing version is called clean.
    const retry = accounting.reserveBatch(entries);
    for (let i = 0; i < entries.length; i++) writeFileSync(join(objects, entries[i]!.hash), content[i]!);
    accounting.finishBatch(entries.map((entry, i) => ({ ...entry, id: retry[i]! })), ["voyage"]);
    expect(db.query("SELECT hash FROM turn_journal_object_refs WHERE turn_id='voyage' ORDER BY hash").all(), "BOTH_VERSIONS_DURABLY_PINNED_AFTER_RETRY").toEqual(entries.map(entry => ({ hash: entry.hash })).sort((a,b) => a.hash.localeCompare(b.hash)));
    expect(entries.map(entry => store.verify(entry.hash, entry.bytes)), "RECOVERED_VERSION_BYTES_EXACT").toEqual([true, true]);
    expect(content.map(text => store.read(sha(text), 1024).toString())).toEqual(content);
  } finally { store.close(); db.close(); rmSync(root, { recursive: true, force: true }); }
});

test("a mismatched second batch completion rolls back the first object's pin and reservation", () => {
  const root = mkdtempSync(join(tmpdir(), "odysseus-batch-atomic-")), path = join(root, "ui.db"), db = createUiDb(path), accounting = createJournalAccounting(db, path);
  const entries = [{ hash: sha("Athena"), bytes: 6 }, { hash: sha("Ithaca"), bytes: 6 }];
  try {
    accounting.write(() => db.query("INSERT INTO turn_journal_turns (turn_id,actor,profile,started_at,state) VALUES ('voyage','interactive','governed',0,'recording')").run());
    const ids = accounting.reserveBatch(entries);
    expect(() => accounting.finishBatch(entries.map((entry, i) => ({ ...entry, id: ids[i]!, bytes: i === 1 ? 7 : 6 })), ["voyage"]), "BATCH_BOUNDARY_REJECTS_MISMATCH").toThrow("does not match");
    expect(db.query("SELECT state FROM turn_journal_objects ORDER BY hash").all()).toEqual([{ state: "pending" }, { state: "pending" }]);
    expect(db.query("SELECT count(*) AS n FROM turn_journal_reservations").get()).toEqual({ n: 2 });
    expect(db.query("SELECT count(*) AS n FROM turn_journal_object_refs").get(), "FAILED_BATCH_PINS_NO_PARTIAL_WINDOW").toEqual({ n: 0 });
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});

test("a quarantined hash refuses only its version within an otherwise healthy reservation batch", () => {
  const root = mkdtempSync(join(tmpdir(), "odysseus-batch-quarantine-")), path = join(root, "ui.db"), db = createUiDb(path), accounting = createJournalAccounting(db, path);
  const bad = sha("Scylla"), good = sha("Ithaca");
  try {
    accounting.write(() => {
      db.query("INSERT INTO turn_journal_objects VALUES (?,6,'present')").run(bad);
      db.query("INSERT INTO turn_journal_object_quarantine VALUES (?,0,'Error','corrupt','fixture')").run(bad);
    });
    const ids = accounting.reserveBatch([{ hash: bad, bytes: 6 }, { hash: good, bytes: 6 }]);
    expect(ids[0], "QUARANTINED_VERSION_REFUSED_IN_BATCH").toBeNull();
    expect(typeof ids[1], "HEALTHY_PEER_RESERVATION_ADMITTED").toBe("string");
    expect(db.query("SELECT hash FROM turn_journal_reservations").all(), "QUARANTINE_DOES_NOT_SPREAD_TO_HEALTHY_PEER").toEqual([{ hash: good }]);
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});
