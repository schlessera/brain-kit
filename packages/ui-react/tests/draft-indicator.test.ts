import { describe, expect, test } from "bun:test";
import type { AttachmentFile } from "@schlessera/brain-ui-sdk/protocol";
import { draftAcknowledged, draftIndicatorAtRisk, draftIndicatorView, type DraftIndicatorInput } from "../src/lib/draft-indicator.ts";
import type { QueuedFile } from "../src/lib/attachment-queue.ts";
import type { ComposerDraft } from "../src/stores/draft-state.ts";

// The composer's draft indicator (#3155, design brief rev 4 §1), derived
// from the store alone. Success is the host's acknowledgement of this exact
// edit with every original bound; nothing else reads as saved. Odysseus
// fixtures, pinned to 2026-07-12.

const AT_1042 = Date.UTC(2026, 6, 12, 10, 42);
const clock = (ms: number) => new Date(ms).toISOString().slice(11, 16);

const original = (fileId: string, name: string): AttachmentFile => ({
  fileId, name, path: `.brain-ui/attachments/${fileId}/${name}`, bytes: 2_400, sha256: "0".repeat(64),
  mediaType: "application/pdf", kind: "pdf", reader: "pdf",
});
const permit = original("00000000-0000-4000-8000-000000000001", "harbor-permit-2026.pdf");
const minutes = original("00000000-0000-4000-8000-000000000002", "minutes-2026-07-12.pdf");

function draft(patch: Partial<ComposerDraft> = {}): ComposerDraft {
  return {
    draftId: "draft-ithaca", sessionId: "odysseus-ithaca", text: "Compare the 2025 and 2026 permit fees for the east quay",
    attachments: [], files: [], editedAt: AT_1042, edit: 3, host: null, uploads: new Map(), failure: null,
    savingSince: null, conflict: null, uncertain: false, bind: null, ...patch,
  };
}
const acked = (d: ComposerDraft, edit = d.edit): ComposerDraft => ({
  ...d, host: { revision: 4, edit, sessionId: d.sessionId, attachmentIds: [], fileIds: (d.files ?? []).map((f) => f.file.fileId), updatedAt: AT_1042 },
});
function queued(name: string, state: QueuedFile["state"], patch: Partial<QueuedFile> = {}): QueuedFile {
  return { id: `q-${name}`, file: new File(["x".repeat(4_200)], name), name, draftId: "draft-ithaca", idempotencyKey: `k-${name}`, state, ...patch };
}
/** The indicator state, or `none` while hidden. */
const shown = (v: ReturnType<typeof draftIndicatorView>) => (v.key === "none" ? "none" : v.state);
const view = (d: ComposerDraft | undefined, extra: Partial<DraftIndicatorInput> = {}) =>
  draftIndicatorView({ draft: d, store: { supported: true, limits: { maxTextBytes: 65_536, maxDraftBytes: 8_388_608, maxDrafts: 100, maxTotalBytes: 268_435_456 } }, queued: [], online: true, clock, ...extra });

describe("success is this exact revision", () => {
  test("acknowledged with both originals bound: success, naming the text and the files", () => {
    const d = acked(draft({ files: [{ file: permit, lineage: "draft-ithaca" }, { file: minutes, lineage: "draft-ithaca" }] }));
    const v = view(d);
    expect(v).toMatchObject({ key: "saved", state: "success", summary: "Draft saved 10:42: this text and 2 files." });
    expect(draftIndicatorAtRisk(v)).toBe(false);
  });

  test("an acknowledgement of an older edit is never success", () => {
    const d = acked(draft(), 2);
    expect(draftAcknowledged(d, [])).toBe(false);
    expect(shown(view(d))).not.toBe("success");
    expect(view({ ...d, savingSince: AT_1042 })).toMatchObject({ key: "saving", state: "active", summary: "Saving draft…" });
  });

  test("an acknowledged revision missing a binding is not success", () => {
    const d = draft({ files: [{ file: permit, lineage: "draft-ithaca" }] });
    const stale = { ...d, host: { revision: 4, edit: d.edit, sessionId: d.sessionId, attachmentIds: [], fileIds: [], updatedAt: AT_1042 } };
    expect(shown(view(stale))).not.toBe("success");
  });

  test("a file still uploading keeps it from success, and names it", () => {
    const v = view(acked(draft()), { queued: [queued("minutes-2026-07-12.docx", "uploading")] });
    expect(v).toMatchObject({ key: "queued", state: "queued", summary: "Not saved yet: minutes-2026-07-12.docx is still uploading. Your text is kept in this tab." });
    expect(v.key !== "none" && v.facts).toEqual([{ key: "Waiting for", value: "minutes-2026-07-12.docx" }]);
    expect(draftIndicatorAtRisk(v)).toBe(true);
  });

  test("a file carried from another draft id is not bound here", () => {
    const d = acked(draft({ files: [{ file: permit, lineage: "draft-older" }] }));
    expect(view(d)).toMatchObject({ key: "detached", state: "attention" });
  });
});

