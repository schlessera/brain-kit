import { afterEach, beforeEach, expect, test, vi } from "bun:test";
import type { AttachmentFile, Draft, DraftSaveRequest, ServerMessage } from "@schlessera/brain-ui-sdk/protocol";
import { createBrainUiRoot, type BrainUiRoot } from "../src/root.ts";
import { createDraftClient } from "../src/lib/draft-client.ts";
import type { DraftApi, DraftCallResult } from "../src/lib/draft-api.ts";
import { draftIndicatorView } from "../src/lib/draft-indicator.ts";
import { GONE_LINEAGE, holdsUnsaved, type ComposerDraft } from "../src/stores/draft-state.ts";
import { parseDraft, storeDraft } from "../src/lib/local-work.ts";
import type { PendingAttachment } from "../src/lib/image-attachments.ts";

// A save the host refuses with a 400 it will give again (#4566): the client
// does not send the same edit again and again, a draft holding only
// originals it cannot bind is not saved as empty, and an original the host
// no longer stores is left out so the next save goes through. Odysseus
// fixtures, an in-memory host that keeps the server's 400 rules, no network.

const roots: BrainUiRoot[] = [];
const clients: { dispose(): void }[] = [];
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => {
  try {
    for (const c of clients.splice(0)) c.dispose();
    for (const r of roots.splice(0)) r.dispose();
  } finally { vi.useRealTimers(); }
});

const SESSION = "odysseus-ithaca";
function original(fileId: string, name: string): AttachmentFile {
  return { fileId, name, path: `.brain-ui/attachments/${fileId}/${name}`, mediaType: "application/pdf", bytes: 2_400_000, sha256: "b".repeat(64), kind: "pdf", reader: "pdf" };
}
const PERMIT = original("2c7e1a90-5d3f-4b8e-a1c6-9f0d2e4b7a31", "ithaca-permit.pdf");
const CREW = original("7a1f3c5e-2b4d-4e6f-8a0c-1d3e5f7a9b20", "crew-list.pdf");
/** Past every backoff step (2+4+8+16+30+60 s) twice over: long enough for a loop to show. */
const LONG = 400_000;
const SAVE_DELAY = 800;
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
async function run(ms: number) {
  for (let left = ms; left > 0; left -= 1_000) { vi.advanceTimersByTime(Math.min(1_000, left)); await turn(); await turn(); }
}

type Refusal = { status: 400 | 507; body: { error: string; message: string; limit?: number; bound?: string } };
/**
 * An in-memory host. `refuse` answers a save body with the host's own 400,
 * or null to store it; by default it is the server's empty-draft rule
 * (`packages/ui-server/src/drafts/store.ts`).
 */
function scene(options: { refuse?: (body: DraftSaveRequest) => Refusal | null; snapshots?: boolean; remove?: () => Promise<DraftCallResult<null>> } = {}) {
  const saves: { draftId: string; body: DraftSaveRequest }[] = [];
  let uploads = 0;
  let removes = 0;
  const rows = new Map<string, Draft>();
  const rowsSnapshots = new Map<string, NonNullable<DraftSaveRequest["snapshots"]>>();
  const swept = new Set<string>();
  /** Reads that get no answer before the host answers again. */
  let silentGets = 0;
  let getStatus = 503;
  let getCount = 0;
  /** While set, every read waits for it. */
  let getGate: Promise<void> | null = null;
  let saveGate: Promise<void> | null = null;
  const empty = (body: DraftSaveRequest): Refusal | null =>
    body.text.length === 0 && body.attachmentIds.length === 0 && (body.fileIds?.length ?? 0) === 0 && (body.snapshots?.length ?? 0) === 0
      ? { status: 400, body: { error: "DRAFT_INVALID", message: "An empty draft is deleted, not saved." } } : null;
  const gone = (body: DraftSaveRequest): Refusal | null =>
    (body.fileIds ?? []).some((id) => swept.has(id)) ? { status: 400, body: { error: "ATTACHMENT_INVALID", message: "A file is no longer available; upload it again." } } : null;
  const refuse = options.refuse ?? ((body) => empty(body) ?? gone(body));
  const api: DraftApi = {
    list: async () => ({ ok: true, value: { drafts: [...rows.values()].map((r) => ({ draftId: r.draftId, sessionId: r.sessionId, revision: r.revision, updatedAt: r.updatedAt, preview: r.text, attachmentCount: 0 })) } }),
    get: async (draftId) => {
      getCount++;
      // The answer is what the host held when the read arrived, however late it lands.
      const row = rows.get(draftId);
      if (getGate) await getGate;
      if (silentGets > 0) { silentGets--; return { ok: false, status: getStatus, body: {} }; }
      if (!row) return { ok: false, status: 404, body: { error: "DRAFT_NOT_FOUND" } };
      // The host's draft lists only the originals it still stores.
      return { ok: true, value: { ...row, ...(row.files ? { files: row.files.filter((f) => !swept.has(f.fileId)) } : {}) } };
    },
    save: async (draftId, ifMatch, _key, body): Promise<DraftCallResult<{ revision: number; updatedAt: number }>> => {
      saves.push({ draftId, body });
      if (saveGate) await saveGate;
      const refused = refuse(body);
      if (refused) return { ok: false, ...refused };
      const row = rows.get(draftId);
      if ((row?.revision ?? 0) !== ifMatch) return { ok: false, status: 409, body: { error: "DRAFT_CONFLICT" } };
      const revision = ifMatch + 1;
      const files = (body.fileIds ?? []).map((id) => [PERMIT, CREW].find((f) => f.fileId === id)!);
      if ((body.snapshots?.length ?? 0) > 0) rowsSnapshots.set(draftId, body.snapshots!);
      rows.set(draftId, { draftId, sessionId: body.sessionId, revision, updatedAt: 1_000 + revision, text: body.text, attachments: [], ...(body.fileIds ? { files } : {}) });
      return { ok: true, value: { revision, updatedAt: 1_000 + revision } };
    },
    upload: async () => ({ ok: true, value: { attachmentId: `att-${++uploads}` } }),
    remove: options.remove ?? (async () => { removes++; return { ok: true, value: null }; }),
    bind: async () => ({ ok: false, status: 404, body: {} }),
  };
  // The root's own draft client shares this store; its requests never answer,
  // so only this scene's client (and its fixture host) writes save outcomes.
  const ui = createBrainUiRoot({ storage: null, request: () => new Promise<Response>(() => {}) });
  roots.push(ui);
  const client = createDraftClient(ui, { send: () => true, api });
  clients.push(client);
  const hello = { type: "server_hello", protocolRev: 5, capabilities: { sessionDrafts: true, chatRequestAck: true, composerFiles: true },
    attachmentLimits: { maxFiles: 10, maxFileBytes: 25_000_000, maxTotalBytes: 50_000_000, poolBytes: 1_073_741_824 },
    ...(options.snapshots ? { sessionDraftLimits: { maxDrafts: 100, maxDraftBytes: 1_000_000, maxOutgoingSnapshots: 10 } } : {}),
  } as Extract<ServerMessage, { type: "server_hello" }>;
  client.hello(hello);
  const drafts = ui.stores.drafts;
  const id = drafts.getState().idFor(SESSION);
  const indicator = (draftId: string) => draftIndicatorView({ draft: drafts.getState().drafts[draftId], store: drafts.getState(), queued: [], online: true });
  return { ui, client, drafts, id, saves, rows, swept, indicator, reconnect: () => client.hello(hello), withoutDrafts: () => client.hello({ ...hello, capabilities: { ...hello.capabilities, sessionDrafts: false } }), silenceGets: (n: number) => { silentGets = n; getStatus = 503; },
    failGets: (status: number, n: number) => { silentGets = n; getStatus = status; }, gets: () => getCount, removes: () => removes,
    holdSaves: () => { let open!: () => void; saveGate = new Promise<void>((resolve) => { open = resolve; }); return () => { saveGate = null; open(); }; },
    holdGets: () => { let open!: () => void; getGate = new Promise<void>((resolve) => { open = resolve; }); return () => { getGate = null; open(); }; } };
}

