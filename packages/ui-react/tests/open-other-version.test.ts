import { afterEach, expect, test } from "bun:test";
import { createBrainUiRoot, type BrainUiRoot } from "../src/root.ts";
import { openOtherVersion } from "../src/components/chat/draft-save-line.tsx";
import { draftIndicatorView } from "../src/lib/draft-indicator.ts";
import { restorationOf } from "../src/stores/chat-state.ts";
import type { LocalDraft } from "../src/stores/draft-state.ts";

// Open other version (#4567) always ends at the other version's content: in
// its live chat, where a rotation moved it, or on its own in the new-chat
// view when it has no chat or its chat is gone. A switch that is cancelled
// or fails says so on the draft it left. Never an empty new chat.
// Odysseus fixtures; no host, no network.

const ITHACA = "odysseus-ithaca";
const RAFT = "odysseus-raft";
const BRANCH = "voyage-branch";
const OTHER_TEXT = "Penelope keeps the loom";
const roots: BrainUiRoot[] = [];
afterEach(() => { for (const r of roots.splice(0)) r.dispose(); });
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * This tab continues the voyage on a device branch of Ithaca's draft; the
 * other version, as another tab kept it, is `other`.
 */
function scene(other: Partial<LocalDraft> = {}) {
  const root = createBrainUiRoot({ storage: null, request: async () => Response.json({}) });
  roots.push(root);
  const drafts = root.stores.drafts;
  const chat = root.stores.chat;
  chat.getState().setActiveSession(ITHACA);
  const original = drafts.getState().idFor(ITHACA);
  drafts.getState().edit(original, ITHACA, { text: "Telemachus keeps the voyage" });
  const kept: LocalDraft = { draftId: original, sessionId: ITHACA, text: OTHER_TEXT, attachments: [], editedAt: 1,
    host: { revision: 2, sessionId: ITHACA, updatedAt: 1, clean: false }, ...other };
  drafts.getState().keepDeviceBranch(original, BRANCH, kept, ITHACA);
  expect(drafts.getState().idFor(ITHACA), "this tab shows its own branch").toBe(BRANCH);
  /** What the composer shows now: the view's session, and its draft's text. */
  const shown = () => {
    const sessionId = chat.getState().activeSessionId;
    const s = drafts.getState();
    return { sessionId, text: s.drafts[s.idFor(sessionId)]?.text ?? "" };
  };
  return { root, drafts, chat, original, shown };
}

test("a live chat: the other version opens in it", () => {
  const s = scene();
  openOtherVersion(s.root, s.original, BRANCH);
  expect(s.shown()).toEqual({ sessionId: ITHACA, text: OTHER_TEXT });
});

test("case 1: a version a rotation moved off its id opens where it lives now, not as an empty new chat", async () => {
  const s = scene();
  // The host took the delete while it was edited: its content moves to a new id of the same chat.
  s.drafts.getState().removed(s.original);
  expect(s.drafts.getState().drafts[s.original], "no longer under its own id").toBeUndefined();
  openOtherVersion(s.root, s.original, BRANCH);
  await turn();
  expect(s.shown(), "OTHER_VERSION_MOVED").toEqual({ sessionId: ITHACA, text: OTHER_TEXT });
});

test("case 2: a version moved off a deleted chat opens on its own, labelled as not in a chat", async () => {
  const s = scene();
  // Deleted elsewhere while edited here: the content becomes a draft of no chat.
  s.drafts.getState().hostGone(s.original);
  openOtherVersion(s.root, s.original, BRANCH);
  await turn();
  expect(s.shown(), "OTHER_VERSION_NO_CHAT").toEqual({ sessionId: null, text: OTHER_TEXT });
  const at = s.drafts.getState().fresh;
  expect(s.drafts.getState().versionSwitch).toEqual({ draftId: at, outcome: "unattached" });
});

