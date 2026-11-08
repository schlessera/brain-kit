import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateSignedCookie } from "hono/cookie";
import { ATTACHMENT_GRACE_MS, ATTACHMENT_UNBOUND_TTL_MS } from "@schlessera/brain-ui-sdk/protocol";

import { createUiDb } from "../src/db/client";
import { createPrincipal } from "../src/db/principals";
import { createDraftStore, DraftError } from "../src/drafts/store";
import { reconcileAttachments, sweepAttachments } from "../src/attachments/sweep";
import { storeOriginal } from "./helpers/attachment-fixture";
import { httpContractApp } from "./helpers/http-contract-app";

// Cleanup of composer originals (#3153, docs/plans/chat-attachments.md §6.7)
// against real files: one hour for never-bound uploads, seven days from the
// last reference's removal, race-safe against rebinding, restart-safe between
// mark and unlink. Odysseus fixtures only.

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });

function setup(dbPath = ":memory:") {
  const brain = mkdtempSync(join(tmpdir(), "brain-sweep-"));
  cleanups.push(() => rmSync(brain, { recursive: true, force: true }));
  const clock = { now: 10_000_000 };
  const open = () => {
    const db = createUiDb(dbPath);
    return { db, store: createDraftStore(db, { now: () => clock.now }) };
  };
  const first = open();
  const owner = createPrincipal(first.db, { authMethod: "password", label: "Odysseus phone", ttlSeconds: 365 * 24 * 3600 }).id;
  return { brain, clock, owner, open, ...first };
}
const exists = (brain: string, path: string) => existsSync(join(brain, path));
const save = (store: ReturnType<typeof createDraftStore>, owner: string, ifMatch: number, fileIds: string[], text = "Sail") =>
  store.save(owner, "draft-ithaca", { ifMatch, idempotencyKey: `s${ifMatch}`, sessionId: null, text, attachmentIds: [], fileIds });

test("a never-bound upload is removed after one hour; a bound one is not", async () => {
  const { brain, clock, owner, store, db } = setup();
  cleanups.push(() => db.close());
  const stray = storeOriginal(brain, store, owner, "draft-ithaca", "stray.txt", "forgotten");
  const kept = storeOriginal(brain, store, owner, "draft-ithaca", "kept.txt", "saved");
  save(store, owner, 0, [kept.fileId]);
  clock.now += ATTACHMENT_UNBOUND_TTL_MS - 1;
  expect(await sweepAttachments(brain, store)).toEqual([]);
  clock.now += 2;
  expect(await sweepAttachments(brain, store)).toEqual([stray.fileId]);
  expect(exists(brain, stray.path)).toBe(false);
  expect(exists(brain, kept.path)).toBe(true);
  // Even long after, a saved binding protects its file.
  clock.now += ATTACHMENT_GRACE_MS * 2;
  expect(await sweepAttachments(brain, store)).toEqual([]);
  expect(exists(brain, kept.path)).toBe(true);
});

test("a formerly referenced original gets seven days from its last reference; rebinding cancels the clock", async () => {
  const { brain, clock, owner, store, db } = setup();
  cleanups.push(() => db.close());
  const file = storeOriginal(brain, store, owner, "draft-ithaca", "crew-list.txt", "Eurylochus");
  save(store, owner, 0, [file.fileId]);
  clock.now += 1_000;
  save(store, owner, 1, [], "Sail without it");
  clock.now += ATTACHMENT_GRACE_MS - 1;
  expect(await sweepAttachments(brain, store)).toEqual([]);
  // Rebound one millisecond before expiry: collection is cancelled, and a
  // later removal starts a fresh seven days.
  save(store, owner, 2, [file.fileId]);
  clock.now += 10;
  // Bound again and now past the first removal's seven days: protected.
  expect(await sweepAttachments(brain, store)).toEqual([]);
  save(store, owner, 3, [], "Without it again");
  clock.now += ATTACHMENT_GRACE_MS - 1;
  expect(await sweepAttachments(brain, store)).toEqual([]);
  clock.now += 2;
  expect(await sweepAttachments(brain, store)).toEqual([file.fileId]);
  expect(exists(brain, file.path)).toBe(false);
  // The grace period stayed charged until the unlink: now nothing is.
  expect((db.query("SELECT COUNT(*) AS n FROM attachment_files").get() as { n: number }).n).toBe(0);
});

test("a rebind that loses the race against the mark is refused, never bound to a deleted file", async () => {
  const { brain, clock, owner, store, db } = setup();
  cleanups.push(() => db.close());
  const file = storeOriginal(brain, store, owner, "draft-ithaca", "late.txt", "almost gone");
  save(store, owner, 0, [], "Empty");
  clock.now += ATTACHMENT_UNBOUND_TTL_MS + 1;
  // Step 1 runs; before the unlink, a save tries to bind the file.
  expect(store.sweepMark()).toEqual([{ fileId: file.fileId, state: "deleting" }]);
  let refused: unknown;
  try { save(store, owner, 1, [file.fileId]); } catch (error) { refused = error; }
  expect(refused).toBeInstanceOf(DraftError);
  expect((refused as DraftError).body).toMatchObject({ error: "ATTACHMENT_INVALID", message: expect.stringContaining("no longer available") });
  expect(store.attachmentReferenced(file.fileId)).toBe(false);
  // The next run finishes the deletion.
  expect(await sweepAttachments(brain, store)).toEqual([file.fileId]);
  expect(exists(brain, file.path)).toBe(false);
});