test("a draft holding only originals of another draft id is never saved as empty, and says to choose them again", async () => {
  const s = scene();
  s.drafts.getState().edit(s.id, SESSION, { files: [{ file: CREW, lineage: "a-rotated-away-draft" }] });
  await run(LONG);
  s.reconnect();
  await run(LONG);
  expect(s.saves, "NO_EMPTY_SAVE_FOR_CARRIED_FILES").toEqual([]);
  expect(s.indicator(s.id)).toMatchObject({ key: "detached", summary: "Not saved yet: 1 file isn't attached to this draft. Remove or choose it again." });
  // Content this id can save makes it owed again: one save, of the text only.
  s.drafts.getState().edit(s.id, SESSION, { text: "Crew for the Ithaca crossing" });
  await run(SAVE_DELAY + 100);
  expect(s.saves.map((x) => x.body)).toEqual([{ sessionId: SESSION, text: "Crew for the Ithaca crossing", attachmentIds: [] }]);
});

test("a dirty draft rotated off a gone id keeps its originals' lineage and is not saved as empty", async () => {
  const s = scene();
  s.drafts.getState().edit(s.id, SESSION, { files: [{ file: PERMIT, lineage: s.id }] });
  await run(SAVE_DELAY + 100);
  expect(s.saves).toHaveLength(1);
  // Dirty again, then deleted elsewhere: the content moves to a new id.
  s.drafts.getState().edit(s.id, SESSION, { files: [{ file: PERMIT, lineage: s.id }, { file: CREW, lineage: s.id }] });
  s.drafts.getState().hostGone(s.id);
  const next = s.drafts.getState().resolveId(s.id);
  expect(next).not.toBe(s.id);
  const before = s.saves.length;
  await run(LONG);
  expect(s.saves.slice(before), "NO_EMPTY_SAVE_AFTER_ROTATION").toEqual([]);
  expect(s.indicator(next)).toMatchObject({ key: "detached" });
});

test("an unrecognised 400 is not sent again for the same edit, shows a refusal, and a new edit is tried again", async () => {
  let refusing = true;
  const s = scene({ refuse: () => (refusing ? { status: 400, body: { error: "DRAFT_INVALID", message: "The draft names an unknown field." } } : null) });
  s.drafts.getState().edit(s.id, SESSION, { text: "Ask Penelope about the loom" });
  await run(LONG);
  s.reconnect();
  await run(LONG);
  expect(s.saves.length, "REFUSED_EDIT_BOUNDED").toBeLessThanOrEqual(2);
  expect(s.saves.length).toBeGreaterThanOrEqual(1);
  expect(new Set(s.saves.map((x) => JSON.stringify(x.body))).size).toBe(1);
  const d = s.drafts.getState().drafts[s.id] as ComposerDraft;
  expect(d.failure).toEqual({ kind: "refused", edit: d.edit, reason: "The draft names an unknown field." });
  expect(s.indicator(s.id)).toMatchObject({ key: "refused", state: "refused", stateLabel: "Draft not saved: the brain refused it",
    facts: [{ key: "Brain said", value: "The draft names an unknown field." }] });
  // A new edit is new content: it is eligible again, and saved once the host takes it.
  refusing = false;
  const before = s.saves.length;
  s.drafts.getState().edit(s.id, SESSION, { text: "Ask Penelope about the loom tonight" });
  await run(SAVE_DELAY + 100);
  expect(s.saves.length).toBe(before + 1);
  expect(s.indicator(s.id)).toMatchObject({ key: "saved" });
});