test("case 3: a version whose chat turns out to be gone moves off it and opens on its own", async () => {
  const s = scene({ sessionId: RAFT, host: { revision: 2, sessionId: RAFT, updatedAt: 1, clean: true } });
  openOtherVersion(s.root, s.original, BRANCH);
  await turn();
  expect(s.shown()).toEqual({ sessionId: RAFT, text: OTHER_TEXT });
  // The resume finds no such conversation on this host.
  s.chat.getState().failRestore(RAFT, { reason: "missing", message: "No session odysseus-raft." });
  expect(restorationOf(s.chat.getState()), "OTHER_VERSION_CHAT_GONE: not left on Conversation unavailable").toBeNull();
  expect(s.shown()).toEqual({ sessionId: null, text: OTHER_TEXT });
  expect(s.drafts.getState().versionSwitch).toMatchObject({ outcome: "unattached", draftId: s.drafts.getState().fresh });
  // It is a draft of no chat now: sending starts one, and Raft's view has nothing of it.
  expect(s.drafts.getState().drafts[s.drafts.getState().fresh]?.sessionId).toBeNull();
  expect(s.drafts.getState().drafts[s.drafts.getState().idFor(RAFT)]).toBeUndefined();
});

test("a version whose restore fails for another reason stays in its chat, with that state's own Retry", async () => {
  const s = scene({ sessionId: RAFT, host: { revision: 2, sessionId: RAFT, updatedAt: 1, clean: true } });
  openOtherVersion(s.root, s.original, BRANCH);
  await turn();
  s.chat.getState().failRestore(RAFT, { reason: "timeout" });
  expect(s.shown()).toEqual({ sessionId: RAFT, text: OTHER_TEXT });
  expect(s.drafts.getState().versionSwitch).toBeNull();
});

/** A device store whose read waits until released, so a navigation can cancel it. */
function slowDevice(root: BrainUiRoot) {
  let release!: () => void;
  let fail!: (error: Error) => void;
  const read = new Promise<void>((resolve, reject) => { release = resolve; fail = reject; });
  root.localWork = { openDeviceVersion: () => read, dispose() {} } as unknown as NonNullable<BrainUiRoot["localWork"]>;
  return { release, fail };
}

/** The indicator's view of a draft, with the note its component reads from the store. Its DOM is proved in Chromium. */
function summary(root: BrainUiRoot, draftId: string) {
  const s = root.stores.drafts.getState();
  const note = s.versionSwitch?.draftId === draftId && s.versionSwitch.outcome !== "unattached" ? s.versionSwitch.outcome : null;
  const view = draftIndicatorView({ draft: s.drafts[draftId], store: s, queued: [], online: true, switchNote: note });
  return view.key === "none" ? "" : view.summary;
}

test("a switch cancelled by navigation says so on the draft it left, in the indicator and the save line", async () => {
  const s = scene();
  const device = slowDevice(s.root);
  openOtherVersion(s.root, s.original, BRANCH);
  // The reader opens another panel while the device read is out.
  s.root.stores.ui.getState().setActiveView("activity");
  device.release();
  await turn();
  s.root.localWork = null;
  expect(s.shown(), "the view is the reader's, untouched").toEqual({ sessionId: ITHACA, text: "Telemachus keeps the voyage" });
  expect(s.drafts.getState().versionSwitch, "SWITCH_CANCELLED_NOTED").toEqual({ draftId: BRANCH, outcome: "cancelled" });
  expect(summary(s.root, BRANCH)).toBe("Another tab changed this draft. Both versions are kept. Other version not opened: you moved away first.");
  // The next try clears it.
  openOtherVersion(s.root, s.original, BRANCH);
  expect(s.drafts.getState().versionSwitch?.outcome).not.toBe("cancelled");
});

test("a switch whose device read fails says so instead of doing nothing", async () => {
  const s = scene();
  const device = slowDevice(s.root);
  openOtherVersion(s.root, s.original, BRANCH);
  device.fail(new Error("partition refused"));
  await turn();
  s.root.localWork = null;
  expect(s.drafts.getState().versionSwitch, "SWITCH_FAILED_NOTED").toEqual({ draftId: BRANCH, outcome: "failed" });
  expect(summary(s.root, BRANCH)).toBe("Another tab changed this draft. Both versions are kept. Couldn't open the other version.");
  expect(s.shown()).toEqual({ sessionId: ITHACA, text: "Telemachus keeps the voyage" });
});

