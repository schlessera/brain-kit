import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateSignedCookie } from "hono/cookie";
import type { Database } from "bun:sqlite";
import type { Draft, DraftSnapshotWrite } from "@schlessera/brain-ui-sdk/protocol";
import { draftSchema } from "@schlessera/brain-ui-sdk/schemas";

import { createUiDb } from "../src/db/client";
import { createPrincipal } from "../src/db/principals";
import { createDraftStore, DraftError, type DraftStore } from "../src/drafts/store";
import { storeOriginal } from "./helpers/attachment-fixture";
import { httpContractApp } from "./helpers/http-contract-app";

// The outgoing snapshot list of the #3155 G1 A ruling (#3588): up to ten
// snapshots per chat across its drafts, tabs and devices; only the save that
// creates one is refused when full, with 409 DRAFT_OUTGOING_FULL; every other
// transition edits a snapshot in place. Odysseus fixtures only.

const SECRET = "draft-snapshots-fixture-secret-0123456789";
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "brain-snapshots-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  let clock = 1_000_000;
  const db = createUiDb(join(dir, "ui.db"));
  cleanups.push(() => db.close());
  const store = createDraftStore(db, { now: () => clock });
  const owner = createPrincipal(db, { authMethod: "password", label: "Odysseus phone", ttlSeconds: 365 * 24 * 3600 }).id;
  const revisions = new Map<string, number>();
  let keys = 0;
  /** Save one revision of `draftId`, If-Match its last revision. */
  const save = (draftId: string, body: { text?: string; fileIds?: string[]; snapshots?: DraftSnapshotWrite[]; sessionId?: string | null; outgoing?: unknown }, s: DraftStore = store) => {
    clock += 1;
    const { revision } = s.save(owner, draftId, {
      ifMatch: revisions.get(draftId) ?? 0, idempotencyKey: `k-${++keys}`,
      sessionId: body.sessionId === undefined ? "voyage-ithaca" : body.sessionId,
      text: body.text ?? "", attachmentIds: [],
      ...(body.fileIds ? { fileIds: body.fileIds } : {}),
      ...(body.snapshots ? { snapshots: body.snapshots } : {}),
      ...(body.outgoing !== undefined ? { outgoing: body.outgoing as never } : {}),
    });
    revisions.set(draftId, revision);
    return revision;
  };
  const snapshot = (n: number, state: DraftSnapshotWrite["state"] = "held", fileIds: string[] = []): DraftSnapshotWrite =>
    ({ snapshotId: `snap-${n}`, requestId: `request-${n}`, text: `Message ${n} to Ithaca`, fileIds, state });
  const refuse = (fn: () => unknown): DraftError => {
    try { fn(); } catch (error) { if (error instanceof DraftError) return error; throw error; }
    throw new Error("expected a DraftError");
  };
  return { dir, db, store, owner, save, snapshot, refuse, revisions, tick: (ms: number) => { clock += ms; }, now: () => clock };
}

const messageRefs = (db: Database) => (db.query("SELECT COUNT(*) AS n FROM attachment_refs WHERE owner = 'message'").get() as { n: number }).n;

test("ten snapshots fit one chat; the eleventh is refused before anything changes", () => {
  const f = fixture();
  const list: DraftSnapshotWrite[] = [];
  for (let n = 1; n <= 10; n++) {
    list.push(f.snapshot(n, n % 2 ? "held" : "dispatched"));
    f.save("draft-ithaca", { snapshots: [...list] });
  }
  const before = f.store.get(f.owner, "draft-ithaca");
  expect(before.snapshots?.map((s) => s.snapshotId)).toEqual(list.map((s) => s.snapshotId));
  expect(draftSchema.safeParse(before).success).toBe(true);

  const error = f.refuse(() => f.save("draft-ithaca", { text: "Is the harbour open?", snapshots: [...list, f.snapshot(11)] }));
  expect(error.status).toBe(409);
  expect(error.body).toMatchObject({ error: "DRAFT_OUTGOING_FULL", limit: 10 });
  // Nothing was stored and nothing was sent: the revision, the list and the
  // conversation are exactly as before.
  expect(f.store.get(f.owner, "draft-ithaca")).toEqual(before);
  expect(messageRefs(f.db)).toBe(0);
});

