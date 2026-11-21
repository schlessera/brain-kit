import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as identity from "../../ui-sdk/src/server/worker-identity.js";
import * as launcher from "../../ui-sdk/src/server/worker-launcher.js";
import { createUiDb } from "../src/db/client.js";
import { createJournalAccounting } from "../src/brain/journal-accounting.js";
import { createJournalObjects } from "../src/brain/journal-objects.js";
import { createNativeJournalCapture } from "../src/brain/native-journal-capture.js";
import { createNativeJournalFixture } from "./helpers/native-journal-fixture.js";

for (const readerLimit of [8, 1000]) test(`private changed-file batches respect reader and sequential staging capacity: readers=${readerLimit}`, async () => {
  const root = mkdtempSync(join(tmpdir(), "odysseus-private-batch-")), brain = join(root, "brain"), objectsRoot = join(root, "objects"), dbPath = join(root, "ui.db"); mkdirSync(brain);
  const size = 2 * 1024 * 1024;
  for (let i = 0; i < 10; i++) writeFileSync(join(brain, `note${i}.md`), Buffer.alloc(size, i + 65), { mode: 0o600 });
  const native = createNativeJournalFixture(brain, root), roots = new Map<string, string>(), checkpoint = native.manager.checkpoint;
  native.manager.checkpoint = async (...args) => { const result = await checkpoint(...args); roots.set(result.id, result.path); return result; };
  let readers = 0, maximumReaders = 0, temporary = 0, maximumTemporary = 0;
  native.manager.readCheckpoint = async (id, path, maximum, workerUid) => {
    if (readers >= readerLimit) throw new Error("Native checkpoint reader slots are busy");
    readers++; maximumReaders = Math.max(maximumReaders, readers);
    const data = readFileSync(join(roots.get(id)!, path)), completed = Promise.withResolvers<{ bytes: number; workerUid: number }>();
    let sent = false, ended = false;
    const finish = () => { if (!ended) { ended = true; readers--; completed.resolve({ bytes: data.length, workerUid }); } };
    const stream = new ReadableStream<Uint8Array>({ async pull(controller) { await new Promise<void>(resolve => setImmediate(resolve)); if (!sent) { sent = true; controller.enqueue(data); } else { controller.close(); finish(); } }, cancel() { finish(); } });
    expect(data.length).toBeLessThanOrEqual(maximum); return { stream, workerUid, completed: completed.promise };
  };
  const db = createUiDb(dbPath), accounting = createJournalAccounting(db, dbPath, { capBytes: 46 * 1024 * 1024 }), objects = createJournalObjects(objectsRoot, accounting);
  const helper = spyOn(identity, "workerIdentityHelper").mockReturnValue("/odysseus/identity");
  const verified = spyOn(launcher, "verifiedWorkerIdentity").mockReturnValue({ identity: "separate_uid", workerUid: 42 });
  const open = fs.open;
  const denied = spyOn(fs, "open").mockImplementation(((path: string, ...args: unknown[]) => {
    if (/\/note\d+\.md$/.test(String(path))) return Promise.reject(Object.assign(new Error("private worker input"), { code: "EACCES" }));
    return Reflect.apply(open, fs, [path, ...args]);
  }) as typeof fs.open);
  const capture = createNativeJournalCapture(native.manager, (fd, size, signal) => objects.putFileAsync(fd, size, signal), {}, {
    brainPath: brain, async createTemporary(maximum) {
      const held = accounting.reserveTemporary(maximum), path = join(objectsRoot, `pending-${held.id}`), file = await open(path, "wx+", 0o600); unlinkSync(path);
      temporary++; maximumTemporary = Math.max(maximumTemporary, temporary);
      return { file, release() { temporary--; held.release(); } };
    },
  }, { steering: false, index: false });
  try {
    await capture.initialize(); const policy = await capture.policy();
    for (let i = 0; i < 10; i++) writeFileSync(join(brain, `note${i}.md`), Buffer.alloc(size, i + 97));
    const outcome = await capture.observe(new Map([["voyage", policy]])).then(value => ({ value, error: null }), error => ({ value: null, error: String(error) }));
    expect(outcome.error, "PRIVATE_BATCH_FITS_EXISTING_READER_AND_STORAGE_PRIMITIVES").toBeNull();
    expect(maximumReaders, "PRIVATE_BATCH_NEVER_OPENS_NINTH_NATIVE_READER").toBeLessThanOrEqual(8);
    expect(maximumTemporary, "PRIVATE_STAGING_FALLS_BACK_TO_ONE_COPY").toBe(1);
    expect(outcome.value!.changes.get("voyage")).toHaveLength(10);
    expect(db.query("SELECT count(*) AS n FROM turn_journal_objects WHERE state='present'").get()).toEqual({ n: 20 });
    await outcome.value!.commit();
  } finally { await capture.close(); denied.mockRestore(); verified.mockRestore(); helper.mockRestore(); objects.close(); db.close(); await native.close(); rmSync(root, { recursive: true, force: true }); }
});