test("a version found nowhere says so, and the view stays", async () => {
  const s = scene();
  s.drafts.setState((st) => { const d = { ...st.drafts }; delete d[s.original]; return { drafts: d }; });
  openOtherVersion(s.root, s.original, BRANCH);
  await turn();
  expect(s.drafts.getState().versionSwitch).toEqual({ draftId: BRANCH, outcome: "missing" });
  expect(summary(s.root, BRANCH)).toBe("Another tab changed this draft. Both versions are kept. The other version isn't on this device any more.");
  expect(s.shown()).toEqual({ sessionId: ITHACA, text: "Telemachus keeps the voyage" });
});

test("a chat whose transcript was cached still moves the version off it when the resume says it is gone", async () => {
  const s = scene({ sessionId: RAFT, host: { revision: 2, sessionId: RAFT, updatedAt: 1, clean: true } });
  // Raft was visited before: its transcript is cached and confirmed.
  s.chat.getState().setActiveSession(RAFT);
  s.chat.setState((c) => ({ buffers: { ...c.buffers, [RAFT]: { ...c.buffers[RAFT]!, historyConfirmed: true } } }));
  s.chat.getState().setActiveSession(ITHACA);
  openOtherVersion(s.root, s.original, BRANCH);
  await turn();
  s.chat.getState().failRestore(RAFT, { reason: "missing", message: "No session odysseus-raft." });
  expect(s.shown(), "CACHED_CHAT_GONE").toEqual({ sessionId: null, text: OTHER_TEXT });
});

test("a timeout, then Retry answering that the chat is gone, still moves the version off it", async () => {
  const s = scene({ sessionId: RAFT, host: { revision: 2, sessionId: RAFT, updatedAt: 1, clean: true } });
  openOtherVersion(s.root, s.original, BRANCH);
  await turn();
  s.chat.getState().failRestore(RAFT, { reason: "timeout" });
  s.chat.getState().clearRestoreFailure(RAFT);
  s.chat.getState().failRestore(RAFT, { reason: "missing", message: "No session odysseus-raft." });
  expect(s.shown(), "RETRY_THEN_GONE").toEqual({ sessionId: null, text: OTHER_TEXT });
});

test("a reader who moved to another view before the chat answered is left alone", async () => {
  const s = scene({ sessionId: RAFT, host: { revision: 2, sessionId: RAFT, updatedAt: 1, clean: true } });
  openOtherVersion(s.root, s.original, BRANCH);
  await turn();
  s.root.stores.ui.getState().setActiveView("activity");
  s.chat.getState().failRestore(RAFT, { reason: "missing", message: "No session odysseus-raft." });
  expect(s.chat.getState().activeSessionId, "NAVIGATED_AWAY_UNTOUCHED").toBe(RAFT);
  expect(s.drafts.getState().drafts[s.original]?.sessionId, "the version stays where it was").toBe(RAFT);
  expect(s.drafts.getState().versionSwitch).toBeNull();
});

test("a version holding outgoing messages keeps them with its gone chat, and its composer text opens on its own, labelled", async () => {
  const s = scene({ sessionId: RAFT, host: { revision: 2, sessionId: RAFT, updatedAt: 1, clean: true } });
  const message = { type: "chat_message" as const, text: "Lash the raft", sessionId: RAFT, requestId: "req-raft" };
  s.drafts.getState().createSnapshot(s.original, RAFT, { snapshotId: "snap-raft", requestId: "req-raft", text: "Lash the raft", files: [], state: "returned", createdAt: 1, message }, "");
  openOtherVersion(s.root, s.original, BRANCH);
  await turn();
  const editBefore = s.drafts.getState().drafts[s.original]!.edit;
  s.chat.getState().failRestore(RAFT, { reason: "missing", message: "No session odysseus-raft." });
  const d = s.drafts.getState().drafts[s.original];
  expect(d?.snapshots?.map((x) => x.text), "SNAPSHOTS_NOT_DROPPED").toEqual(["Lash the raft"]);
  expect(d?.sessionId).toBe(RAFT);
  expect(d?.text, "the gone chat's draft is left untouched, so nothing is saved to a chat that is gone").toBe(OTHER_TEXT);
  expect(d?.edit, "NO_EDIT_IN_GONE_CHAT").toBe(editBefore);
  expect(s.shown(), "SNAPSHOT_VERSION_TEXT_UNATTACHED").toEqual({ sessionId: null, text: OTHER_TEXT });
  const copy = s.drafts.getState().fresh;
  expect(s.drafts.getState().versionSwitch).toMatchObject({ outcome: "unattached", draftId: copy });
  // The branch's other version is the copy now: opening it again lands there, not in the gone chat.
  expect(s.drafts.getState().drafts[BRANCH]?.deviceConflict?.otherId, "BRANCH_LINKED_TO_COPY").toBe(copy);
  s.chat.getState().setActiveSession(ITHACA);
  s.drafts.getState().showDeviceBranch(ITHACA, BRANCH);
  openOtherVersion(s.root, copy, BRANCH);
  await turn();
  expect(s.shown()).toEqual({ sessionId: null, text: OTHER_TEXT });
});

