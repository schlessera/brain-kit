import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { closeSync, copyFileSync, mkdirSync, mkdtempSync, openSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUiDb } from "../src/db/client.js";
import { createJournalAccounting } from "../src/brain/journal-accounting.js";
import { createJournalObjects } from "../src/brain/journal-objects.js";
import { createNativeJournalFixture } from "./helpers/native-journal-fixture.js";
import { journalWriteBatch } from "../src/brain/journal-write-batch.js";
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

test("ready reservations share one durable batch and every caller receives its own result", async () => {
  const committed: number[][] = [];
  const reserve = journalWriteBatch<number, number>(async entries => { committed.push(entries); return entries.map(value => value + 1); });
  expect(await Promise.all(Array.from({ length: 20 }, (_, i) => reserve(i)))).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
  expect(committed, "TWENTY_READY_PATHS_ONE_COMMIT").toEqual([Array.from({ length: 20 }, (_, i) => i)]);
});

for (const boundary of ["reserved", "first_published", "all_published", "finished"] as const) test(`batched retention recovers and retries both versions after a crash at ${boundary}`, async () => {
  const root = mkdtempSync(join(tmpdir(), "odysseus-batch-crash-")), path = join(root, "ui.db"), objects = join(root, "objects");
  const db = createUiDb(path), accounting = createJournalAccounting(db, path), store = createJournalObjects(objects, accounting);
  const brain = join(root, "brain"); mkdirSync(brain);
  writeFileSync(join(brain, "before.md"), "Ithaca before"); writeFileSync(join(brain, "after.md"), "Ithaca after");
  const native = createNativeJournalFixture(brain, root), checkpoint = await native.manager.checkpoint(crypto.randomUUID());
  const content = ["Ithaca before", "Ithaca after"], entries = content.map(text => ({ hash: sha(text), bytes: Buffer.byteLength(text) }));
  try {
    accounting.write(() => db.query("INSERT INTO turn_journal_turns (turn_id,actor,profile,started_at,state) VALUES ('voyage','interactive','governed',0,'recording')").run());
    const ids = accounting.reserveBatch(entries);
    if (boundary !== "reserved") copyFileSync(join(checkpoint.path, "before.md"), join(objects, entries[0]!.hash));
    if (boundary === "all_published" || boundary === "finished") copyFileSync(join(checkpoint.path, "after.md"), join(objects, entries[1]!.hash));
    if (boundary === "finished") accounting.finishBatch(entries.map((entry, i) => ({ ...entry, id: ids[i]! })), ["voyage"]);
    // Simulated process death at a durable boundary; startup is the same
    // recovery routine used for individually reserved objects.
    accounting.write(() => db.query("UPDATE turn_journal_reservations SET pid=2147483647,pid_start='ended'").run());
    expect(accounting.recover(store), "BATCH_CRASH_RECOVERY_RESOLVES_EVERY_RESERVATION").toEqual({ unresolvedRecords: 0, firstCause: null });
    expect(db.query("SELECT count(*) AS n FROM turn_journal_reservations").get()).toEqual({ n: 0 });
    const published = boundary === "reserved" ? [] : boundary === "first_published" ? entries.slice(0, 1) : entries;
    expect(published.map(entry => store.has(entry.hash)), "PUBLISHED_VERSIONS_SURVIVE_RECOVERY").toEqual(published.map(() => true));
    expect(published.map(entry => store.read(entry.hash, 1024).toString()), "RECOVERED_BYTES_EXIST_BEFORE_RETRY").toEqual(boundary === "first_published" ? ["Ithaca before"] : boundary === "reserved" ? [] : ["Ithaca before", "Ithaca after"]);
    if (boundary === "finished") expect(db.query("SELECT count(*) AS n FROM turn_journal_object_refs WHERE turn_id='voyage'").get(), "FINISHED_PINS_SURVIVE_RECOVERY").toEqual({ n: 2 });
    writeFileSync(join(brain, "before.md"), "live overwrite"); writeFileSync(join(brain, "after.md"), "different live bytes");
    for (const [index, name] of ["before.md", "after.md"].entries()) {
      const fd = openSync(join(checkpoint.path, name), "r");
      try {
        const hash = await store.putFileAsync(fd, entries[index]!.bytes);
        accounting.write(() => db.query("INSERT OR IGNORE INTO turn_journal_object_refs VALUES ('voyage',?)").run(hash));
      } finally { closeSync(fd); }
    }
    expect(db.query("SELECT hash FROM turn_journal_object_refs WHERE turn_id='voyage' ORDER BY hash").all(), "BOTH_VERSIONS_DURABLY_PINNED_AFTER_RETRY").toEqual(entries.map(entry => ({ hash: entry.hash })).sort((a,b) => a.hash.localeCompare(b.hash)));
    expect(entries.map(entry => store.verify(entry.hash, entry.bytes)), "RECOVERED_VERSION_BYTES_EXACT").toEqual([true, true]);
    expect(content.map(text => store.read(sha(text), 1024).toString())).toEqual(content);
  } finally { await native.close(); store.close(); db.close(); rmSync(root, { recursive: true, force: true }); }
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

test("reservation pressure shrinks the batch and waits for one copy instead of dropping retained history", async () => {
  const { journalReservationBatch } = await import("../src/brain/journal-reservation-batch.js");
  const { JournalCapacityError } = await import("../src/brain/journal-objects.js");
  const root = mkdtempSync(join(tmpdir(), "odysseus-reservation-pressure-")), path = join(root, "ui.db"), db = createUiDb(path);
  const initial = createJournalAccounting(db, path);
  const size = 2 * 1024 * 1024, entries = ["a", "b", "c"].map(value => ({ hash: sha(value), bytes: size }));
  initial.write(() => { for (const entry of entries) db.query("INSERT INTO turn_journal_objects VALUES (?,?,'present')").run(entry.hash, size); });
  const bounded = createJournalAccounting(db, path, { capBytes: initial.usage() + size + 512 * 1024 });
  expect(() => bounded.reserveBatch(entries.slice(0, 2)), "TWO_COPIES_EXCEED_TEMPORARY_ROOM").toThrow(JournalCapacityError);
  const queue = journalReservationBatch(async batch => bounded.reserveBatch(batch));
  const work = entries.map(entry => queue.reserve(entry).then(id => ({ id, error: null }), error => ({ id: null, error })));
  try {
    const ids: string[] = [];
    for (let i = 0; i < entries.length; i++) {
      const result = await work[i]!; expect(result.error, "CAPACITY_FALLBACK_DOES_NOT_REFUSE_SEQUENTIAL_COPIES").toBeNull();
      const id = result.id; expect(typeof id).toBe("string"); ids.push(id!);
      expect(db.query("SELECT count(*) AS n FROM turn_journal_reservations").get(), "ONLY_ONE_COPY_RESERVATION_AT_BOUND").toEqual({ n: 1 });
      bounded.finishBatch([{ ...entries[i]!, id: id! }], []); queue.settled([id!]);
    }
    expect(new Set(ids).size).toBe(3);
    expect(db.query("SELECT count(*) AS n FROM turn_journal_objects WHERE state='present'").get(), "PRESSURE_PRESERVES_RETAINED_OBJECTS").toEqual({ n: 3 });
  } finally { await Promise.allSettled(work); db.close(); rmSync(root, { recursive: true, force: true }); }
});
