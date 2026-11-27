import { afterEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import type { SessionDraftLimits } from "@schlessera/brain-ui-sdk/protocol";

import { createUiDb } from "../src/db/client";
import { createPrincipal } from "../src/db/principals";
import { createDraftStore, DraftError, draftPreview, hasImageSignature } from "../src/drafts/store";
import { queryPlan, recordStatements } from "./helpers/statement-recorder";

const dbs: Database[] = [];
afterEach(() => { for (const db of dbs.splice(0)) db.close(); });

function setup(limits?: Partial<SessionDraftLimits>) {
  const db = createUiDb(":memory:");
  dbs.push(db);
  let clock = 1_000_000;
  const store = createDraftStore(db, { now: () => clock, ...(limits ? { limits } : {}) });
  const owner = createPrincipal(db, { authMethod: "password", label: "Odysseus phone", ttlSeconds: 365 * 24 * 3600 }).id;
  return { db, store, owner, advance: (ms: number) => { clock += ms; } };
}

const png = (fill: number, size = 32) => {
  const bytes = new Uint8Array(size).fill(fill);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return bytes;
};

function refusal(fn: () => unknown): DraftError {
  try { fn(); } catch (error) { if (error instanceof DraftError) return error; throw error; }
  throw new Error("expected a refusal");
}

test("total host capacity refuses an upload or a growing save without dropping stored content", () => {
  const { store, owner, db } = setup({ maxTotalBytes: 100 });
  const { attachmentId } = store.upload(owner, "draft-a", { idempotencyKey: "u1", mime: "image/png", name: null, bytes: png(1, 60) });
  store.save(owner, "draft-a", { ifMatch: 0, idempotencyKey: "s1", sessionId: null, text: "oar", attachmentIds: [attachmentId] });
  const upload = refusal(() => store.upload(owner, "draft-b", { idempotencyKey: "u2", mime: "image/png", name: null, bytes: png(2, 60) }));
  expect([upload.status, upload.body]).toEqual([507, expect.objectContaining({ error: "DRAFT_CAPACITY", limit: 100, bound: "total" })]);
  const grow = refusal(() => store.save(owner, "draft-a", { ifMatch: 1, idempotencyKey: "s2", sessionId: null, text: "o".repeat(50), attachmentIds: [attachmentId] }));
  expect(grow.status).toBe(507);
  // Shrinking is always allowed, and the refused attempts changed nothing.
  expect(store.get(owner, "draft-a")).toMatchObject({ revision: 1, text: "oar" });
  expect(store.save(owner, "draft-a", { ifMatch: 1, idempotencyKey: "s3", sessionId: null, text: "o", attachmentIds: [attachmentId] })).toMatchObject({ revision: 2 });
  expect((db.query("SELECT COUNT(*) AS n FROM session_draft_attachments").get() as { n: number }).n).toBe(1);
});

test("a save that drops an image to make room for text is measured after the drop", () => {
  const { store, owner } = setup({ maxTotalBytes: 100 });
  const { attachmentId } = store.upload(owner, "draft-a", { idempotencyKey: "u1", mime: "image/png", name: null, bytes: png(1, 90) });
  store.save(owner, "draft-a", { ifMatch: 0, idempotencyKey: "s1", sessionId: null, text: "o", attachmentIds: [attachmentId] });
  expect(store.save(owner, "draft-a", { ifMatch: 1, idempotencyKey: "s2", sessionId: null, text: "o".repeat(20), attachmentIds: [] })).toMatchObject({ revision: 2 });
  // Growth past the limit is still refused once the image is gone.
  const error = refusal(() => store.save(owner, "draft-a", { ifMatch: 2, idempotencyKey: "s3", sessionId: null, text: "o".repeat(101), attachmentIds: [] }));
  expect(error.body).toMatchObject({ error: "DRAFT_CAPACITY", bound: "total" });
});

test("per-draft byte bound counts text and images together", () => {
  const { store, owner } = setup({ maxDraftBytes: 50 });
  const { attachmentId } = store.upload(owner, "draft-a", { idempotencyKey: "u1", mime: "image/png", name: null, bytes: png(1, 40) });
  const error = refusal(() => store.save(owner, "draft-a", { ifMatch: 0, idempotencyKey: "s1", sessionId: null, text: "x".repeat(11), attachmentIds: [attachmentId] }));
  expect(error.body).toMatchObject({ error: "DRAFT_TOO_LARGE", limit: 50, bound: "draft" });
  expect(store.save(owner, "draft-a", { ifMatch: 0, idempotencyKey: "s2", sessionId: null, text: "x".repeat(10), attachmentIds: [attachmentId] })).toMatchObject({ revision: 1 });
});

test("a dropped image is deleted with its revision; an unlisted upload waits an hour, then is swept", () => {
  const { store, owner, db, advance } = setup();
  const one = store.upload(owner, "draft-a", { idempotencyKey: "u1", mime: "image/png", name: "one.png", bytes: png(1) }).attachmentId;
  const two = store.upload(owner, "draft-a", { idempotencyKey: "u2", mime: "image/png", name: "two.png", bytes: png(2) }).attachmentId;
  store.save(owner, "draft-a", { ifMatch: 0, idempotencyKey: "s1", sessionId: null, text: "", attachmentIds: [one, two] });
  const pending = store.upload(owner, "draft-a", { idempotencyKey: "u3", mime: "image/png", name: null, bytes: png(3) }).attachmentId;
  store.save(owner, "draft-a", { ifMatch: 1, idempotencyKey: "s2", sessionId: null, text: "", attachmentIds: [two] });
  const ids = () => (db.query("SELECT attachment_id AS id FROM session_draft_attachments ORDER BY created_at, attachment_id").all() as Array<{ id: string }>).map((r) => r.id).sort();
  expect(ids()).toEqual([two, pending].sort());
  expect(store.get(owner, "draft-a").attachments.map((a) => a.name)).toEqual(["two.png"]);
  advance(60 * 60 * 1_000 + 1);
  store.save(owner, "draft-a", { ifMatch: 2, idempotencyKey: "s3", sessionId: null, text: "Ithaca", attachmentIds: [two] });
  expect(ids()).toEqual([two]);
});

test("an upload receipt replays its id; a different image under the same key is refused", () => {
  const { store, owner } = setup();
  const first = store.upload(owner, "draft-a", { idempotencyKey: "u1", mime: "image/png", name: null, bytes: png(1) });
  expect(store.upload(owner, "draft-a", { idempotencyKey: "u1", mime: "image/png", name: null, bytes: png(1) })).toEqual(first);
  expect(refusal(() => store.upload(owner, "draft-a", { idempotencyKey: "u1", mime: "image/png", name: null, bytes: png(9) })).body)
    .toMatchObject({ error: "DRAFT_KEY_REUSED" });
});

test("an upload retried after its bytes were swept stores them again under a usable id", () => {
  const { store, owner, advance } = setup();
  const first = store.upload(owner, "draft-a", { idempotencyKey: "u1", mime: "image/png", name: null, bytes: png(1) });
  advance(60 * 60 * 1_000 + 1);
  const retried = store.upload(owner, "draft-a", { idempotencyKey: "u1", mime: "image/png", name: null, bytes: png(1) });
  expect(retried.attachmentId).not.toBe(first.attachmentId);
  expect(store.save(owner, "draft-a", { ifMatch: 0, idempotencyKey: "s1", sessionId: null, text: "", attachmentIds: [retried.attachmentId] })).toMatchObject({ revision: 1 });
  expect(store.upload(owner, "draft-a", { idempotencyKey: "u1", mime: "image/png", name: null, bytes: png(1) })).toEqual(retried);
});

test("acceptance consumes only a matching, current, same-session revision", () => {
  const { store, owner } = setup();
  store.save(owner, "bound", { ifMatch: 0, idempotencyKey: "s", sessionId: "voyage-1", text: "Sirens", attachmentIds: [] });
  store.save(owner, "unbound", { ifMatch: 0, idempotencyKey: "s", sessionId: null, text: "Cyclops", attachmentIds: [] });
  expect(store.accept({ draftRef: { draftId: "bound", revision: 1 }, sessionId: "voyage-2", resumed: true, principalId: owner })).toBe("kept");
  expect(store.accept({ draftRef: { draftId: "bound", revision: 1 }, sessionId: "voyage-1", resumed: false, principalId: owner })).toBe("kept");
  expect(store.accept({ draftRef: { draftId: "unbound", revision: 1 }, sessionId: "voyage-1", resumed: true, principalId: owner })).toBe("kept");
  expect(store.accept({ draftRef: { draftId: "bound", revision: 2 }, sessionId: "voyage-1", resumed: true, principalId: owner })).toBe("kept");
  expect(store.accept({ draftRef: { draftId: "bound", revision: 1 }, sessionId: "voyage-1", resumed: true, principalId: owner })).toBe("consumed");
  expect(store.accept({ draftRef: { draftId: "bound", revision: 1 }, sessionId: "voyage-1", resumed: true, principalId: owner })).toBe("kept");
  expect(store.accept({ draftRef: { draftId: "unbound", revision: 1 }, sessionId: "voyage-3", resumed: false, requestId: "r", principalId: owner })).toBe("consumed");
  expect(refusal(() => store.get(owner, "bound")).body).toMatchObject({ error: "DRAFT_DELETED", tombstoneRevision: 2 });
});

test("a revoked sender's acceptance consumes nothing", () => {
  const { store, owner, db } = setup();
  store.save(owner, "draft-a", { ifMatch: 0, idempotencyKey: "s", sessionId: null, text: "Ithaca", attachmentIds: [] });
  db.query("UPDATE principals SET revoked_at = 1 WHERE id = ?").run(owner);
  expect(store.accept({ draftRef: { draftId: "draft-a", revision: 1 }, sessionId: "voyage-1", resumed: false, requestId: "r", principalId: owner })).toBe("unauthorized");
  expect(db.query("SELECT revision, deleted_at FROM session_drafts").get()).toEqual({ revision: 1, deleted_at: null });
});

test("previews and image signatures", () => {
  expect(draftPreview("\n  \n  Odysseus\nsecond")).toBe("Odysseus");
  expect(draftPreview("𝔒".repeat(300))).toHaveLength(400);
  expect(hasImageSignature("image/png", png(1))).toBe(true);
  expect(hasImageSignature("image/jpeg", png(1))).toBe(false);
  expect(hasImageSignature("image/gif", new TextEncoder().encode("GIF89a...."))).toBe(true);
  expect(hasImageSignature("image/webp", new TextEncoder().encode("RIFF\u0000\u0000\u0000\u0000WEBPVP8 "))).toBe(true);
});


test("provisional dialogue adoption consumes the exact draft and moves only newer edits with its chat",()=>{
 const {store,owner}=setup();
 const save=(id:string,revision:number,text:string)=>store.save(owner,id,{ifMatch:revision,idempotencyKey:`${id}-${revision}`,sessionId:"dialogue:ithaca",text,attachmentIds:[]});
 save("current",0,"Find the mast.");save("newer",0,"Find the sail.");save("newer",1,"And the departure note.");
 expect(store.accept({draftRef:{draftId:"current",revision:1},sessionId:"voyage",resumed:false,requestId:"wrong",principalId:owner})).toBe("kept");
 expect(store.accept({draftRef:{draftId:"current",revision:1},sessionId:"voyage",sourceSessionId:"dialogue:ithaca",resumed:false,requestId:"first",principalId:owner})).toBe("consumed");
 expect(store.accept({draftRef:{draftId:"newer",revision:1},sessionId:"voyage",sourceSessionId:"dialogue:ithaca",resumed:false,requestId:"second",principalId:owner})).toBe("kept");
 expect(store.get(owner,"newer")).toMatchObject({sessionId:"voyage",text:"And the departure note.",revision:3});
});

/** Whether a statement's bytecode reads `column` from `table`'s rows (not from one of its indexes). */
function readsColumn(db: Database, sql: string, table: string, column: string) {
  const { rootpage } = db.query("SELECT rootpage FROM sqlite_schema WHERE type = 'table' AND name = ?").get(table) as { rootpage: number };
  const { cid } = db.query("SELECT cid FROM pragma_table_info(?) WHERE name = ?").get(table, column) as { cid: number };
  const program = db.prepare(`EXPLAIN ${sql}`);
  try {
    const steps = program.all() as Array<{ opcode: string; p1: number; p2: number }>;
    const cursors = new Set(steps.filter(step => step.opcode === "OpenRead" && step.p2 === rootpage).map(step => step.p1));
    return steps.some(step => step.opcode === "Column" && cursors.has(step.p1) && step.p2 === cid);
  } finally { program.finalize(); }
}

test("draft byte totals read sizes from the covering index, never the rows that hold the image BLOBs (#4803)", () => {
  const { db, owner } = setup();
  const recorded = recordStatements(db), store = createDraftStore(recorded.db, { now: () => 1_000_000 });
  store.upload(owner, "draft-a", { idempotencyKey: "u1", mime: "image/png", name: null, bytes: png(1, 64) });
  const totals = [...new Set(recorded.statements.map(statement => statement.sql).filter(sql => sql.includes("SUM(size_bytes), 0) FROM session_draft_attachments")))];
  expect(totals).toHaveLength(2);
  const plans = totals.map(sql => queryPlan(db, { sql, params: [] }).filter(step => /\bsession_draft_attachments\b/.test(step)));
  expect(plans).toEqual(totals.map(() => ["SCAN session_draft_attachments USING COVERING INDEX session_draft_attachments_sizes"]));
});

test("saving new text to a draft with two images reads no image bytes, and the images still read back (#4803)", () => {
  const { db, owner } = setup();
  const recorded = recordStatements(db), store = createDraftStore(recorded.db, { now: () => 1_000_000 });
  const images = [png(7, 48), png(9, 80)];
  const ids = images.map((bytes, i) => store.upload(owner, "draft-a", { idempotencyKey: `u${i}`, mime: "image/png", name: `shroud-${i}.png`, bytes }).attachmentId);
  store.save(owner, "draft-a", { ifMatch: 0, idempotencyKey: "s1", sessionId: null, text: "weave", attachmentIds: ids });
  recorded.statements.length = 0;
  expect(store.save(owner, "draft-a", { ifMatch: 1, idempotencyKey: "s2", sessionId: null, text: "weave and unweave", attachmentIds: ids })).toMatchObject({ revision: 2 });
  const selects = [...new Set(recorded.statements.map(statement => statement.sql).filter(sql => /^\s*SELECT\b/i.test(sql)))];
  expect(selects.some(sql => sql.includes("FROM session_draft_attachments"))).toBe(true);
  expect(selects.filter(sql => readsColumn(db, sql, "session_draft_attachments", "bytes"))).toEqual([]);
  expect(store.get(owner, "draft-a")?.attachments.map(a => [a.attachmentId, a.name, a.bytes])).toEqual(
    ids.map((id, i) => [id, `shroud-${i}.png`, Buffer.from(images[i]!).toString("base64")]));
});
