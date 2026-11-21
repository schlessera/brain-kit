import { expect, test } from "bun:test";
import { closeSync, mkdtempSync, openSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUiDb } from "../src/db/client.js";
import { createJournalAccounting } from "../src/brain/journal-accounting.js";
import { createJournalObjects, JournalCapacityError } from "../src/brain/journal-objects.js";

test("changed-file capture yields to other sessions and preserves durable object accounting", async () => {
  const root = mkdtempSync(join(tmpdir(), "journal-async-odysseus-"));
  const dbPath = join(root, "ui.db"), db = createUiDb(dbPath);
  const ledger = createJournalAccounting(db, dbPath);
  // The identity pass runs before admission and awaits nothing but its reads, so
  // heartbeats seen at admission prove those reads yield to the loop.
  let heartbeats = 0, heartbeatsAtAdmission = -1;
  const store = createJournalObjects(join(root, "objects"), { reserve(bytes, hash) { heartbeatsAtAdmission = heartbeats; return ledger.reserve(bytes, hash); } });
  const bytes = Buffer.alloc(8 * 1024 * 1024, 65);
  writeFileSync(join(root, "source"), bytes);
  const source = openSync(join(root, "source"), "r");
  const timer = setInterval(() => heartbeats++, 1);
  try {
    const hash = await store.putFileAsync(source, bytes.length);
    expect(heartbeatsAtAdmission, "JOURNAL_CHANGED_CAPTURE_YIELDS_TO_SESSIONS").toBeGreaterThan(0);
    expect(store.verify(hash, bytes.length)).toBe(true);
    expect(db.query("SELECT bytes,state FROM turn_journal_objects WHERE hash=?").get(hash)).toEqual({ bytes: bytes.length, state: "present" });
    expect(db.query("SELECT count(*) AS n FROM turn_journal_reservations").get()).toEqual({ n: 0 });
    expect(await store.putFileAsync(source, bytes.length)).toBe(hash);
    expect(readdirSync(join(root, "objects"))).toEqual([hash]);
    expect(store.read(hash, bytes.length)).toEqual(bytes);
  } finally { clearInterval(timer); closeSync(source); store.close(); db.close(); rmSync(root, { recursive: true, force: true }); }
});

test("changed-file overflow is refused before creating temporary objects", async () => {
  const root = mkdtempSync(join(tmpdir(), "journal-async-cap-odysseus-"));
  const dbPath = join(root, "ui.db"), db = createUiDb(dbPath);
  const store = createJournalObjects(join(root, "objects"), createJournalAccounting(db, dbPath, { capBytes: 1024 * 1024 }));
  writeFileSync(join(root, "source"), Buffer.alloc(2 * 1024 * 1024, 65));
  const source = openSync(join(root, "source"), "r");
  try {
    await expect(store.putFileAsync(source, 2 * 1024 * 1024)).rejects.toBeInstanceOf(JournalCapacityError);
    expect(readdirSync(join(root, "objects")), "JOURNAL_ASYNC_REFUSES_BEFORE_TEMP_WRITE").toEqual([]);
    expect(db.query("SELECT count(*) AS n FROM turn_journal_reservations").get()).toEqual({ n: 0 });
  } finally { closeSync(source); store.close(); db.close(); rmSync(root, { recursive: true, force: true }); }
});

test("identical concurrent captures have one publisher and never expose a multiply linked object", async () => {
  const root = mkdtempSync(join(tmpdir(), "odysseus-identical-capture-")), dbPath = join(root, "ui.db"), db = createUiDb(dbPath);
  const ledger = createJournalAccounting(db, dbPath), release = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>();
  let active = 0, maximum = 0, reservations = 0;
  const store = createJournalObjects(join(root, "objects"), { async reserve(bytes, hash) {
    const reservation = await ledger.reserve(bytes, hash); active++; maximum = Math.max(maximum, active); reservations++; entered.resolve();
    return { id: reservation.id, async finish(...args) { await release.promise; await reservation.finish(...args); active--; }, async cancel() { await reservation.cancel(); active--; } };
  } });
  writeFileSync(join(root, "source"), "Odysseus returns to Ithaca.");
  const sources = Array.from({ length: 16 }, () => openSync(join(root, "source"), "r"));
  const work = sources.map(fd => store.putFileAsync(fd, 27));
  try {
    await entered.promise;
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(reservations, "IDENTICAL_HASH_HAS_ONE_PUBLISHER").toBe(1);
    release.resolve(); const hashes = await Promise.all(work);
    expect(new Set(hashes).size).toBe(1);
    expect(maximum, "IDENTICAL_PUBLISHERS_NEVER_OVERLAP").toBe(1);
    expect(store.verify(hashes[0]!, 27)).toBe(true);
    expect(store.read(hashes[0]!, 100).toString()).toBe("Odysseus returns to Ithaca.");
  } finally { release.resolve(); await Promise.allSettled(work); for (const fd of sources) closeSync(fd); store.close(); db.close(); rmSync(root, { recursive: true, force: true }); }
});

