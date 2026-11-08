import { afterEach, beforeEach, expect, test, vi } from "bun:test";
import type { AttachmentFile, Draft, DraftSaveRequest, ServerMessage } from "@schlessera/brain-ui-sdk/protocol";
import { createBrainUiRoot, type BrainUiRoot } from "../src/root.ts";
import { createDraftClient } from "../src/lib/draft-client.ts";
import type { DraftApi } from "../src/lib/draft-api.ts";
import { parseDraft, storeDraft } from "../src/lib/local-work.ts";
import { holdsUnsaved } from "../src/stores/draft-state.ts";

// Composer originals as draft content (#3155): a stored original is bound by
// the draft's save, reads as saved only once the host acknowledged a
// revision listing it, and goes with the send that names it. Odysseus
// fixtures, an in-memory host, no network.

const roots: BrainUiRoot[] = [];
// The draft client's save debounce and retry backoff run on a fake clock; the
// in-memory host answers in promise turns, which stay real.
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { for (const r of roots.splice(0)) r.dispose(); vi.useRealTimers(); });
const SESSION = "odysseus-ithaca";
function original(fileId: string, name = "ithaca-permit.pdf"): AttachmentFile {
  return { fileId, name, path: `.brain-ui/attachments/${fileId}/${name}`, mediaType: "application/pdf", bytes: 2_400_000, sha256: "b".repeat(64), kind: "pdf", reader: "pdf" };
}
const PERMIT = original("2c7e1a90-5d3f-4b8e-a1c6-9f0d2e4b7a31");
const CREW = original("7a1f3c5e-2b4d-4e6f-8a0c-1d3e5f7a9b20", "crew-list.txt");

function scene() {
  const saves: { draftId: string; body: DraftSaveRequest }[] = [];
  let revision = 0;
  let answer: "ok" | "silent" = "ok";
  const api: DraftApi = {
    list: async () => ({ ok: true, value: { drafts: [] } }),
    get: async () => ({ ok: false, status: 404, body: {} }),
    save: async (draftId, _ifMatch, _key, body) => {
      saves.push({ draftId, body });
      if (answer === "silent") return { ok: false, status: 0, body: {} };
      return { ok: true, value: { revision: ++revision, updatedAt: 1_000 + revision } };
    },
    upload: async () => ({ ok: true, value: { attachmentId: "att-1" } }),
    remove: async () => ({ ok: true, value: null }),
    bind: async () => ({ ok: true, value: { revision: ++revision } }),
  };
  const ui = createBrainUiRoot({ storage: null, request: async () => Response.json({}) });
  roots.push(ui);
  const client = createDraftClient(ui, { send: () => true, api });
  client.hello({ type: "server_hello", protocolRev: 5, capabilities: { sessionDrafts: true, chatRequestAck: true, composerFiles: true },
    attachmentLimits: { maxFiles: 10, maxFileBytes: 25_000_000, maxTotalBytes: 50_000_000, poolBytes: 1_073_741_824 } } as Extract<ServerMessage, { type: "server_hello" }>);
  const drafts = ui.stores.drafts;
  const id = drafts.getState().idFor(SESSION);
  return { ui, drafts, id, saves, silence: () => { answer = "silent"; } };
}
type Scene = ReturnType<typeof scene>;
/** `SAVE_DELAY_MS` in draft-client.ts: a pause in typing before a change is saved. */
const SAVE_DELAY = 800;
/**
 * The pause in typing: nothing is saved before the debounce ends; one save
 * then starts, and this returns once its answer is applied.
 */
async function pause(s: Scene) {
  const before = s.saves.length;
  vi.advanceTimersByTime(SAVE_DELAY - 1);
  await turn();
  expect(s.saves, "nothing is saved before the pause ends").toHaveLength(before);
  vi.advanceTimersByTime(1);
  for (let turns = 0; s.saves.length === before || s.drafts.getState().drafts[s.id]?.savingSince != null; turns++) {
    if (turns === 100) throw new Error("The save did not settle.");
    await turn();
  }
}
/** One macrotask: every promise continuation queued before it has run. */
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