test("a refused snapshot list is read and saved again once, then not sent again", async () => {
  const s = scene({ snapshots: true, refuse: (body) => (body.snapshots?.length ? { status: 400, body: { error: "DRAFT_INVALID", message: "A dispatched snapshot cannot become held." } } : null) });
  s.drafts.getState().edit(s.id, SESSION, { text: "Muster the crew" });
  await run(SAVE_DELAY + 100);
  expect(s.saves).toHaveLength(1);
  const message = { type: "chat_message" as const, text: "Muster the crew", sessionId: SESSION, requestId: "req-muster" };
  s.drafts.getState().createSnapshot(s.id, SESSION, { snapshotId: "snap-muster", requestId: "req-muster", text: "Muster the crew", files: [], state: "held", createdAt: null, message }, "Muster the crew");
  await run(LONG);
  s.reconnect();
  await run(LONG);
  const listed = s.saves.filter((x) => x.body.snapshots?.length);
  expect(listed.length, "REFUSED_LIST_BOUNDED").toBe(2);
  expect(s.drafts.getState().drafts[s.id]?.failure).toMatchObject({ kind: "refused" });
  // The composer is empty after Send: the refusal still shows (#4566).
  expect(s.indicator(s.id), "REFUSED_SHOWN_OVER_EMPTY_COMPOSER").toMatchObject({ key: "refused", facts: [{ key: "Brain said", value: "A dispatched snapshot cannot become held." }] });
});

test("an original the host no longer stores is left out, reads as choose again, and the next save succeeds", async () => {
  const s = scene();
  s.drafts.getState().edit(s.id, SESSION, { text: "Harbour fees", files: [{ file: PERMIT, lineage: s.id }] });
  await run(SAVE_DELAY + 100);
  expect(s.saves.at(-1)!.body.fileIds).toEqual([PERMIT.fileId]);
  expect(s.drafts.getState().drafts[s.id]?.host?.revision).toBe(1);
  // The host sweeps the original; the next edit's save lists it.
  s.swept.add(PERMIT.fileId);
  s.drafts.getState().edit(s.id, SESSION, { text: "Harbour fees for the permit" });
  await run(LONG);
  const refused = s.saves.filter((x) => x.body.fileIds?.includes(PERMIT.fileId)).length;
  expect(refused, "the swept original is sent once more, then left out").toBe(2);
  expect(s.saves.at(-1)!.body, "FILE_GONE_DROPPED").toEqual({ sessionId: SESSION, text: "Harbour fees for the permit", attachmentIds: [], fileIds: [] });
  const d = s.drafts.getState().drafts[s.id]!;
  expect(d.host?.revision).toBe(2);
  expect(d.files).toEqual([{ file: PERMIT, lineage: GONE_LINEAGE }]);
  expect(s.indicator(s.id)).toMatchObject({ key: "detached", facts: [{ key: "Not attached", value: "ithaca-permit.pdf" }] });
});

test("an original never bound and not stored for this draft is left out too", async () => {
  const s = scene();
  s.swept.add(CREW.fileId);
  s.drafts.getState().edit(s.id, SESSION, { text: "Crew list", files: [{ file: CREW, lineage: s.id }] });
  await run(LONG);
  expect(s.saves.at(-1)!.body).toEqual({ sessionId: SESSION, text: "Crew list", attachmentIds: [] });
  expect(s.drafts.getState().drafts[s.id]?.host?.revision).toBe(1);
  expect(s.saves.length).toBe(2);
});

test("a Send whose first save is refused keeps its message: a draft the host never stored is not read as deleted", async () => {
  const s = scene({ snapshots: true, refuse: (body) => (body.snapshots?.length ? { status: 400, body: { error: "DRAFT_INVALID", message: "A new snapshot is held or dispatched." } } : null) });
  const message = { type: "chat_message" as const, text: "Muster the crew", sessionId: SESSION, requestId: "req-first" };
  s.drafts.getState().createSnapshot(s.id, SESSION, { snapshotId: "snap-first", requestId: "req-first", text: "Muster the crew", files: [], state: "held", createdAt: null, message }, "");
  await run(LONG);
  const d = s.drafts.getState().drafts[s.id];
  expect(d?.snapshots?.map((x) => x.text), "FIRST_SAVE_SNAPSHOT_KEPT").toEqual(["Muster the crew"]);
  expect(d?.failure).toMatchObject({ kind: "refused" });
  expect(s.saves.length, "bounded").toBeLessThanOrEqual(2);
});

test("a delete's late 400 refuses only the emptied edit: text typed while it was out is still saved", async () => {
  let answer!: (result: DraftCallResult<null>) => void;
  const s = scene({ remove: () => new Promise((resolve) => { answer = resolve; }) });
  s.drafts.getState().edit(s.id, SESSION, { text: "Ask Penelope" });
  await run(SAVE_DELAY + 100);
  expect(s.saves).toHaveLength(1);
  s.drafts.getState().edit(s.id, SESSION, { text: "" });
  await run(SAVE_DELAY + 100);
  // Typed again while the delete is out; then the host refuses the delete.
  s.drafts.getState().edit(s.id, SESSION, { text: "Ask Telemachus instead" });
  answer({ ok: false, status: 400, body: { error: "DRAFT_INVALID", message: "Not this revision." } });
  await run(LONG);
  expect(s.saves.map((x) => x.body.text), "DELETE_400_SPARES_NEW_EDIT").toContain("Ask Telemachus instead");
});

test("a read that gets no answer does not use up the file recovery", async () => {
  const s = scene();
  s.drafts.getState().edit(s.id, SESSION, { text: "Harbour fees", files: [{ file: PERMIT, lineage: s.id }] });
  await run(SAVE_DELAY + 100);
  s.swept.add(PERMIT.fileId);
  s.silenceGets(1);
  s.drafts.getState().edit(s.id, SESSION, { text: "Harbour fees for the permit" });
  await run(LONG);
  expect(s.saves.at(-1)!.body, "TRANSIENT_READ_KEEPS_RECOVERY").toEqual({ sessionId: SESSION, text: "Harbour fees for the permit", attachmentIds: [], fileIds: [] });
  expect(s.drafts.getState().drafts[s.id]?.failure).toBeNull();
});