test("the count covers every draft of the chat, and only that chat", () => {
  const f = fixture();
  // Six on the phone's draft, four on the laptop's draft of the same chat.
  f.save("draft-phone", { snapshots: [1, 2, 3, 4, 5, 6].map((n) => f.snapshot(n)) });
  f.save("draft-laptop", { snapshots: [7, 8, 9, 10].map((n) => f.snapshot(n)) });
  const full = f.refuse(() => f.save("draft-laptop", { snapshots: [7, 8, 9, 10, 11].map((n) => f.snapshot(n)) }));
  expect(full.body).toMatchObject({ error: "DRAFT_OUTGOING_FULL" });
  // Another chat, and a draft with no chat yet, have their own ten.
  f.save("draft-troy", { sessionId: "voyage-troy", snapshots: [21].map((n) => f.snapshot(n)) });
  f.save("draft-new", { sessionId: null, snapshots: [31].map((n) => f.snapshot(n)) });
  // A deleted draft's snapshots are gone and free their slots.
  f.save("draft-phone", { snapshots: [1, 2, 3, 4, 5, 6].map((n) => f.snapshot(n, "returned")) });
  f.store.remove(f.owner, "draft-phone", f.revisions.get("draft-phone")!);
  f.save("draft-laptop", { snapshots: [7, 8, 9, 10, 11].map((n) => f.snapshot(n)) });
});

test("Cancel, upload failure, dispatch and recovery edit in place at ten of ten", () => {
  const f = fixture();
  const file = storeOriginal(f.dir, f.store, f.owner, "draft-ithaca", "crew-list.txt", "Eurylochus\n");
  const list = Array.from({ length: 10 }, (_, i) => f.snapshot(i + 1, i < 5 ? "held" : "dispatched"));
  f.save("draft-ithaca", { snapshots: list });
  const created = f.store.get(f.owner, "draft-ithaca").snapshots!.map((s) => s.createdAt);
  const step = (n: number, change: Partial<DraftSnapshotWrite>) => {
    list[n - 1] = { ...list[n - 1]!, ...change };
    f.save("draft-ithaca", { snapshots: [...list] });
  };
  step(1, { state: "returned" }); // Cancel
  step(2, { state: "returned" }); // an upload failed
  step(3, { fileIds: [file.fileId] }); // a held send's upload was admitted
  step(3, { state: "dispatched" }); // dispatch
  step(6, { state: "returned" }); // recovery read: not accepted
  const after = f.store.get(f.owner, "draft-ithaca");
  expect(after.snapshots!.map((s) => s.state)).toEqual(["returned", "returned", "dispatched", "held", "held", "returned", "dispatched", "dispatched", "dispatched", "dispatched"]);
  // In place: same ids, same order, same creation times.
  expect(after.snapshots!.map((s) => s.createdAt)).toEqual(created);
  expect(f.store.attachmentRef(file.fileId, "outgoing", "draft-ithaca")).toBe(true);
});

