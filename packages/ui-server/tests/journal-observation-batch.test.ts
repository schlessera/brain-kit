import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

for (const boundary of ["reserved", "first_published", "all_published", "finished"] as const) test(`production startup recovery leaves an interrupted batch honestly partial at ${boundary}`, async () => {
  const { Database } = await import("bun:sqlite"), { createNativeBrainLeaseManager } = await import("../src/brain/native-brain-leases.js"), { createTurnJournal } = await import("../src/brain/turn-journal.js");
  const root = mkdtempSync(join(tmpdir(), "odysseus-batch-startup-")), path = join(root, "ui.db"), objects = join(root, "objects"), brain = join(root, "brain"); mkdirSync(brain);
  writeFileSync(join(brain, "before.md"), "Ithaca before"); writeFileSync(join(brain, "after.md"), "Ithaca after");
  const db = createUiDb(path), accounting = createJournalAccounting(db, path), store = createJournalObjects(objects, accounting), native = createNativeJournalFixture(brain, root);
  const ready = await native.client.ready(), leasePath = join(root, "native-leases.sqlite"), options = { statePath: leasePath, brainPath: brain, fsid: ready.fsid, brainUuid: ready.brainUuid };
  const owner = await createNativeBrainLeaseManager(native.client, options), checkpoint = await owner.client.checkpoint(crypto.randomUUID()), leases = new Database(leasePath);
  const content = ["Ithaca before", "Ithaca after"], entries = content.map(text => ({ hash: sha(text), bytes: Buffer.byteLength(text) }));
  let successor: Awaited<ReturnType<typeof createNativeBrainLeaseManager>> | undefined, journal: ReturnType<typeof createTurnJournal> | undefined;
  try {
    accounting.write(() => db.query("INSERT INTO turn_journal_turns (turn_id,session_id,actor,profile,started_at,state,pid,pid_start) VALUES ('voyage','ithaca','interactive','governed',0,'recording',2147483647,'dead')").run());
    const ids = accounting.reserveBatch(entries);
    if (boundary !== "reserved") copyFileSync(join(checkpoint.path, "before.md"), join(objects, entries[0]!.hash));
    if (boundary === "all_published" || boundary === "finished") copyFileSync(join(checkpoint.path, "after.md"), join(objects, entries[1]!.hash));
    if (boundary === "finished") accounting.finishBatch(entries.map((entry, i) => ({ ...entry, id: ids[i]! })), ["voyage"]);
    accounting.write(() => db.query("UPDATE turn_journal_reservations SET pid=2147483647,pid_start='dead'").run());
    leases.query("UPDATE native_root_leases SET owner_start=owner_start||'-dead'").run();
    // The app recovers dead native owners before creating the journal. No
    // checkpoint is reopened and no pin or retry is manufactured by the test.
    successor = await createNativeBrainLeaseManager(native.client, options);
    expect(await successor.recoverDeadOwners(), "NATIVE_STARTUP_RELEASES_DEAD_BATCH_SOURCE_FIRST").toMatchObject({ released: [checkpoint.id], unknown: [] });
    expect(existsSync(checkpoint.path), "INTERRUPTED_CAPTURE_HAS_NO_STARTUP_RETRY_SOURCE").toBe(false);
    writeFileSync(join(brain, "before.md"), "live overwrite"); writeFileSync(join(brain, "after.md"), "different live bytes");
    journal = createTurnJournal(db, { brainPath: brain, dbPath: path, objectsRoot: objects, nativeManager: successor.client }); await journal.ready;
    expect(journal.summary("voyage").state, "STARTUP_MARKS_INTERRUPTED_TURN_PARTIAL").toBe("partial");
    const row = db.query("SELECT ended_at,missing FROM turn_journal_turns WHERE turn_id='voyage'").get() as { ended_at: number; missing: string };
    expect(row.ended_at).not.toBeNull(); expect(JSON.parse(row.missing)).toContainEqual({ path: ".", reason: "interrupted_observation" });
    expect(db.query("SELECT count(*) AS n FROM turn_journal_reservations").get()).toEqual({ n: 0 });
    const published = boundary === "reserved" ? [] : boundary === "first_published" ? entries.slice(0,1) : entries;
    expect(published.map(entry => store.read(entry.hash, 100).toString()), "STARTUP_RECOVERS_ONLY_ACTUALLY_PUBLISHED_BYTES").toEqual(content.slice(0,published.length));
    expect(entries.map(entry => store.has(entry.hash)), "UNPUBLISHED_VERSION_IS_NEVER_FABRICATED_FROM_LIVE_BYTES").toEqual(entries.map(entry => published.includes(entry)));
    expect(db.query("SELECT count(*) AS n FROM turn_journal_object_refs WHERE turn_id='voyage'").get(), "ONLY_COMMITTED_COMPLETION_PINS_SURVIVE").toEqual({ n: boundary === "finished" ? 2 : 0 });
    expect(journal.details("ithaca", "voyage")!.changes, "UNCOMMITTED_WINDOW_IS_NOT_REPORTED_AS_CAPTURED_HISTORY").toEqual([]);
  } finally { await journal?.close(); await successor?.close(); await owner.close(); leases.close(); store.close(); db.close(); await native.close(); rmSync(root, { recursive: true, force: true }); }
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

test("recovery removes the dead pending link before validating a published digest", async () => {
  const { linkSync } = await import("node:fs");
  const root = mkdtempSync(join(tmpdir(), "odysseus-double-link-")), path = join(root, "ui.db"), db = createUiDb(path), accounting = createJournalAccounting(db, path), store = createJournalObjects(join(root, "objects"), accounting);
  const bytes = "Odysseus returns", hash = sha(bytes);
  try {
    const [id] = accounting.reserveBatch([{ hash, bytes: Buffer.byteLength(bytes) }]);
    writeFileSync(join(root, "objects", `pending-${id}`), bytes);
    linkSync(join(root, "objects", `pending-${id}`), join(root, "objects", hash));
    accounting.write(() => db.query("UPDATE turn_journal_reservations SET pid=2147483647,pid_start='dead'").run());
    expect(accounting.recover(store), "TWO_LINK_CRASH_RECOVERS").toEqual({ unresolvedRecords: 0, firstCause: null });
    expect(store.read(hash, 100).toString(), "TWO_LINK_CRASH_PRESERVES_PUBLISHED_BYTES").toBe(bytes);
    expect(accounting.recover(store).unresolvedRecords).toBe(0);
  } finally { store.close(); db.close(); rmSync(root, { recursive: true, force: true }); }
});