test("while the recovery read gets no answer, the read is retried and the refused body is never sent again", async () => {
  const s = scene();
  s.drafts.getState().edit(s.id, SESSION, { text: "Harbour fees", files: [{ file: PERMIT, lineage: s.id }] });
  await run(SAVE_DELAY + 100);
  s.swept.add(PERMIT.fileId);
  s.silenceGets(1_000);
  const before = s.saves.length;
  s.drafts.getState().edit(s.id, SESSION, { text: "Harbour fees for the permit" });
  await run(LONG);
  await run(LONG);
  expect(s.saves.slice(before).map((x) => x.body.fileIds), "REFUSED_BODY_NOT_RESENT").toEqual([[PERMIT.fileId]]);
  // Reads answer again: the recovery completes and the edit is saved without the gone original.
  s.silenceGets(0);
  await run(LONG);
  expect(s.saves.at(-1)!.body).toEqual({ sessionId: SESSION, text: "Harbour fees for the permit", attachmentIds: [], fileIds: [] });
  expect(s.drafts.getState().drafts[s.id]?.failure).toBeNull();
});

test("two stale originals, one bound before and one new, are both left out", async () => {
  const s = scene();
  s.drafts.getState().edit(s.id, SESSION, { text: "Harbour fees", files: [{ file: PERMIT, lineage: s.id }] });
  await run(SAVE_DELAY + 100);
  s.swept.add(PERMIT.fileId);
  s.swept.add(CREW.fileId);
  s.drafts.getState().edit(s.id, SESSION, { text: "Harbour fees and crew", files: [{ file: PERMIT, lineage: s.id }, { file: CREW, lineage: s.id }] });
  await run(LONG);
  const d = s.drafts.getState().drafts[s.id]!;
  expect(d.failure, "BOTH_STALE_LEFT_OUT").toBeNull();
  expect(d.files?.map((f) => f.lineage)).toEqual([GONE_LINEAGE, GONE_LINEAGE]);
  expect(s.saves.at(-1)!.body).toEqual({ sessionId: SESSION, text: "Harbour fees and crew", attachmentIds: [], fileIds: [] });
});

test("no save goes out while a refused snapshot list is read again, and the corrected draft is saved", async () => {
  let refusals = 1;
  let moved = () => {};
  // The host refuses the list because its own moved on (a revision this tab has not seen): only a
  // save over the re-read revision can succeed, so an identical retry would fail.
  const s = scene({ snapshots: true, refuse: (body) => (body.snapshots?.length && refusals-- > 0 ? (moved(), { status: 400, body: { error: "DRAFT_INVALID", message: "A dispatched snapshot cannot become held." } }) : null) });
  moved = () => { const r = s.rows.get(s.id)!; s.rows.set(s.id, { ...r, revision: r.revision + 1 }); };
  s.drafts.getState().edit(s.id, SESSION, { text: "Muster the crew" });
  await run(SAVE_DELAY + 100);
  const release = s.holdGets();
  const message = { type: "chat_message" as const, text: "Muster the crew", sessionId: SESSION, requestId: "req-muster" };
  s.drafts.getState().createSnapshot(s.id, SESSION, { snapshotId: "snap-muster", requestId: "req-muster", text: "Muster the crew", files: [], state: "held", createdAt: null, message }, "Muster the crew");
  s.drafts.getState().edit(s.id, SESSION, { text: "Then sail" });
  await run(LONG);
  expect(s.saves.filter((x) => x.body.snapshots?.length).length, "RECONCILE_HOLDS_SAVES").toBe(1);
  const held = s.saves.length;
  release();
  await run(LONG);
  expect(s.saves.length, "a save follows the re-read").toBeGreaterThan(held);
  expect(s.rows.get(s.id)?.text, "RECONCILED_DRAFT_SAVED").toBe("Then sail");
  expect(s.drafts.getState().drafts[s.id]?.host?.edit).toBe(s.drafts.getState().drafts[s.id]?.edit);
  expect(s.drafts.getState().drafts[s.id]?.failure).toBeNull();
});

test("a Send's snapshot the host never acknowledged, and a refused edit, hold updates", async () => {
  const s = scene({ snapshots: true, refuse: () => ({ status: 400, body: { error: "DRAFT_INVALID", message: "Refused." } }) });
  const message = { type: "chat_message" as const, text: "Muster the crew", sessionId: SESSION, requestId: "req-first" };
  s.drafts.getState().createSnapshot(s.id, SESSION, { snapshotId: "snap-first", requestId: "req-first", text: "Muster the crew", files: [], state: "held", createdAt: null, message }, "");
  await run(LONG);
  expect(holdsUnsaved(s.drafts.getState()), "UNACKED_SNAPSHOT_HOLDS_UPDATE").toBe(true);
});

test("a text-only snapshot does not stop a stale composer file from being left out", async () => {
  const s = scene({ snapshots: true });
  s.drafts.getState().edit(s.id, SESSION, { text: "Muster the crew" });
  await run(SAVE_DELAY + 100);
  const message = { type: "chat_message" as const, text: "Muster the crew", sessionId: SESSION, requestId: "req-muster" };
  s.drafts.getState().createSnapshot(s.id, SESSION, { snapshotId: "snap-muster", requestId: "req-muster", text: "Muster the crew", files: [], state: "held", createdAt: null, message }, "Muster the crew");
  await run(SAVE_DELAY + 100);
  expect(s.drafts.getState().drafts[s.id]?.host?.snapshots).toHaveLength(1);
  s.swept.add(CREW.fileId);
  s.drafts.getState().edit(s.id, SESSION, { text: "Crew list", files: [{ file: CREW, lineage: s.id }] });
  await run(LONG);
  expect(s.saves.at(-1)!.body.fileIds, "TEXT_SNAPSHOT_DOES_NOT_BLOCK").toBeUndefined();
  expect(s.drafts.getState().drafts[s.id]?.files).toEqual([{ file: CREW, lineage: GONE_LINEAGE }]);
  expect(s.drafts.getState().drafts[s.id]?.failure).toBeNull();
});

