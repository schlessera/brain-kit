import { describe, expect, test } from "bun:test";
import { SEND_HOLD_SENTENCES as S, sendHold, type SendHold, type SendHoldDraft, type SendHoldFacts, type SendPath } from "../src/lib/send-hold";

// The composer's send rules as one table (#4829): what each path does with
// the same facts. No React, no store, no DOM.
const draft = (over: Partial<SendHoldDraft> = {}): SendHoldDraft => ({
  foreignFiles: false, hasFiles: false, refusedThisEdit: false, saveFailed: false, conflict: false,
  acknowledged: true, framesReady: () => true, waitsForLastMessage: false, ...over,
});
const facts = (path: SendPath, over: Partial<Omit<SendHoldFacts, "path">> = {}): SendHoldFacts => ({
  path, tracks: { failed: false, pending: false }, queued: { blocking: false, pending: false }, draft: draft(), answer: false, ...over,
});
const blocked = (sentence: string): SendHold => ({ kind: "blocked", sentence });
const SEND: SendHold = { kind: "send" }, PENDING: SendHold = { kind: "pending" }, ANSWER: SendHold = { kind: "answer" };

const rows: Array<[string, SendHoldFacts, SendHold]> = [
  ["plain send, direct", facts("direct"), SEND],
  ["plain send, snapshot", facts("snapshot"), SEND],
  ["plain send, no draft yet", facts("direct", { draft: null }), SEND],
  ["a failed track", facts("direct", { tracks: { failed: true, pending: true } }), blocked(S.failedTrack)],
  ["a pending track waits", facts("direct", { tracks: { failed: false, pending: true } }), PENDING],
  ["a queued file that was not stored", facts("direct", { queued: { blocking: true, pending: true } }), blocked(S.unstoredFile)],
  ["files marked not attached", facts("direct", { draft: draft({ foreignFiles: true, hasFiles: true }) }), blocked(S.unattachedFiles)],
  ["a pending queued file waits", facts("direct", { queued: { blocking: false, pending: true } }), PENDING],
  ["a refused save of the current edit, with files", facts("direct", { draft: draft({ hasFiles: true, refusedThisEdit: true }) }), blocked(S.refusedSave)],
  ["files that could not be saved with the draft", facts("direct", { draft: draft({ hasFiles: true, saveFailed: true }) }), blocked(S.unsavedFiles)],
  ["a conflicted draft with files, direct", facts("direct", { draft: draft({ hasFiles: true, conflict: true }) }), blocked(S.conflictFiles)],
  ["an unacknowledged draft with files waits", facts("direct", { draft: draft({ hasFiles: true, acknowledged: false }) }), PENDING],
  ["an image frame still being made waits", facts("direct", { draft: draft({ hasFiles: true, framesReady: () => false }) }), PENDING],
  ["the last message is not yet saved, direct", facts("direct", { draft: draft({ waitsForLastMessage: true }) }), blocked(S.lastMessage)],
  ["the last message is not yet saved, snapshot", facts("snapshot", { draft: draft({ waitsForLastMessage: true }) }), blocked(S.lastMessage)],
  ["a typed answer, direct", facts("direct", { answer: true, draft: draft({ waitsForLastMessage: true }) }), ANSWER],
  ["a typed answer, snapshot", facts("snapshot", { answer: true }), ANSWER],
  // The difference between the paths, pinned: a conflict without files.
  ["a conflicted draft without files, direct: not refused by the file rules", facts("direct", { draft: draft({ conflict: true }) }), SEND],
  ["a conflicted draft without files, snapshot: refused", facts("snapshot", { draft: draft({ conflict: true }) }), blocked(S.conflict)],
  ["snapshot: a refused save does not hold Send", facts("snapshot", { draft: draft({ hasFiles: true, refusedThisEdit: true }) }), SEND],
  ["snapshot: files that could not be saved, even without files listed", facts("snapshot", { draft: draft({ saveFailed: true }) }), blocked(S.unsavedFiles)],
  ["snapshot: a pending queued file is carried, not waited for", facts("snapshot", { queued: { blocking: false, pending: true } }), SEND],
  ["snapshot: a queued file that was not stored", facts("snapshot", { queued: { blocking: true, pending: false } }), blocked(S.unstoredFile)],
  ["snapshot: files marked not attached", facts("snapshot", { draft: draft({ foreignFiles: true, hasFiles: true }) }), blocked(S.unattachedFiles)],
  ["direct: a pending track waits before a file refusal", facts("direct", { tracks: { failed: false, pending: true }, queued: { blocking: true, pending: false } }), PENDING],
  ["held: a file refusal wins over a pending track", facts("held", { tracks: { failed: false, pending: true }, queued: { blocking: true, pending: false } }), blocked(S.unstoredFile)],
  ["held: a pending track still waits", facts("held", { tracks: { failed: false, pending: true } }), PENDING],
  ["held: released once nothing holds it, whatever follows", facts("held", { answer: true, draft: draft({ waitsForLastMessage: true }) }), SEND],
];

describe("sendHold", () => {
  for (const [name, input, expected] of rows) test(name, () => expect(sendHold(input)).toEqual(expected));

  test("an image frame is read only once the other file rules pass", () => {
    let reads = 0;
    sendHold(facts("direct", { draft: draft({ hasFiles: true, acknowledged: false, framesReady: () => (reads++, true) }) }));
    sendHold(facts("direct", { draft: draft({ framesReady: () => (reads++, true) }) }));
    expect(reads).toBe(0);
  });
});