test("a restart between mark and unlink finishes the deletion; boot reconciles drift without deleting it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "brain-sweep-db-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const first = setup(join(dir, "ui.db"));
  const { brain, clock, owner } = first;
  const doomed = storeOriginal(brain, first.store, owner, "draft-ithaca", "doomed.txt", "unbound");
  const gone = storeOriginal(brain, first.store, owner, "draft-ithaca", "gone.txt", "saved");
  save(first.store, owner, 0, [gone.fileId]);
  clock.now += ATTACHMENT_UNBOUND_TTL_MS + 1;
  expect(first.store.sweepMark().map((m) => m.fileId)).toEqual([doomed.fileId]);
  // A reservation of the dying process, and a partial upload it left.
  first.store.reserveAttachment(owner, "draft-ithaca", { bytes: 999, instanceId: "old-instance" });
  mkdirSync(join(brain, ".brain-ui/attachments", `.${crypto.randomUUID()}.partial`));
  first.db.close();

  const second = first.open();
  cleanups.push(() => second.db.close());
  // Drift: a directory with no record, and a record whose directory vanished.
  const orphanId = crypto.randomUUID();
  mkdirSync(join(brain, ".brain-ui/attachments", orphanId));
  writeFileSync(join(brain, ".brain-ui/attachments", orphanId, "found.txt"), "left behind");
  rmSync(join(brain, ".brain-ui/attachments", gone.fileId), { recursive: true });
  expect(await reconcileAttachments(brain, second.store, "new-instance")).toEqual({ adopted: [orphanId], missing: [gone.fileId] });
  expect((second.db.query("SELECT COUNT(*) AS n FROM attachment_reservations").get() as { n: number }).n).toBe(0);
  const states = Object.fromEntries((second.db.query("SELECT file_id, state, ever_referenced, unreferenced_since FROM attachment_files").all() as Array<{ file_id: string; state: string; ever_referenced: number; unreferenced_since: number | null }>)
    .map((r) => [r.file_id, [r.state, r.ever_referenced, r.unreferenced_since]]));
  expect(states).toEqual({ [doomed.fileId]: ["deleting", 0, null], [gone.fileId]: ["missing", 1, null], [orphanId]: ["stored", 1, clock.now] });
  // The interrupted deletion completes; the adopted orphan waits its seven days.
  expect(await sweepAttachments(brain, second.store)).toEqual([doomed.fileId]);
  expect(exists(brain, doomed.path)).toBe(false);
  expect(exists(brain, `.brain-ui/attachments/${orphanId}/found.txt`)).toBe(true);
  clock.now += ATTACHMENT_GRACE_MS + 1;
  expect(await sweepAttachments(brain, second.store)).toEqual([orphanId]);
});

test("concurrent uploads at the pool edge cannot multiply the cap: reservations are charged while streaming", async () => {
  const SECRET = "attachment-sweep-fixture-secret-0123456789";
  const t = await httpContractApp({ env: { AUTH_MODE: "password", BRAIN_UI_PASSWORD_HASH: "unused", COOKIE_SECRET: SECRET, BRAIN_UI_ALLOW_LOOPBACK_ORIGIN: "1", BRAIN_UI_ATTACHMENT_POOL_BYTES: "100" } });
  cleanups.push(() => t.close());
  const principal = createPrincipal(t.app.db, { authMethod: "password", label: "Odysseus phone", ttlSeconds: 3600 });
  const cookie = (await generateSignedCookie("brain_ui_session", principal.id, SECRET)).split(";")[0]!;
  const streams: Array<ReadableStreamDefaultController<Uint8Array>> = [];
  const start = (i: number) => t.fetch(`/api/drafts/draft-${i}/files`, {
    method: "POST",
    headers: { cookie, origin: "http://localhost", host: "localhost", "idempotency-key": `k${i}`, "content-type": "text/plain", "content-length": "40", "x-file-name": `log-${i}.txt` },
    body: new ReadableStream<Uint8Array>({ start(controller) { streams[i] = controller; } }),
    // @ts-expect-error Bun accepts a streamed request body with half duplex.
    duplex: "half",
  });
  const first = start(0), second = start(1);
  // Both uploads have reserved their declared 40 bytes and are still streaming.
  const reserved = () => t.app.db.query("SELECT COUNT(*) AS n, COALESCE(SUM(bytes), 0) AS b FROM attachment_reservations").get() as { n: number; b: number };
  for (const deadline = Date.now() + 5_000; reserved().n < 2 && Date.now() < deadline;) await Bun.sleep(5);
  expect(reserved(), "ATTACHMENT_STREAMING_UPLOADS_RESERVED").toEqual({ n: 2, b: 80 });
  // A third cannot fit.
  const third = await t.fetch("/api/drafts/draft-2/files", { method: "POST", body: "y".repeat(40),
    headers: { cookie, origin: "http://localhost", host: "localhost", "idempotency-key": "k2", "content-type": "text/plain", "content-length": "40", "x-file-name": "log-2.txt" } });
  expect([third.status, await third.json()]).toEqual([507, expect.objectContaining({ error: "ATTACHMENT_CAPACITY", bound: "pool" })]);
  for (const i of [0, 1]) { streams[i]!.enqueue(new TextEncoder().encode("x".repeat(40))); streams[i]!.close(); }
  expect([(await first).status, (await second).status]).toEqual([201, 201]);
  const charged = (t.app.db.query("SELECT COALESCE(SUM(bytes), 0) AS b FROM attachment_files").get() as { b: number }).b
    + (t.app.db.query("SELECT COALESCE(SUM(bytes), 0) AS b FROM attachment_reservations").get() as { b: number }).b;
  expect(charged).toBe(80);
});