test("an image repair does not use up the file recovery of the same edit", async () => {
  let imageRefusals = 1;
  const s = scene({ refuse: (body) => {
    if (body.attachmentIds.length && imageRefusals-- > 0) return { status: 400, body: { error: "DRAFT_INVALID", message: "An attachment is not stored for this draft; upload it again." } };
    return (body.fileIds ?? []).includes(PERMIT.fileId) ? { status: 400, body: { error: "ATTACHMENT_INVALID", message: "A file is no longer available; upload it again." } } : null;
  } });
  const image: PendingAttachment = { attachment: { data: "iVBORw0KGgo=", mediaType: "image/png" }, previewUrl: "data:image/png;base64,iVBORw0KGgo=", bytes: 8, name: "ithaca-chart.png" };
  s.drafts.getState().edit(s.id, SESSION, { text: "Chart and permit", attachments: [image], files: [{ file: PERMIT, lineage: s.id }] });
  await run(LONG);
  const d = s.drafts.getState().drafts[s.id]!;
  expect(d.failure, "IMAGE_THEN_FILE_RECOVERED").toBeNull();
  expect(d.files).toEqual([{ file: PERMIT, lineage: GONE_LINEAGE }]);
  expect(d.host?.edit).toBe(d.edit);
});

test("a refused edit kept on this device is still refused after a reload, with its reason", async () => {
  const s = scene({ refuse: () => ({ status: 400, body: { error: "DRAFT_INVALID", message: "The draft names an unknown field." } }) });
  s.drafts.getState().edit(s.id, SESSION, { text: "Ask Penelope about the loom" });
  await run(LONG);
  const kept = parseDraft(JSON.parse(JSON.stringify(storeDraft(s.drafts.getState().drafts[s.id]!))))!;
  expect(kept.refused, "REFUSAL_KEPT_ON_DEVICE").toBe("The draft names an unknown field.");
  const t = scene({ refuse: () => ({ status: 400, body: { error: "DRAFT_INVALID", message: "The draft names an unknown field." } }) });
  t.drafts.getState().restoreLocal([{ ...kept, sessionId: "odysseus-raft" }]);
  await run(LONG);
  expect(t.saves, "REFUSAL_RESTORED_NOT_RESENT").toEqual([]);
  expect(t.indicator(kept.draftId)).toMatchObject({ key: "refused", facts: [{ key: "Brain said", value: "The draft names an unknown field." }] });
});

test("a device branch's refusal is shown beside the other version", () => {
  const s = scene();
  s.drafts.getState().edit(s.id, SESSION, { text: "Telemachus keeps the voyage" });
  s.drafts.getState().keepDeviceBranch(s.id, "voyage-branch", { draftId: s.id, sessionId: SESSION, text: "Penelope keeps the loom", attachments: [], editedAt: 1, host: null }, SESSION);
  const d = s.drafts.getState().drafts["voyage-branch"]!;
  s.drafts.getState().saveFailed("voyage-branch", { kind: "refused", edit: d.edit, reason: "The draft names an unknown field." });
  expect(s.indicator("voyage-branch"), "BRANCH_REFUSAL_SHOWN").toMatchObject({ key: "device_conflict", state: "refused", action: "other_version",
    summary: "Another tab changed this draft. Both versions are kept. This one isn't saved: the brain refused it.",
    facts: [{ key: "Brain said", value: "The draft names an unknown field." }] });
});

test("a Send's snapshot a full host never stored holds updates on its own", async () => {
  const s = scene({ snapshots: true, refuse: () => ({ status: 507, body: { error: "DRAFT_CAPACITY", message: "full", limit: 100, bound: "drafts" } }) });
  const message = { type: "chat_message" as const, text: "Muster the crew", sessionId: SESSION, requestId: "req-full" };
  s.drafts.getState().createSnapshot(s.id, SESSION, { snapshotId: "snap-full", requestId: "req-full", text: "Muster the crew", files: [], state: "held", createdAt: null, message }, "");
  await run(LONG);
  expect(s.drafts.getState().drafts[s.id]?.failure?.kind).toBe("full");
  expect(holdsUnsaved(s.drafts.getState()), "UNACKED_SNAPSHOT_ALONE_HOLDS_UPDATE").toBe(true);
});

test("a refusal kept in a device record survives adoption and a kept-both import", () => {
  const s = scene();
  const record = { draftId: "4e2a6c8d-0f1b-4d3e-9a5c-7b9d1f3e5a70", sessionId: "odysseus-raft", text: "Lash the raft", attachments: [], editedAt: 1, host: null, refused: "The draft names an unknown field." };
  s.drafts.getState().adoptDeviceRecord(record);
  const adopted = s.drafts.getState().drafts[record.draftId]!;
  expect(adopted.failure, "ADOPTED_REFUSAL_KEPT").toEqual({ kind: "refused", edit: adopted.edit, reason: "The draft names an unknown field." });
  s.drafts.getState().edit(s.id, SESSION, { text: "Telemachus keeps the voyage" });
  s.drafts.getState().keepDeviceBranch(s.id, "voyage-branch", { draftId: s.id, sessionId: SESSION, text: "Penelope keeps the loom", attachments: [], editedAt: 1, host: null, refused: "Refused elsewhere." }, SESSION);
  const imported = s.drafts.getState().drafts[s.id]!;
  expect(imported.failure, "IMPORTED_REFUSAL_KEPT").toEqual({ kind: "refused", edit: imported.edit, reason: "Refused elsewhere." });
});

test("a refusal of a body with outgoing snapshots is not kept on the device, where the snapshots are not", async () => {
  const s = scene({ snapshots: true, refuse: () => ({ status: 400, body: { error: "DRAFT_INVALID", message: "Refused." } }) });
  const message = { type: "chat_message" as const, text: "Muster the crew", sessionId: SESSION, requestId: "req-first" };
  s.drafts.getState().createSnapshot(s.id, SESSION, { snapshotId: "snap-first", requestId: "req-first", text: "Muster the crew", files: [], state: "held", createdAt: null, message }, "");
  s.drafts.getState().edit(s.id, SESSION, { text: "Bring the wine" });
  await run(LONG);
  const d = s.drafts.getState().drafts[s.id]!;
  expect(d.failure?.kind).toBe("refused");
  expect(storeDraft(d).refused, "SNAPSHOT_REFUSAL_NOT_KEPT").toBeUndefined();
});