test("a second Open other version still finds a version a rotation moved, and one moved during the device read", async () => {
  const s = scene();
  s.drafts.getState().hostGone(s.original);
  openOtherVersion(s.root, s.original, BRANCH);
  await turn();
  expect(s.shown()).toEqual({ sessionId: null, text: OTHER_TEXT });
  // Back to the branch's chat, and Open other version again.
  s.chat.getState().setActiveSession(ITHACA);
  s.drafts.getState().showDeviceBranch(ITHACA, BRANCH);
  openOtherVersion(s.root, s.original, BRANCH);
  await turn();
  expect(s.shown(), "SECOND_ATTEMPT_FINDS_IT").toEqual({ sessionId: null, text: OTHER_TEXT });

  const t = scene();
  const device = slowDevice(t.root);
  openOtherVersion(t.root, t.original, BRANCH);
  t.drafts.getState().hostGone(t.original);
  device.release();
  await turn();
  t.root.localWork = null;
  expect(t.shown(), "ROTATED_DURING_READ").toEqual({ sessionId: null, text: OTHER_TEXT });
});

test("opening a version of no chat sets aside the previous new chat's pending first message, as a Draft entry does", async () => {
  const s = scene();
  s.drafts.getState().hostGone(s.original);
  // A new chat's first message is waiting for its session.
  s.chat.getState().setActiveSession(null);
  s.chat.getState().addUserMessage(null, "Sail for Ithaca at dawn", "typed");
  s.chat.getState().startDraftTurn();
  s.chat.getState().setActiveSession(ITHACA);
  expect(s.chat.getState().pendingDraftId).not.toBeNull();
  openOtherVersion(s.root, s.original, BRANCH);
  await turn();
  expect(s.chat.getState().pendingDraftId, "PENDING_TURN_SET_ASIDE").toBeNull();
  expect(Object.keys(s.chat.getState().detachedDrafts), "kept aside for its own session").toHaveLength(1);
  expect(s.shown()).toEqual({ sessionId: null, text: OTHER_TEXT });
});

test("a failed switch is still said when the device write failed too", () => {
  const s = scene();
  s.drafts.getState().noteVersionSwitch({ draftId: BRANCH, outcome: "failed" });
  const st = s.drafts.getState();
  const view = draftIndicatorView({ draft: st.drafts[BRANCH], store: st, queued: [], online: true, localFailed: true, switchNote: "failed" });
  expect(view, "SWITCH_NOTE_WITH_LOCAL_FAILURE").toMatchObject({ key: "device_conflict", summary: "Couldn't open the other version.", action: "other_version" });
});

test("a device tombstone left under the old id does not hide where a rotation moved the version", async () => {
  const s = scene();
  s.drafts.getState().hostGone(s.original);
  // The device read finds the emptied record this device kept under the old id, and adopts it.
  s.root.localWork = { openDeviceVersion: async (id: string) => {
    s.drafts.getState().openDeviceVersion(id, { draftId: id, sessionId: ITHACA, text: "", attachments: [], editedAt: 2, host: null });
  }, dispose() {} } as unknown as NonNullable<BrainUiRoot["localWork"]>;
  openOtherVersion(s.root, s.original, BRANCH);
  await turn();
  s.root.localWork = null;
  expect(s.shown(), "TOMBSTONE_SKIPPED").toEqual({ sessionId: null, text: OTHER_TEXT });
});