test("an inaccessible hardlink never suppresses the readable alias's before and after bytes", async () => {
  const { cpSync, linkSync } = await import("node:fs");
  const root = mkdtempSync(join(tmpdir(), "odysseus-hardlink-reader-")), brain = join(root, "brain"); mkdirSync(join(brain, "a-denied"), { recursive: true }); mkdirSync(join(brain, "z-readable"));
  writeFileSync(join(brain, "a-denied/note.md"), "Ithaca before"); linkSync(join(brain, "a-denied/note.md"), join(brain, "z-readable/note.md"));
  const native = createNativeJournalFixture(brain, root, (source, target) => { cpSync(source, target, { recursive: true }); unlinkSync(join(target, "z-readable/note.md")); linkSync(join(target, "a-denied/note.md"), join(target, "z-readable/note.md")); });
  const roots = new Map<string,string>(), checkpoint = native.manager.checkpoint; native.manager.checkpoint = async (...args) => { const cp = await checkpoint(...args); roots.set(cp.id, cp.path); return cp; };
  native.manager.readCheckpoint = async (id, path, _maximum, workerUid) => {
    if (path.startsWith("a-denied/")) throw Object.assign(new Error("denied directory"), { code: "EACCES" });
    const bytes = readFileSync(join(roots.get(id)!, path)); return { workerUid, stream: new Response(bytes).body!, completed: Promise.resolve({ bytes: bytes.length, workerUid }) };
  };
  const helper = spyOn(identity, "workerIdentityHelper").mockReturnValue("/odysseus/identity"), verified = spyOn(launcher, "verifiedWorkerIdentity").mockReturnValue({ identity: "separate_uid", workerUid: 42 });
  const open = fs.open, denied = spyOn(fs, "open").mockImplementation(((path: string, ...args: unknown[]) => {
    if (/\/note\.md$/.test(String(path))) return Promise.reject(Object.assign(new Error("worker-private directory"), { code: "EACCES" }));
    return Reflect.apply(open, fs, [path, ...args]);
  }) as typeof fs.open);
  const db = createUiDb(":memory:"), objects = createJournalObjects(join(root, "objects"), createJournalAccounting(db, ":memory:"));
  const capture = createNativeJournalCapture(native.manager, (fd, size, signal) => objects.putFileAsync(fd, size, signal), {}, { brainPath: brain, async createTemporary() {
    const path = join(root, crypto.randomUUID()), file = await open(path, "wx+", 0o600); unlinkSync(path); return { file, release() {} };
  } }, { steering: false, index: false });
  try {
    await capture.initialize(); const policy = await capture.policy(); writeFileSync(join(brain, "a-denied/note.md"), "Ithaca after");
    const result = await capture.observe(new Map([["voyage",policy]])), alias = result.changes.get("voyage")!.find(item => item.path === "z-readable/note.md")!;
    expect(alias.before?.hash, "READABLE_HARDLINK_RETAINS_BEFORE_BYTES").toBeDefined(); expect(alias.after?.hash, "READABLE_HARDLINK_RETAINS_AFTER_BYTES").toBeDefined();
    expect(objects.read(alias.before!.hash!, 100).toString()).toBe("Ithaca before"); expect(objects.read(alias.after!.hash!, 100).toString()).toBe("Ithaca after"); await result.commit();
  } finally { await capture.close(); denied.mockRestore(); verified.mockRestore(); helper.mockRestore(); objects.close(); db.close(); await native.close(); rmSync(root, { recursive: true, force: true }); }
});
