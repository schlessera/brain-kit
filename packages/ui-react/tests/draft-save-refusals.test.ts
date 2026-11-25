import { afterEach, beforeEach, expect, test, vi } from "bun:test";
import type { AttachmentFile, Draft, DraftSaveRequest, ServerMessage } from "@schlessera/brain-ui-sdk/protocol";
import { createBrainUiRoot, type BrainUiRoot } from "../src/root.ts";
import { createDraftClient } from "../src/lib/draft-client.ts";
import type { DraftApi, DraftCallResult } from "../src/lib/draft-api.ts";
import { draftIndicatorView } from "../src/lib/draft-indicator.ts";
import { GONE_LINEAGE, type ComposerDraft } from "../src/stores/draft-state.ts";

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

type Refusal = { status: 400; body: { error: string; message: string } };
/**
 * An in-memory host. `refuse` answers a save body with the host's own 400,
 * or null to store it; by default it is the server's empty-draft rule
 * (`packages/ui-server/src/drafts/store.ts`).
 */
function scene(options: { refuse?: (body: DraftSaveRequest) => Refusal | null; snapshots?: boolean } = {}) {
  const saves: { draftId: string; body: DraftSaveRequest }[] = [];
  const rows = new Map<string, Draft>();
  const swept = new Set<string>();
  const empty = (body: DraftSaveRequest): Refusal | null =>
    body.text.length === 0 && body.attachmentIds.length === 0 && (body.fileIds?.length ?? 0) === 0 && (body.snapshots?.length ?? 0) === 0
      ? { status: 400, body: { error: "DRAFT_INVALID", message: "An empty draft is deleted, not saved." } } : null;
  const gone = (body: DraftSaveRequest): Refusal | null =>
    (body.fileIds ?? []).some((id) => swept.has(id)) ? { status: 400, body: { error: "ATTACHMENT_INVALID", message: "A file is no longer available; upload it again." } } : null;
  const refuse = options.refuse ?? ((body) => empty(body) ?? gone(body));
  const api: DraftApi = {
    list: async () => ({ ok: true, value: { drafts: [...rows.values()].map((r) => ({ draftId: r.draftId, sessionId: r.sessionId, revision: r.revision, updatedAt: r.updatedAt, preview: r.text, attachmentCount: 0 })) } }),
    get: async (draftId) => {
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
      rows.set(draftId, { draftId, sessionId: body.sessionId, revision, updatedAt: 1_000 + revision, text: body.text, attachments: [], ...(body.fileIds ? { files } : {}) });
      return { ok: true, value: { revision, updatedAt: 1_000 + revision } };
    },
    upload: async () => ({ ok: true, value: { attachmentId: "att-1" } }),
    remove: async () => ({ ok: true, value: null }),
    bind: async () => ({ ok: false, status: 404, body: {} }),
  };
  const ui = createBrainUiRoot({ storage: null, request: async () => Response.json({}) });
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
  return { ui, client, drafts, id, saves, rows, swept, indicator, reconnect: () => client.hello(hello) };
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