test("a snapshot is never overwritten, merged or evicted by a save", () => {
  const f = fixture();
  f.save("draft-ithaca", { snapshots: [f.snapshot(1, "held"), f.snapshot(2, "dispatched")] });
  const invalid = (snapshots: DraftSnapshotWrite[]) => f.refuse(() => f.save("draft-ithaca", { snapshots }));
  // Its text and request are fixed.
  expect(invalid([{ ...f.snapshot(1), text: "Merged text" }, f.snapshot(2, "dispatched")]).body).toMatchObject({ error: "DRAFT_INVALID" });
  // A held or unconfirmed snapshot cannot be dropped, only returned first.
  expect(invalid([f.snapshot(2, "dispatched")]).body).toMatchObject({ error: "DRAFT_INVALID" });
  expect(invalid([f.snapshot(1)]).body).toMatchObject({ error: "DRAFT_INVALID" });
  // A dispatched one never goes back to held, and a new one is never returned.
  expect(invalid([f.snapshot(1), f.snapshot(2, "held")]).body).toMatchObject({ error: "DRAFT_INVALID" });
  expect(invalid([f.snapshot(1), f.snapshot(2, "dispatched"), f.snapshot(3, "returned")]).body).toMatchObject({ error: "DRAFT_INVALID" });
  // The single-slot field and the list are not combined.
  expect(f.refuse(() => f.save("draft-ithaca", { snapshots: [f.snapshot(1), f.snapshot(2, "dispatched")], outgoing: null })).body).toMatchObject({ error: "DRAFT_INVALID" });
  // A draft delete never drops one that is still waiting.
  const pending = f.refuse(() => f.store.remove(f.owner, "draft-ithaca", f.revisions.get("draft-ithaca")!));
  expect(pending.body).toMatchObject({ error: "DRAFT_OUTGOING_PENDING" });
  expect(f.store.get(f.owner, "draft-ithaca").snapshots).toHaveLength(2);
});

test("acceptance releases only the matching snapshot and moves its files to the message", () => {
  const f = fixture();
  const fees = storeOriginal(f.dir, f.store, f.owner, "draft-ithaca", "harbour-fees.txt", "Two oxen\n");
  const crew = storeOriginal(f.dir, f.store, f.owner, "draft-ithaca", "crew-list.txt", "Eurylochus\n");
  f.save("draft-ithaca", { snapshots: [f.snapshot(1, "dispatched", [fees.fileId]), f.snapshot(2, "held", [crew.fileId])] });
  const revision = f.save("draft-ithaca", { snapshots: [f.snapshot(1, "dispatched", [fees.fileId]), f.snapshot(2, "returned", [crew.fileId])] });
  expect(f.store.accept({ draftRef: { draftId: "draft-ithaca", revision }, sessionId: "voyage-ithaca", resumed: true, requestId: "request-1", principalId: f.owner, fileIds: [fees.fileId] })).toBe("consumed");
  const after = f.store.get(f.owner, "draft-ithaca");
  // The sent revision is consumed, but the other snapshot is not evicted with it.
  expect(after.revision).toBe(revision + 1);
  expect(after.snapshots?.map((s) => s.snapshotId)).toEqual(["snap-2"]);
  expect(f.store.attachmentRef(fees.fileId, "message", "voyage-ithaca")).toBe(true);
  expect(f.store.attachmentRef(fees.fileId, "outgoing", "draft-ithaca")).toBe(false);
  expect(f.store.attachmentRef(crew.fileId, "outgoing", "draft-ithaca")).toBe(true);
  expect(f.store.attachmentRef(crew.fileId, "message", "voyage-ithaca")).toBe(false);
  // With the last snapshot accepted, the draft is a tombstone as before.
  f.revisions.set("draft-ithaca", after.revision);
  f.save("draft-ithaca", { snapshots: [f.snapshot(2, "returned", [crew.fileId]), f.snapshot(3, "dispatched")] });
  f.save("draft-ithaca", { snapshots: [f.snapshot(3, "dispatched")] });
  expect(f.store.accept({ draftRef: { draftId: "draft-ithaca", revision: f.revisions.get("draft-ithaca")! }, sessionId: "voyage-ithaca", resumed: true, requestId: "request-3", principalId: f.owner })).toBe("consumed");
  expect(f.refuse(() => f.store.get(f.owner, "draft-ithaca")).body).toMatchObject({ error: "DRAFT_DELETED" });
});