/** A device read that adopts `record` for the id it is asked about. */
function deviceKeeps(root: BrainUiRoot, record: (id: string) => LocalDraft | undefined) {
  root.localWork = { openDeviceVersion: async (id: string) => { root.stores.drafts.getState().openDeviceVersion(id, record(id)); }, dispose() {} } as unknown as NonNullable<BrainUiRoot["localWork"]>;
}
const PERMIT_FILE = { fileId: "2c7e1a90-5d3f-4b8e-a1c6-9f0d2e4b7a31", name: "ithaca-permit.pdf", path: ".brain-ui/attachments/2c7e1a90-5d3f-4b8e-a1c6-9f0d2e4b7a31/ithaca-permit.pdf", mediaType: "application/pdf", bytes: 2_400_000, sha256: "b".repeat(64), kind: "pdf", reader: "pdf" } as const;

test("a device tombstone that kept its files does not hide where the rotation moved the version, on a first or a second open", async () => {
  const s = scene();
  s.drafts.getState().hostGone(s.original);
  deviceKeeps(s.root, (id) => ({ draftId: id, sessionId: ITHACA, text: "", attachments: [], files: [{ file: PERMIT_FILE, lineage: id }], editedAt: 2, host: null }));
  openOtherVersion(s.root, s.original, BRANCH);
  await turn();
  expect(s.shown(), "TOMBSTONE_WITH_FILES_SKIPPED").toEqual({ sessionId: null, text: OTHER_TEXT });
  s.chat.getState().setActiveSession(ITHACA);
  s.drafts.getState().showDeviceBranch(ITHACA, BRANCH);
  openOtherVersion(s.root, s.original, BRANCH);
  await turn();
  s.root.localWork = null;
  expect(s.shown(), "SECOND_OPEN_AFTER_TOMBSTONE").toEqual({ sessionId: null, text: OTHER_TEXT });
});

test("a missing version opened from a branch of no chat leaves the reader on that branch", async () => {
  const root = createBrainUiRoot({ storage: null, request: async () => Response.json({}) });
  roots.push(root);
  const drafts = root.stores.drafts;
  const original = drafts.getState().fresh;
  drafts.getState().edit(original, null, { text: "Telemachus checks the harbour" });
  drafts.getState().keepDeviceBranch(original, BRANCH, { draftId: original, sessionId: null, text: OTHER_TEXT, attachments: [], editedAt: 1, host: null }, null);
  drafts.setState((st) => { const d = { ...st.drafts }; delete d[original]; return { drafts: d }; });
  deviceKeeps(root, (id) => ({ draftId: id, sessionId: null, text: "", attachments: [], editedAt: 2, host: null }));
  openOtherVersion(root, original, BRANCH);
  await turn();
  root.localWork = null;
  expect(drafts.getState().versionSwitch).toEqual({ draftId: BRANCH, outcome: "missing" });
  expect(drafts.getState().fresh, "UNBOUND_BRANCH_KEPT_IN_VIEW").toBe(BRANCH);
  expect(drafts.getState().drafts[BRANCH]?.text).toBe("Telemachus checks the harbour");
});

test("the gone-chat watcher follows a version a refresh moved off its chat meanwhile", async () => {
  const s = scene({ sessionId: RAFT, host: { revision: 2, sessionId: RAFT, updatedAt: 1, clean: false } });
  openOtherVersion(s.root, s.original, BRANCH);
  await turn();
  // A host refresh finds it deleted: dirty, it moves to a draft of no chat.
  s.drafts.getState().hostGone(s.original);
  s.chat.getState().failRestore(RAFT, { reason: "missing", message: "No session odysseus-raft." });
  expect(s.shown(), "WATCHER_FOLLOWS_MOVED_VERSION").toEqual({ sessionId: null, text: OTHER_TEXT });
  expect(s.drafts.getState().versionSwitch?.outcome).toBe("unattached");
});