describe("the rev 4 §1 matrix", () => {
  test("empty: hidden, with nothing at risk", () => {
    const v = view(draft({ text: "" }));
    expect(v).toEqual({ key: "none" });
    expect(draftIndicatorAtRisk(v)).toBe(false);
    expect(view(undefined)).toEqual({ key: "none" });
  });

  test("offline: attention, with the last saved time or never", () => {
    expect(view(draft(), { online: false })).toMatchObject({ key: "offline", state: "attention", summary: "Not saved: offline. Your text is kept in this tab.", facts: [{ key: "Last saved", value: "never" }] });
    const earlier = acked(draft(), 2);
    expect(view(earlier, { online: false })).toMatchObject({ facts: [{ key: "Last saved", value: "10:42" }] });
    // Offline says nothing against what the host already acknowledged.
    expect(shown(view(acked(draft()), { online: false }))).toBe("success");
  });

  test("an answer lost: unknown, with Check again, and the earlier confirmation", () => {
    const d = acked(draft({ failure: { kind: "unsaved", lost: true } }), 2);
    const v = view(d);
    expect(v).toMatchObject({ key: "unconfirmed", state: "unknown", summary: "Couldn't confirm the draft was saved.", action: "check" });
    expect(v.key !== "none" && v.facts).toEqual([{ key: "Confirmed", value: "10:42 · earlier revision" }, { key: "This tab", value: "edited 10:42" }]);
  });

  test("an upload failed, or its answer is unknown", () => {
    expect(view(draft(), { queued: [queued("dock-walk.mov", "failed")] })).toMatchObject({ key: "upload_failed", state: "failed", summary: "Draft not saved: 1 file wasn't stored.", facts: [{ key: "Not stored", value: "dock-walk.mov" }] });
    expect(view(draft(), { queued: [queued("minutes-2026-07-12.docx", "unknown")] })).toMatchObject({ key: "upload_unconfirmed", state: "unknown", summary: "Not saved yet: 1 upload unconfirmed." });
  });

  test("a space refusal: refused, with Open Storage; another refusal has no Storage action", () => {
    const v = view(draft(), { queued: [queued("crew-roster.xlsx", "refused", { refusal: "space" })] });
    expect(v).toMatchObject({ key: "upload_refused", state: "refused", summary: "Draft not saved: attachment space is full.", action: "storage" });
    expect(v.key !== "none" && v.facts).toEqual([{ key: "Not stored", value: "crew-roster.xlsx, 4.1 KB" }, { key: "Space", value: "attachment space full" }]);
    const size = view(draft(), { queued: [queued("crew-roster.xlsx", "refused", { refusal: "size" })] });
    expect(size).toMatchObject({ state: "refused", summary: "Draft not saved: 1 file wasn't stored." });
    expect(size.key !== "none" && size.action).toBeUndefined();
  });

  test("today's facts stay states: too large, full, another device's version, another tab's", () => {
    expect(view(draft({ failure: { kind: "too_large", limit: 8_388_608, bound: "draft" } }))).toMatchObject({ key: "too_large", state: "refused", summary: "Draft not saved: too large to save (8 MB max). Your text is kept on this device." });
    expect(view(draft({ failure: { kind: "full", limit: 100, bound: "drafts" } }))).toMatchObject({ key: "full", state: "refused", summary: "Draft not saved: 100 drafts saved. Delete one to save this." });
    const other = { draftId: "draft-ithaca", sessionId: "odysseus-ithaca", revision: 5, updatedAt: AT_1042, text: "Ask Aeolus", attachments: [] };
    expect(view(draft({ text: "", conflict: { other, sameId: true } }))).toMatchObject({ key: "conflict", state: "attention", action: "compare" });
    expect(view(draft({ deviceConflict: { otherId: "draft-other", sessionId: null } }))).toMatchObject({ key: "device_conflict", action: "other_version", summary: "Another tab changed this draft. Both versions are kept." });
    expect(view(draft(), { store: { supported: false, limits: { maxTextBytes: 1, maxDraftBytes: 1, maxDrafts: 1, maxTotalBytes: 1 } } })).toMatchObject({ key: "unavailable", summary: "Not saved: this host doesn't keep drafts. Your text is kept on this device." });
  });
});