test("a hello with composerFiles exposes the host's file limits; without it there are none", () => {
  const s = scene();
  expect(s.drafts.getState().fileLimits).toEqual({ maxFiles: 10, maxFileBytes: 25_000_000, maxTotalBytes: 50_000_000, poolBytes: 1_073_741_824 });
  s.drafts.getState().setSupport(true, undefined, null);
  expect(s.drafts.getState().fileLimits).toBeNull();
});

test("a stored original is saved as a fileIds binding, and reads as saved only after the host acknowledges that revision", async () => {
  const s = scene();
  s.drafts.getState().edit(s.id, SESSION, { text: "Which harbour fees does the permit list?", files: [{ file: PERMIT, lineage: s.id }] });
  expect(holdsUnsaved(s.drafts.getState()), "unacknowledged files are at risk").toBe(true);
  await pause(s);
  expect(s.saves).toHaveLength(1);
  expect(s.saves[0]!.body.fileIds).toEqual([PERMIT.fileId]);
  const d = s.drafts.getState().drafts[s.id]!;
  expect(d.host?.fileIds).toEqual([PERMIT.fileId]);
  expect(d.host?.edit).toBe(d.edit);
  expect(holdsUnsaved(s.drafts.getState())).toBe(false);
});

test("a save that gets no answer never acknowledges the binding", async () => {
  const s = scene();
  s.silence();
  s.drafts.getState().edit(s.id, SESSION, { files: [{ file: PERMIT, lineage: s.id }] });
  await pause(s);
  const d = s.drafts.getState().drafts[s.id]!;
  expect(s.saves[0]!.body.fileIds).toEqual([PERMIT.fileId]);
  expect(d.host).toBeNull();
  expect(holdsUnsaved(s.drafts.getState())).toBe(true);
});

test("a file of another draft id is never listed; removing the last original unbinds it with an empty list", async () => {
  const s = scene();
  s.drafts.getState().edit(s.id, SESSION, { text: "Crew list for Ithaca", files: [{ file: PERMIT, lineage: s.id }, { file: CREW, lineage: "a-rotated-away-draft" }] });
  await pause(s);
  expect(s.saves.at(-1)!.body.fileIds).toEqual([PERMIT.fileId]);
  s.drafts.getState().edit(s.id, SESSION, { files: [] });
  await pause(s);
  expect(s.saves.at(-1)!.body.fileIds, "the host is told to drop the binding").toEqual([]);
});

test("a send takes exactly its originals out of the draft; the content comes back when the frame never left", async () => {
  const s = scene();
  s.drafts.getState().edit(s.id, SESSION, { text: "Read the permit", files: [{ file: PERMIT, lineage: s.id }] });
  await pause(s);
  const store = s.drafts.getState();
  const message = { type: "chat_message" as const, text: "Read the permit", sessionId: SESSION, requestId: "req-permit", attachmentRefs: [{ kind: "attachment" as const, fileId: PERMIT.fileId }] };
  const ref = store.beginSend({ requestId: "req-permit", draftId: s.id, sessionId: SESSION, text: "Read the permit", attachments: [], attachmentFiles: [{ file: PERMIT, lineage: s.id }], message }, "Read the permit");
  expect(ref, "a clean revision is named").toEqual({ draftId: s.id, revision: 1 });
  expect(s.drafts.getState().drafts[s.id]!.files).toEqual([]);
  s.drafts.getState().sendFailed("req-permit");
  expect(s.drafts.getState().drafts[s.id]!.files!.map((f) => f.file.fileId)).toEqual([PERMIT.fileId]);
});

test("a host draft restores its originals with this id's lineage, and a device copy keeps them", () => {
  const s = scene();
  const hostDraft: Draft = { draftId: "4e2a6c8d-0f1b-4d3e-9a5c-7b9d1f3e5a70", sessionId: "odysseus-raft", revision: 3, updatedAt: 5_000, text: "Raft lashing plan", attachments: [], files: [PERMIT] };
  s.drafts.getState().restore(hostDraft);
  const d = s.drafts.getState().drafts[hostDraft.draftId]!;
  expect(d.files).toEqual([{ file: PERMIT, lineage: hostDraft.draftId }]);
  expect(d.host?.fileIds).toEqual([PERMIT.fileId]);
  const kept = parseDraft(JSON.parse(JSON.stringify(storeDraft(d))));
  expect(kept?.files).toEqual([{ file: PERMIT, lineage: hostDraft.draftId }]);
});