test("a tombstone adopted on the first open keeps the rotation for every later open", async () => {
  const s = scene();
  s.drafts.getState().hostGone(s.original);
  deviceKeeps(s.root, (id) => ({ draftId: id, sessionId: ITHACA, text: "", attachments: [], files: [{ file: PERMIT_FILE, lineage: id }], editedAt: 2, host: null }));
  for (let n = 1; n <= 3; n++) {
    s.chat.getState().setActiveSession(ITHACA);
    s.drafts.getState().showDeviceBranch(ITHACA, BRANCH);
    openOtherVersion(s.root, s.original, BRANCH);
    await turn();
    expect(s.shown(), `OPEN_${n}_AFTER_TOMBSTONE`).toEqual({ sessionId: null, text: OTHER_TEXT });
  }
  s.root.localWork = null;
});

test("a version that rotates during the device read is found where it moved, past a tombstone with files", async () => {
  const s = scene();
  s.root.localWork = { openDeviceVersion: async (id: string) => {
    s.drafts.getState().hostGone(id);
    s.drafts.getState().openDeviceVersion(id, { draftId: id, sessionId: ITHACA, text: "", attachments: [], files: [{ file: PERMIT_FILE, lineage: id }], editedAt: 2, host: null });
  }, dispose() {} } as unknown as NonNullable<BrainUiRoot["localWork"]>;
  openOtherVersion(s.root, s.original, BRANCH);
  await turn();
  s.root.localWork = null;
  expect(s.shown(), "ROTATED_DURING_READ_PAST_TOMBSTONE").toEqual({ sessionId: null, text: OTHER_TEXT });
});

test("a version deleted elsewhere while its chat restore is pending returns the reader to their branch, saying so", async () => {
  const s = scene({ sessionId: RAFT, host: { revision: 2, sessionId: RAFT, updatedAt: 1, clean: true } });
  openOtherVersion(s.root, s.original, BRANCH);
  await turn();
  // Clean, and gone from the host: it goes here too.
  s.drafts.getState().hostGone(s.original);
  s.chat.getState().failRestore(RAFT, { reason: "missing", message: "No session odysseus-raft." });
  expect(s.shown(), "BACK_TO_BRANCH").toEqual({ sessionId: ITHACA, text: "Telemachus keeps the voyage" });
  expect(s.drafts.getState().versionSwitch).toEqual({ draftId: BRANCH, outcome: "missing" });
});

test("a device-only transcript copied off a gone chat stays device-only", () => {
  const s = scene({ sessionId: RAFT, host: { revision: 2, sessionId: RAFT, updatedAt: 1, clean: true }, deviceOnly: true });
  const message = { type: "chat_message" as const, text: "Lash the raft", sessionId: RAFT, requestId: "req-raft" };
  s.drafts.getState().createSnapshot(s.original, RAFT, { snapshotId: "snap-raft", requestId: "req-raft", text: "Lash the raft", files: [], state: "returned", createdAt: 1, message }, "");
  s.drafts.setState((st) => ({ drafts: { ...st.drafts, [s.original]: { ...st.drafts[s.original]!, deviceOnly: true } } }));
  const copy = s.drafts.getState().detachVersion(s.original)!;
  expect(s.drafts.getState().drafts[copy]?.deviceOnly, "DEVICE_ONLY_KEPT").toBe(true);
});

test("a version holding only outgoing messages whose chat is gone returns the reader to their branch, saying why", async () => {
  const s = scene({ sessionId: RAFT, text: "", host: { revision: 2, sessionId: RAFT, updatedAt: 1, clean: true } });
  const message = { type: "chat_message" as const, text: "Lash the raft", sessionId: RAFT, requestId: "req-raft" };
  s.drafts.getState().createSnapshot(s.original, RAFT, { snapshotId: "snap-raft", requestId: "req-raft", text: "Lash the raft", files: [], state: "returned", createdAt: 1, message }, "");
  openOtherVersion(s.root, s.original, BRANCH);
  await turn();
  s.chat.getState().failRestore(RAFT, { reason: "missing", message: "No session odysseus-raft." });
  expect(s.shown(), "SNAPSHOT_ONLY_BACK_TO_BRANCH").toEqual({ sessionId: ITHACA, text: "Telemachus keeps the voyage" });
  expect(s.drafts.getState().versionSwitch).toEqual({ draftId: BRANCH, outcome: "chat_gone" });
  expect(s.drafts.getState().drafts[s.original]?.snapshots?.map((x) => x.text)).toEqual(["Lash the raft"]);
});

