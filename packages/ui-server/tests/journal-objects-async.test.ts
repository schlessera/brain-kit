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
  const store = createJournalObjects(join(root, "objects"), ledger);
  const bytes = Buffer.alloc(8 * 1024 * 1024, 65);
  writeFileSync(join(root, "source"), bytes);
  const source = openSync(join(root, "source"), "r");
  let heartbeats = 0;
  const timer = setInterval(() => heartbeats++, 1);
  try {
    const hash = await store.putFileAsync(source, bytes.length);
    expect(heartbeats, "JOURNAL_CHANGED_CAPTURE_YIELDS_TO_SESSIONS").toBeGreaterThan(0);
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