test("a draft whose id the host allows and spells like the gone lineage still sees its stale file as gone", async () => {
  const s = scene();
  const id = "gone";
  s.drafts.getState().edit(id, SESSION, { text: "Harbour fees", files: [{ file: PERMIT, lineage: id }] });
  await run(SAVE_DELAY + 100);
  s.swept.add(PERMIT.fileId);
  s.drafts.getState().edit(id, SESSION, { text: "Harbour fees for the permit" });
  await run(LONG);
  expect(s.drafts.getState().drafts[id]?.files, "GONE_LINEAGE_NEVER_A_DRAFT_ID").toEqual([{ file: PERMIT, lineage: GONE_LINEAGE }]);
  expect(s.saves.at(-1)!.body.fileIds).toEqual([]);
});

test("an unchanged acknowledged snapshot with files does not stop a stale composer file from being left out", async () => {
  const s = scene({ snapshots: true });
  s.drafts.getState().edit(s.id, SESSION, { text: "Muster the crew", files: [{ file: PERMIT, lineage: s.id }] });
  await run(SAVE_DELAY + 100);
  const message = { type: "chat_message" as const, text: "Muster the crew", sessionId: SESSION, requestId: "req-muster" };
  s.drafts.getState().createSnapshot(s.id, SESSION, { snapshotId: "snap-muster", requestId: "req-muster", text: "Muster the crew", files: [{ fileId: PERMIT.fileId, file: PERMIT }], state: "held", createdAt: null, message }, "Muster the crew");
  await run(SAVE_DELAY + 100);
  expect(s.drafts.getState().drafts[s.id]?.host?.snapshots?.[0]?.fileIds).toEqual([PERMIT.fileId]);
  s.swept.add(CREW.fileId);
  s.drafts.getState().edit(s.id, SESSION, { text: "Crew list", files: [{ file: CREW, lineage: s.id }] });
  await run(LONG);
  expect(s.drafts.getState().drafts[s.id]?.files, "ACKED_SNAPSHOT_FILES_DO_NOT_BLOCK").toEqual([{ file: CREW, lineage: GONE_LINEAGE }]);
  expect(s.drafts.getState().drafts[s.id]?.failure).toBeNull();
});

test("a reconciliation read that gets no answer is read again, and the refused list is not sent meanwhile", async () => {
  let refusals = 1;
  let moved = () => {};
  const s = scene({ snapshots: true, refuse: (body) => (body.snapshots?.length && refusals-- > 0 ? (moved(), { status: 400, body: { error: "DRAFT_INVALID", message: "A dispatched snapshot cannot become held." } }) : null) });
  moved = () => { const r = s.rows.get(s.id)!; s.rows.set(s.id, { ...r, revision: r.revision + 1 }); };
  s.drafts.getState().edit(s.id, SESSION, { text: "Muster the crew" });
  await run(SAVE_DELAY + 100);
  s.silenceGets(3);
  const message = { type: "chat_message" as const, text: "Muster the crew", sessionId: SESSION, requestId: "req-muster" };
  s.drafts.getState().createSnapshot(s.id, SESSION, { snapshotId: "snap-muster", requestId: "req-muster", text: "Muster the crew", files: [], state: "held", createdAt: null, message }, "Muster the crew");
  // Past the first backoff, while the re-reads still get no answer: the refused list waits.
  await run(10_000);
  expect(s.saves.filter((x) => x.body.snapshots?.length).length, "REFUSED_LIST_NOT_RESENT_WHILE_READING").toBe(1);
  await run(LONG);
  expect(s.saves.filter((x) => x.body.snapshots?.length).length, "RECONCILE_READ_RETRIED").toBe(2);
  expect(s.rows.get(s.id)?.revision, "saved over the re-read revision").toBe(3);
  expect(s.drafts.getState().drafts[s.id]?.failure).toBeNull();
  expect(s.drafts.getState().drafts[s.id]?.host?.snapshots).toHaveLength(1);
});

test("a reconciliation read the host refuses outright is not retried forever: a new edit is saved", async () => {
  const s = scene({ snapshots: true, refuse: (body) => (body.snapshots?.length ? { status: 400, body: { error: "DRAFT_INVALID", message: "A dispatched snapshot cannot become held." } } : null) });
  s.drafts.getState().edit(s.id, SESSION, { text: "Muster the crew" });
  await run(SAVE_DELAY + 100);
  s.failGets(400, 1_000);
  const message = { type: "chat_message" as const, text: "Muster the crew", sessionId: SESSION, requestId: "req-muster" };
  s.drafts.getState().createSnapshot(s.id, SESSION, { snapshotId: "snap-muster", requestId: "req-muster", text: "Muster the crew", files: [], state: "held", createdAt: null, message }, "Muster the crew");
  await run(LONG);
  const gets = s.gets();
  await run(LONG);
  expect(s.gets() - gets, "REFUSED_READ_NOT_RETRIED_FOREVER").toBe(0);
  expect(s.drafts.getState().drafts[s.id]?.failure?.kind).toBe("refused");
});

test("a file recovery read the host refuses outright ends in a refusal, not endless reads", async () => {
  const s = scene();
  s.drafts.getState().edit(s.id, SESSION, { text: "Harbour fees", files: [{ file: PERMIT, lineage: s.id }] });
  await run(SAVE_DELAY + 100);
  s.swept.add(PERMIT.fileId);
  s.failGets(400, 1_000);
  s.drafts.getState().edit(s.id, SESSION, { text: "Harbour fees for the permit" });
  await run(LONG);
  const gets = s.gets();
  await run(LONG);
  expect(s.gets() - gets, "REFUSED_FILE_READ_NOT_RETRIED").toBe(0);
  expect(s.drafts.getState().drafts[s.id]?.failure?.kind).toBe("refused");
});