test("returning to a branch of no chat takes the gone chat off the screen", async () => {
  const root = createBrainUiRoot({ storage: null, request: async () => Response.json({}) });
  roots.push(root);
  const drafts = root.stores.drafts;
  const chat = root.stores.chat;
  const original = drafts.getState().fresh;
  drafts.getState().edit(original, null, { text: "Telemachus checks the harbour" });
  drafts.getState().keepDeviceBranch(original, BRANCH, { draftId: original, sessionId: RAFT, text: "", attachments: [], editedAt: 1, host: { revision: 2, sessionId: RAFT, updatedAt: 1, clean: true } }, null);
  const message = { type: "chat_message" as const, text: "Lash the raft", sessionId: RAFT, requestId: "req-raft" };
  drafts.getState().createSnapshot(original, RAFT, { snapshotId: "snap-raft", requestId: "req-raft", text: "Lash the raft", files: [], state: "returned", createdAt: 1, message }, "");
  openOtherVersion(root, original, BRANCH);
  await turn();
  expect(chat.getState().activeSessionId).toBe(RAFT);
  chat.getState().failRestore(RAFT, { reason: "missing", message: "No session odysseus-raft." });
  expect(chat.getState().activeSessionId, "GONE_CHAT_OFF_SCREEN").toBeNull();
  expect(drafts.getState().fresh).toBe(BRANCH);
  expect(drafts.getState().versionSwitch).toEqual({ draftId: BRANCH, outcome: "chat_gone" });
});

test("a missing version opened from a branch of no chat already in view leaves its transcript and pending first message", async () => {
  const root = createBrainUiRoot({ storage: null, request: async () => Response.json({}) });
  roots.push(root);
  const drafts = root.stores.drafts;
  const chat = root.stores.chat;
  const original = drafts.getState().fresh;
  drafts.getState().edit(original, null, { text: "Telemachus checks the harbour" });
  drafts.getState().keepDeviceBranch(original, BRANCH, { draftId: original, sessionId: null, text: OTHER_TEXT, attachments: [], editedAt: 1, host: null }, null);
  chat.getState().addUserMessage(null, "Sail for Ithaca at dawn", "typed");
  chat.getState().startDraftTurn();
  drafts.setState((st) => { const d = { ...st.drafts }; delete d[original]; return { drafts: d }; });
  openOtherVersion(root, original, BRANCH);
  await turn();
  expect(drafts.getState().versionSwitch).toEqual({ draftId: BRANCH, outcome: "missing" });
  expect(chat.getState().pendingDraftId, "PENDING_TURN_KEPT").not.toBeNull();
  expect(chat.getState().draft?.messages.length).toBeGreaterThan(0);
});

test("a missing version from a branch that gained its own chat returns to that chat", async () => {
  const s = scene({ sessionId: RAFT, host: { revision: 2, sessionId: RAFT, updatedAt: 1, clean: true } });
  // The branch was sent as a new conversation: it is that chat's draft now.
  s.drafts.setState((st) => ({ drafts: { ...st.drafts, [BRANCH]: { ...st.drafts[BRANCH]!, sessionId: "odysseus-voyage" } } }));
  s.chat.getState().setActiveSession("odysseus-voyage");
  openOtherVersion(s.root, s.original, BRANCH);
  await turn();
  s.drafts.getState().hostGone(s.original);
  s.chat.getState().failRestore(RAFT, { reason: "missing", message: "No session odysseus-raft." });
  expect(s.chat.getState().activeSessionId, "BACK_TO_BRANCH_CHAT").toBe("odysseus-voyage");
  expect(s.drafts.getState().versionSwitch).toEqual({ draftId: BRANCH, outcome: "missing" });
});