test("post-publication directory sync failure settles the in-flight copy owner", async () => {
  const fs = await import("node:fs"), { spyOn } = await import("bun:test");
  const root = mkdtempSync(join(tmpdir(), "odysseus-publish-sync-")); let settled = 0, finished = 0;
  const store = createJournalObjects(join(root, "objects"), { reserve() { return { finish() { finished++; }, cancel() {}, settled() { settled++; } }; } });
  writeFileSync(join(root, "source"), "Ithaca"); const source = openSync(join(root, "source"), "r"), sync = fs.fsync;
  const fault = spyOn(fs, "fsync").mockImplementation(((fd: number, callback: (error: Error | null) => void) => {
    if (fs.fstatSync(fd).isDirectory()) callback(new Error("directory sync EIO")); else sync(fd, callback);
  }) as typeof fs.fsync);
  try {
    await expect(store.putFileAsync(source, 6)).rejects.toThrow("directory sync EIO");
    expect(finished).toBe(0); expect(settled, "PUBLISHED_SYNC_FAILURE_RELEASES_IN_FLIGHT_OWNER").toBe(1);
  } finally { fault.mockRestore(); closeSync(source); store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("post-publication sync failure wakes a peer waiting on the real reservation queue", async () => {
  const fs = await import("node:fs"), { spyOn } = await import("bun:test");
  const { journalReservationBatch } = await import("../src/brain/journal-reservation-batch.js");
  const { watchdogMs } = await import("../../../scripts/test-deadlines.js");
  const root = mkdtempSync(join(tmpdir(), "odysseus-sync-peer-")), entered = Promise.withResolvers<void>(), fail = Promise.withResolvers<void>(), waiting = Promise.withResolvers<void>();
  let admitted = false;
  const queue = journalReservationBatch(async entries => {
    if (admitted) { waiting.resolve(); throw new JournalCapacityError(); }
    admitted = true; return entries.map(() => crypto.randomUUID());
  });
  const store = createJournalObjects(join(root, "objects"), { async reserve(bytes, hash) {
    const id = (await queue.reserve({ bytes, hash }))!;
    return { id, finish() {}, cancel() {}, settled() { queue.settled([id]); } };
  } });
  writeFileSync(join(root, "source"), "Ithaca"); const source = openSync(join(root, "source"), "r"), sync = fs.fsync;
  const fault = spyOn(fs, "fsync").mockImplementation(((fd: number, callback: (error: Error | null) => void) => {
    if (fs.fstatSync(fd).isDirectory()) { entered.resolve(); void fail.promise.then(() => callback(new Error("directory sync EIO"))); } else sync(fd, callback);
  }) as typeof fs.fsync);
  const copy = store.putFileAsync(source, 6).then(() => null, error => error);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let peer: Promise<string | null> | undefined;
  try {
    await entered.promise;
    peer = queue.reserve({ bytes: 6, hash: "a".repeat(64) }).then(() => "admitted", error => error instanceof JournalCapacityError ? "capacity" : String(error));
    await waiting.promise; fail.resolve();
    expect(String(await copy)).toContain("directory sync EIO");
    const result = await Promise.race([peer, new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), watchdogMs(5000)); })]);
    expect(result, "SYNC_FAILURE_WAKES_CAPACITY_PEER_INSTEAD_OF_FREEZING_IT").toBe("capacity");
  } finally {
    clearTimeout(timer); fail.resolve(); fault.mockRestore();
    // Also release the owner in a mutated run so a failed assertion cannot hang teardown.
    queue.settled([]); admitted = false;
    await copy; if (peer) await peer;
    closeSync(source); store.close(); rmSync(root, { recursive: true, force: true });
  }
});