test("Delete of a returned snapshot starts its files' seven-day clock; Edit keeps them bound", () => {
  const f = fixture();
  const chart = storeOriginal(f.dir, f.store, f.owner, "draft-ithaca", "star-chart.txt", "Pleiades\n");
  const log = storeOriginal(f.dir, f.store, f.owner, "draft-ithaca", "logbook.txt", "Day 3\n");
  f.save("draft-ithaca", { snapshots: [f.snapshot(1, "held", [chart.fileId]), f.snapshot(2, "held", [log.fileId])] });
  f.save("draft-ithaca", { snapshots: [f.snapshot(1, "returned", [chart.fileId]), f.snapshot(2, "returned", [log.fileId])] });
  // Edit: the snapshot moves into an empty composer revision, files and all.
  f.save("draft-ithaca", { text: "Message 2 to Ithaca", fileIds: [log.fileId], snapshots: [f.snapshot(1, "returned", [chart.fileId])] });
  expect(f.store.attachmentRef(log.fileId, "draft", "draft-ithaca")).toBe(true);
  expect(f.store.attachments([log.fileId]).get(log.fileId)?.unreferenced_since).toBeNull();
  // Delete…: the refs go and the clock starts; the file is not unlinked.
  f.tick(5_000);
  f.save("draft-ithaca", { text: "Message 2 to Ithaca", fileIds: [log.fileId], snapshots: [] });
  const row = f.store.attachments([chart.fileId]).get(chart.fileId)!;
  expect(f.store.attachmentReferenced(chart.fileId)).toBe(false);
  expect(row.unreferenced_since).toBe(f.now());
  expect(row.state).toBe("stored");
  expect(f.store.sweepMark()).toEqual([]);
});

test("an all-ready send records a dispatched snapshot, and the composer keeps its own envelope", () => {
  const f = fixture();
  const files = Array.from({ length: 10 }, (_, i) => storeOriginal(f.dir, f.store, f.owner, "draft-ithaca", `oar-${i}.txt`, `oar ${i}\n`));
  const ids = files.map((x) => x.fileId);
  f.save("draft-ithaca", { text: "Ten oars", fileIds: ids });
  // Send: the same save empties the composer and records the dispatched send.
  f.save("draft-ithaca", { text: "", fileIds: [], snapshots: [{ ...f.snapshot(1, "dispatched", ids), text: "Ten oars" }] });
  for (const id of ids) expect(f.store.attachmentRef(id, "outgoing", "draft-ithaca")).toBe(true);
  // The newer composer revision can take a whole envelope of its own.
  storeOriginal(f.dir, f.store, f.owner, "draft-ithaca", "sail.txt", "linen\n");
});

test("the single-slot field keeps working beside the list", () => {
  const f = fixture();
  f.save("draft-ithaca", { snapshots: [f.snapshot(1, "held")] });
  f.save("draft-ithaca", { snapshots: [f.snapshot(1, "returned")] });
  // The old write creates the snapshot of its request…
  f.save("draft-ithaca", { outgoing: { requestId: "request-fees", text: "Fees?", fileIds: [], state: "held" } });
  let draft: Draft = f.store.get(f.owner, "draft-ithaca");
  expect(draft.outgoing).toEqual({ requestId: "request-fees", text: "Fees?", fileIds: [], state: "held" });
  expect(draft.snapshots?.map((s) => [s.snapshotId, s.state])).toEqual([["snap-1", "returned"], ["request-fees", "held"]]);
  // …moves it to dispatched in place…
  f.save("draft-ithaca", { outgoing: { requestId: "request-fees", text: "Fees?", fileIds: [], state: "dispatched" } });
  draft = f.store.get(f.owner, "draft-ithaca");
  expect(draft.outgoing?.state).toBe("dispatched");
  expect(draft.snapshots).toHaveLength(2);
  // …and null removes the one it shows, leaving the rest.
  f.save("draft-ithaca", { outgoing: null });
  draft = f.store.get(f.owner, "draft-ithaca");
  expect(draft).not.toHaveProperty("outgoing");
  expect(draft.snapshots?.map((s) => s.snapshotId)).toEqual(["snap-1"]);
});