test("a panel open when the switch lands does not end the gone-chat watch", async () => {
  const s = scene({ sessionId: RAFT, host: { revision: 2, sessionId: RAFT, updatedAt: 1, clean: true } });
  s.root.stores.ui.setState({ filePanelOpen: true } as never);
  openOtherVersion(s.root, s.original, BRANCH);
  await turn();
  s.chat.getState().failRestore(RAFT, { reason: "missing", message: "No session odysseus-raft." });
  expect(s.shown(), "PANEL_CLOSE_KEEPS_WATCH").toEqual({ sessionId: null, text: OTHER_TEXT });
});

test("a failed switch is said on the branch the reader is on now, after a fork during the read", async () => {
  const s = scene();
  const device = slowDevice(s.root);
  openOtherVersion(s.root, s.original, BRANCH);
  // Another fork moves this tab's branch to a new id while the read is out.
  s.drafts.getState().keepDeviceBranch(BRANCH, "voyage-branch-2", { draftId: BRANCH, sessionId: null, text: "Eurylochus keeps watch", attachments: [], editedAt: 3, host: null }, ITHACA);
  device.fail(new Error("partition refused"));
  await turn();
  s.root.localWork = null;
  expect(s.drafts.getState().versionSwitch, "NOTE_ON_CURRENT_BRANCH").toEqual({ draftId: s.drafts.getState().resolveId(BRANCH), outcome: "failed" });
  expect(s.drafts.getState().resolveId(BRANCH)).toBe("voyage-branch-2");
});

test("a snapshot-only version sharing the branch's chat, gone, does not return the reader to that chat", async () => {
  const s = scene({ text: "" });
  const message = { type: "chat_message" as const, text: "Lash the raft", sessionId: ITHACA, requestId: "req-raft" };
  s.drafts.getState().createSnapshot(s.original, ITHACA, { snapshotId: "snap-raft", requestId: "req-raft", text: "Lash the raft", files: [], state: "returned", createdAt: 1, message }, "");
  openOtherVersion(s.root, s.original, BRANCH);
  await turn();
  s.chat.getState().failRestore(ITHACA, { reason: "missing", message: "No session odysseus-ithaca." });
  expect(s.chat.getState().activeSessionId, "GONE_SHARED_CHAT_LEFT").toBeNull();
  expect(s.drafts.getState().fresh).toBe(BRANCH);
  expect(s.drafts.getState().versionSwitch).toEqual({ draftId: BRANCH, outcome: "chat_gone" });
});

test("a copy off a gone chat relinks a branch that names the version through a rotation", () => {
  const s = scene({ sessionId: RAFT, host: { revision: 2, sessionId: RAFT, updatedAt: 1, clean: false } });
  s.drafts.getState().removed(s.original);
  const moved = s.drafts.getState().resolveId(s.original) === s.original ? s.drafts.getState().versionHome(s.original)! : s.drafts.getState().versionHome(s.original)!;
  const message = { type: "chat_message" as const, text: "Lash the raft", sessionId: RAFT, requestId: "req-raft" };
  s.drafts.getState().createSnapshot(moved, RAFT, { snapshotId: "snap-raft", requestId: "req-raft", text: "Lash the raft", files: [], state: "returned", createdAt: 1, message }, "");
  const copy = s.drafts.getState().detachVersion(moved)!;
  expect(s.drafts.getState().drafts[BRANCH]?.deviceConflict?.otherId, "RELINKED_THROUGH_ROTATION").toBe(copy);
});

test("returning to a branch that forked again while the chat restored follows it to its new id", async () => {
  const s = scene({ sessionId: RAFT, host: { revision: 2, sessionId: RAFT, updatedAt: 1, clean: true } });
  openOtherVersion(s.root, s.original, BRANCH);
  await turn();
  s.drafts.getState().keepDeviceBranch(BRANCH, "voyage-branch-2", { draftId: BRANCH, sessionId: null, text: "Eurylochus keeps watch", attachments: [], editedAt: 3, host: null }, ITHACA);
  s.drafts.getState().hostGone(s.original);
  s.chat.getState().failRestore(RAFT, { reason: "missing", message: "No session odysseus-raft." });
  expect(s.drafts.getState().versionSwitch, "NOTE_FOLLOWS_FORKED_BRANCH").toEqual({ draftId: "voyage-branch-2", outcome: "missing" });
});