test("a newer edit is saved as itself while an older edit's re-read still gets no answer", async () => {
  let refusing = true;
  const s = scene({ snapshots: true, refuse: (body) => (refusing && body.snapshots?.length ? { status: 400, body: { error: "DRAFT_INVALID", message: "A dispatched snapshot cannot become held." } } : null) });
  s.drafts.getState().edit(s.id, SESSION, { text: "Muster the crew" });
  await run(SAVE_DELAY + 100);
  s.silenceGets(1_000);
  const message = { type: "chat_message" as const, text: "Muster the crew", sessionId: SESSION, requestId: "req-muster" };
  s.drafts.getState().createSnapshot(s.id, SESSION, { snapshotId: "snap-muster", requestId: "req-muster", text: "Muster the crew", files: [], state: "held", createdAt: null, message }, "Muster the crew");
  await run(10_000);
  refusing = false;
  const before = s.saves.length;
  s.drafts.getState().edit(s.id, SESSION, { text: "Then sail" });
  await run(SAVE_DELAY + 100);
  expect(s.saves.length - before, "NEWER_EDIT_NOT_BLOCKED_BY_REREAD").toBe(1);
  expect(s.rows.get(s.id)?.text).toBe("Then sail");
});

test("a re-read that lands after a newer save is acknowledged changes nothing", async () => {
  let refusals = 1;
  const s = scene({ snapshots: true, refuse: (body) => (body.snapshots?.length && refusals-- > 0 ? { status: 400, body: { error: "DRAFT_INVALID", message: "A dispatched snapshot cannot become held." } } : null) });
  s.drafts.getState().edit(s.id, SESSION, { text: "Muster the crew" });
  await run(SAVE_DELAY + 100);
  const release = s.holdGets();
  const message = { type: "chat_message" as const, text: "Muster the crew", sessionId: SESSION, requestId: "req-muster" };
  s.drafts.getState().createSnapshot(s.id, SESSION, { snapshotId: "snap-muster", requestId: "req-muster", text: "Muster the crew", files: [], state: "held", createdAt: null, message }, "Muster the crew");
  await run(1_000);
  // A newer edit is saved and acknowledged while the re-read of revision 1 is out.
  s.drafts.getState().edit(s.id, SESSION, { text: "Then sail" });
  await run(SAVE_DELAY + 100);
  const acked = s.drafts.getState().drafts[s.id]!.host!;
  expect(acked.revision).toBe(2);
  release();
  await run(1_000);
  const host = s.drafts.getState().drafts[s.id]!.host!;
  expect(host.revision, "STALE_REREAD_DISCARDED").toBe(2);
  expect(host.snapshots?.map((x) => x.snapshotId)).toEqual(["snap-muster"]);
});

test("a refusal of an edit already superseded does not hold the newer one behind reads that get no answer", async () => {
  let refusals = 1;
  const s = scene({ snapshots: true, refuse: (body) => (body.snapshots?.length && refusals-- > 0 ? { status: 400, body: { error: "DRAFT_INVALID", message: "A dispatched snapshot cannot become held." } } : null) });
  s.drafts.getState().edit(s.id, SESSION, { text: "Muster the crew" });
  await run(SAVE_DELAY + 100);
  s.silenceGets(1_000);
  const release = s.holdSaves();
  const message = { type: "chat_message" as const, text: "Muster the crew", sessionId: SESSION, requestId: "req-muster" };
  s.drafts.getState().createSnapshot(s.id, SESSION, { snapshotId: "snap-muster", requestId: "req-muster", text: "Muster the crew", files: [], state: "held", createdAt: null, message }, "Muster the crew");
  await run(100);
  // Typed before the older save's refusal comes back.
  s.drafts.getState().edit(s.id, SESSION, { text: "Then sail" });
  release();
  await run(LONG);
  expect(s.rows.get(s.id)?.text, "SUPERSEDED_REFUSAL_DOES_NOT_BLOCK").toBe("Then sail");
});

test("another version taking the draft's place ends a pending file recovery: its own text is saved", async () => {
  const s = scene();
  // The first edit's save lists an original the host does not store; its recovery read gets no answer.
  s.swept.add(CREW.fileId);
  s.silenceGets(1_000);
  s.drafts.getState().edit(s.id, SESSION, { text: "Crew list", files: [{ file: CREW, lineage: s.id }] });
  await run(10_000);
  expect(s.drafts.getState().drafts[s.id]?.edit).toBe(1);
  // The device's other version of this draft is adopted: same id, and edit 1 too.
  s.silenceGets(0);
  const gets = s.gets();
  s.drafts.getState().adoptDeviceRecord({ draftId: s.id, sessionId: SESSION, text: "Penelope keeps the loom", attachments: [], editedAt: 5, host: null });
  expect(s.drafts.getState().drafts[s.id]?.edit).toBe(1);
  await run(LONG);
  expect(s.gets() - gets, "ADOPTION_ENDS_RECOVERY").toBe(0);
  expect(s.rows.get(s.id)?.text).toBe("Penelope keeps the loom");
  expect(s.drafts.getState().drafts[s.id]?.failure).toBeNull();
});

test("a re-read waiting to retry stops asking a host that no longer keeps drafts", async () => {
  const s = scene({ snapshots: true, refuse: (body) => (body.snapshots?.length ? { status: 400, body: { error: "DRAFT_INVALID", message: "A dispatched snapshot cannot become held." } } : null) });
  s.drafts.getState().edit(s.id, SESSION, { text: "Muster the crew" });
  await run(SAVE_DELAY + 100);
  s.silenceGets(1_000);
  const message = { type: "chat_message" as const, text: "Muster the crew", sessionId: SESSION, requestId: "req-muster" };
  s.drafts.getState().createSnapshot(s.id, SESSION, { snapshotId: "snap-muster", requestId: "req-muster", text: "Muster the crew", files: [], state: "held", createdAt: null, message }, "Muster the crew");
  await run(3_000);
  s.withoutDrafts();
  const gets = s.gets();
  await run(LONG);
  expect(s.gets() - gets, "NO_REREAD_WITHOUT_DRAFTS").toBe(0);
});