test("a single-slot draft saved before the list migrates to its first snapshot", () => {
  const dir = mkdtempSync(join(tmpdir(), "brain-snapshots-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "ui.db");
  let db = createUiDb(path);
  const owner = createPrincipal(db, { authMethod: "password", label: "Odysseus phone", ttlSeconds: 3600 }).id;
  createDraftStore(db).save(owner, "draft-ithaca", { ifMatch: 0, idempotencyKey: "k", sessionId: null, text: "And the crew?", attachmentIds: [] });
  // Put the row back the way migration 077 stored a slot, and re-run 079.
  db.run("ALTER TABLE session_drafts ADD COLUMN outgoing_json TEXT");
  db.run("UPDATE session_drafts SET outgoing_snapshots = '[]', updated_at = 42, outgoing_json = ?", [JSON.stringify({ requestId: "request-fees", text: "Fees?", fileIds: [], state: "held" })]);
  db.run("ALTER TABLE session_drafts DROP COLUMN outgoing_snapshots");
  db.run("DELETE FROM _migrations WHERE filename = '079_outgoing_snapshots.sql'");
  db.close();
  db = createUiDb(path);
  cleanups.push(() => db.close());
  expect(createDraftStore(db).get(owner, "draft-ithaca").snapshots).toEqual([
    { snapshotId: "request-fees", requestId: "request-fees", text: "Fees?", fileIds: [], state: "held", createdAt: 42 },
  ]);
});

test("two devices at nine snapshots save at the same moment: exactly one is admitted", async () => {
  const dir = mkdtempSync(join(tmpdir(), "brain-snapshots-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const t = await httpContractApp({ env: {
    AUTH_MODE: "password", BRAIN_UI_PASSWORD_HASH: "unused-fixture-hash", COOKIE_SECRET: SECRET,
    BRAIN_UI_ALLOW_LOOPBACK_ORIGIN: "1", DB_PATH: join(dir, "ui.db"),
  } });
  cleanups.push(() => t.close());
  const device = async (label: string) => {
    const principal = createPrincipal(t.app.db, { authMethod: "password", label, ttlSeconds: 3600 });
    const cookie = (await generateSignedCookie("brain_ui_session", principal.id, SECRET)).split(";")[0]!;
    return (draftId: string, ifMatch: number, key: string, snapshots: DraftSnapshotWrite[]) => t.fetch(`/api/drafts/${draftId}`, {
      method: "PUT",
      headers: { cookie, origin: "http://localhost", host: "localhost", "content-type": "application/json", "if-match": String(ifMatch), "idempotency-key": key },
      body: JSON.stringify({ sessionId: "voyage-ithaca", text: "", attachmentIds: [], snapshots }),
    });
  };
  const snap = (n: number): DraftSnapshotWrite => ({ snapshotId: `snap-${n}`, requestId: `request-${n}`, text: `Message ${n}`, fileIds: [], state: "held" });
  const phone = await device("Odysseus phone");
  const laptop = await device("Penelope laptop");
  // Each device's draft of the chat holds part of the nine the chat keeps.
  const phoneList = [1, 2, 3, 4, 5].map(snap);
  const laptopList = [6, 7, 8, 9].map(snap);
  expect((await phone("draft-phone", 0, "p1", phoneList)).status).toBe(200);
  expect((await laptop("draft-laptop", 0, "l1", laptopList)).status).toBe(200);
  const [a, b] = await Promise.all([
    phone("draft-phone", 1, "p2", [...phoneList, snap(10)]),
    laptop("draft-laptop", 1, "l2", [...laptopList, snap(11)]),
  ]);
  expect([a.status, b.status].sort()).toEqual([200, 409]);
  const refused = a.status === 409 ? a : b;
  expect(await refused.json()).toMatchObject({ error: "DRAFT_OUTGOING_FULL", limit: 10 });
  const total = (t.app.db.query("SELECT SUM(json_array_length(outgoing_snapshots)) AS n FROM session_drafts WHERE session_id = 'voyage-ithaca'").get() as { n: number }).n;
  expect(total).toBe(10);
});
