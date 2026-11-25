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
  const rows = new Map<string, Draft>();
  const rowsSnapshots = new Map<string, NonNullable<DraftSaveRequest["snapshots"]>>();
  const swept = new Set<string>();
  /** Reads that get no answer before the host answers again. */
  let silentGets = 0;
  /** While set, every read waits for it. */
  let getGate: Promise<void> | null = null;
  const empty = (body: DraftSaveRequest): Refusal | null =>
    body.text.length === 0 && body.attachmentIds.length === 0 && (body.fileIds?.length ?? 0) === 0 && (body.snapshots?.length ?? 0) === 0
      ? { status: 400, body: { error: "DRAFT_INVALID", message: "An empty draft is deleted, not saved." } } : null;
  const gone = (body: DraftSaveRequest): Refusal | null =>
    (body.fileIds ?? []).some((id) => swept.has(id)) ? { status: 400, body: { error: "ATTACHMENT_INVALID", message: "A file is no longer available; upload it again." } } : null;
  const refuse = options.refuse ?? ((body) => empty(body) ?? gone(body));
  const api: DraftApi = {
    list: async () => ({ ok: true, value: { drafts: [...rows.values()].map((r) => ({ draftId: r.draftId, sessionId: r.sessionId, revision: r.revision, updatedAt: r.updatedAt, preview: r.text, attachmentCount: 0 })) } }),
    get: async (draftId) => {
      if (getGate) await getGate;
      if (silentGets > 0) { silentGets--; return { ok: false, status: 503, body: {} }; }
      const row = rows.get(draftId);
      if (!row) return { ok: false, status: 404, body: { error: "DRAFT_NOT_FOUND" } };
      // The host's draft lists only the originals it still stores.
      return { ok: true, value: { ...row, ...(row.files ? { files: row.files.filter((f) => !swept.has(f.fileId)) } : {}) } };
    },
    save: async (draftId, ifMatch, _key, body): Promise<DraftCallResult<{ revision: number; updatedAt: number }>> => {
      saves.push({ draftId, body });
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
    remove: options.remove ?? (async () => ({ ok: true, value: null })),
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
  return { ui, client, drafts, id, saves, rows, swept, indicator, reconnect: () => client.hello(hello), silenceGets: (n: number) => { silentGets = n; },
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

test("a read that keeps getting no answer stops the file recovery instead of looping", async () => {
  const s = scene();
  s.drafts.getState().edit(s.id, SESSION, { text: "Harbour fees", files: [{ file: PERMIT, lineage: s.id }] });
  await run(SAVE_DELAY + 100);
  s.swept.add(PERMIT.fileId);
  s.silenceGets(1_000);
  const before = s.saves.length;
  s.drafts.getState().edit(s.id, SESSION, { text: "Harbour fees for the permit" });
  await run(LONG);
  await run(LONG);
  expect(s.saves.length - before, "PERSISTENT_READ_FAILURE_BOUNDED").toBeLessThanOrEqual(3);
  expect(s.drafts.getState().drafts[s.id]?.failure).toMatchObject({ kind: "refused" });
});

test("no save goes out while a refused snapshot list is read again, and the corrected draft is saved", async () => {
  let refusals = 1;
  const s = scene({ snapshots: true, refuse: (body) => (body.snapshots?.length && refusals-- > 0 ? { status: 400, body: { error: "DRAFT_INVALID", message: "A dispatched snapshot cannot become held." } } : null) });
  s.drafts.getState().edit(s.id, SESSION, { text: "Muster the crew" });
  await run(SAVE_DELAY + 100);
  const release = s.holdGets();
  const message = { type: "chat_message" as const, text: "Muster the crew", sessionId: SESSION, requestId: "req-muster" };
  s.drafts.getState().createSnapshot(s.id, SESSION, { snapshotId: "snap-muster", requestId: "req-muster", text: "Muster the crew", files: [], state: "held", createdAt: null, message }, "Muster the crew");
  s.drafts.getState().edit(s.id, SESSION, { text: "Then sail" });
  await run(LONG);
  expect(s.saves.filter((x) => x.body.snapshots?.length).length, "RECONCILE_HOLDS_SAVES").toBe(1);
  release();
  await run(LONG);
  expect(s.drafts.getState().drafts[s.id]?.failure).toBeNull();
  expect(s.saves.at(-1)!.body.text).toBe("Then sail");
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