test("a refused edit replaced by an adopted version at the same edit count is saved as that version", async () => {
  const s = scene({ refuse: (body) => (body.text === "Crew list" ? { status: 400, body: { error: "DRAFT_INVALID", message: "The draft names an unknown field." } } : null) });
  s.drafts.getState().edit(s.id, SESSION, { text: "Crew list" });
  await run(LONG);
  expect(s.drafts.getState().drafts[s.id]?.failure?.kind).toBe("refused");
  s.drafts.getState().adoptDeviceRecord({ draftId: s.id, sessionId: SESSION, text: "Penelope keeps the loom", attachments: [], editedAt: 5, host: null });
  expect(s.drafts.getState().drafts[s.id]?.edit).toBe(1);
  await run(SAVE_DELAY + 100);
  expect(s.rows.get(s.id)?.text, "ADOPTED_AFTER_REFUSAL_SAVED").toBe("Penelope keeps the loom");
});

test("a two-tab fork ends the source's pending file recovery", async () => {
  const s = scene();
  s.swept.add(CREW.fileId);
  s.silenceGets(1_000);
  s.drafts.getState().edit(s.id, SESSION, { text: "Crew list", files: [{ file: CREW, lineage: s.id }] });
  await run(10_000);
  s.silenceGets(0);
  const gets = s.gets();
  // The retained writer's version takes the id back; this tab continues on a branch.
  s.drafts.getState().keepDeviceBranch(s.id, "voyage-branch", { draftId: s.id, sessionId: SESSION, text: "Penelope keeps the loom", attachments: [], editedAt: 1, host: null }, SESSION);
  await run(LONG);
  expect(s.gets() - gets, "FORK_ENDS_RECOVERY").toBe(0);
  expect(s.drafts.getState().drafts[s.id]?.failure ?? null).toBeNull();
});

test("a recovery read that lands after the draft changed leaves the newer edit's files alone", async () => {
  const s = scene();
  s.swept.add(CREW.fileId);
  const release = s.holdGets();
  s.drafts.getState().edit(s.id, SESSION, { text: "Permit and crew", files: [{ file: PERMIT, lineage: s.id }, { file: CREW, lineage: s.id }] });
  await run(SAVE_DELAY + 100);
  // The reader removes the stale original while the recovery read is out.
  s.drafts.getState().edit(s.id, SESSION, { files: [{ file: PERMIT, lineage: s.id }] });
  release();
  await run(LONG);
  const d = s.drafts.getState().drafts[s.id]!;
  expect(d.files, "STALE_READ_SPARES_NEWER_EDIT").toEqual([{ file: PERMIT, lineage: s.id }]);
  expect(s.saves.at(-1)!.body.fileIds).toEqual([PERMIT.fileId]);
  expect(d.failure).toBeNull();
});

test("a never-saved draft cleared and typed into again is new work, not the old recovery", async () => {
  const s = scene();
  const id = s.drafts.getState().fresh;
  s.swept.add(CREW.fileId);
  s.silenceGets(1_000);
  s.drafts.getState().edit(id, null, { text: "Crew list", files: [{ file: CREW, lineage: id }] });
  await run(10_000);
  s.drafts.getState().edit(id, null, { text: "", files: [] });
  expect(s.drafts.getState().drafts[id], "forgotten when emptied").toBeUndefined();
  s.drafts.getState().edit(id, null, { text: "Ask Penelope" });
  expect(s.drafts.getState().drafts[id]?.edit).toBe(1);
  await run(LONG);
  expect(s.rows.get(id)?.text, "RETYPED_DRAFT_SAVED").toBe("Ask Penelope");
});

test("a draft left with only carried originals and deleted snapshots deletes the host's copy instead of saving it empty", async () => {
  const s = scene({ snapshots: true });
  s.drafts.setState((st) => ({ drafts: { ...st.drafts, [s.id]: { draftId: s.id, sessionId: SESSION, text: "", attachments: [], files: [{ file: CREW, lineage: "a-rotated-away-draft" }], snapshots: [], editedAt: 1, edit: 3,
    host: { revision: 2, edit: 2, sessionId: SESSION, attachmentIds: [], snapshots: [{ snapshotId: "snap-old", requestId: "req-old", text: "Lash the raft", fileIds: [], state: "returned" }], updatedAt: 1 },
    uploads: new Map(), failure: null, savingSince: null, conflict: null, uncertain: false, bind: null } } }));
  await run(LONG);
  expect(s.saves, "NO_EMPTY_SAVE_AFTER_SNAPSHOT_DELETE").toEqual([]);
  expect(s.removes()).toBe(1);
});

test("a fork's branch does not inherit the original's refusal, and the retained version is saved", async () => {
  const s = scene({ refuse: (body) => (body.text === "Crew list" ? { status: 400, body: { error: "DRAFT_INVALID", message: "Refused for this chat." } } : null) });
  s.drafts.getState().edit(s.id, SESSION, { text: "Crew list" });
  await run(LONG);
  expect(s.drafts.getState().drafts[s.id]?.failure?.kind).toBe("refused");
  s.drafts.getState().keepDeviceBranch(s.id, "voyage-branch", { draftId: s.id, sessionId: SESSION, text: "Penelope keeps the loom", attachments: [], editedAt: 1, host: null }, SESSION);
  expect(s.drafts.getState().drafts["voyage-branch"]?.failure, "BRANCH_NOT_REFUSED").toBeNull();
  await run(SAVE_DELAY + 100);
  expect(s.rows.get(s.id)?.text, "RETAINED_VERSION_SAVED").toBe("Penelope keeps the loom");
});
