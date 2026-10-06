import { describe, expect, test } from "bun:test";
import type { Draft } from "@schlessera/brain-ui-sdk/protocol";
import { createDraftStore, type DraftSend } from "../src/stores/draft-state.ts";
import { draftSaveView, draftTitle, unboundDrafts } from "../src/lib/drafts.ts";
import type { PendingAttachment } from "../src/lib/image-attachments.ts";

// Per-session drafts (#951, D52 §5): the root's draft store on its own,
// without a host. Odysseus fixtures only.

const ITHACA = "odysseus-ithaca";
const RAFT = "odysseus-raft";

function image(name: string): PendingAttachment {
  return { attachment: { data: "iVBORw0KGgo=", mediaType: "image/png" }, previewUrl: `blob:fixture/${name}`, bytes: 8, name };
}

function message(text: string): DraftSend["message"] {
  return { type: "chat_message", text, source: "typed" };
}

function store() {
  const revoked: string[] = [];
  let clock = 1_000;
  const s = createDraftStore({ now: () => ++clock, revoke: (url) => revoked.push(url) });
  return { s, revoked, state: () => s.getState() };
}

function hostDraft(over: Partial<Draft> & Pick<Draft, "draftId">): Draft {
  return { sessionId: null, revision: 1, updatedAt: 5_000, text: "", attachments: [], ...over };
}

describe("draft identity", () => {
  test("each session keeps its own draft, and the new chat its own", () => {
    const { state } = store();
    const a = state().idFor(ITHACA);
    const b = state().idFor(RAFT);
    expect(a).not.toBe(b);
    // Pure: asking again names the same draft.
    expect(state().idFor(ITHACA)).toBe(a);
    const wax = image("wax.png");
    state().edit(a, ITHACA, { text: "Plug the crew's ears with wax", attachments: [wax] });
    state().edit(b, RAFT, { text: "Lash the beams" });
    expect(state().drafts[state().idFor(ITHACA)]).toMatchObject({ text: "Plug the crew's ears with wax", attachments: [wax], sessionId: ITHACA });
    expect(state().drafts[state().idFor(RAFT)]).toMatchObject({ text: "Lash the beams", attachments: [], sessionId: RAFT });
    expect(state().idFor(null)).not.toBe(a);
    expect(state().drafts[state().idFor(null)]).toBeUndefined();
  });

  test("New chat keeps the old draft and opens an empty one; empty New chats store nothing", () => {
    const { state } = store();
    const first = state().fresh;
    state().edit(first, null, { text: "Ask Eurycleia about the bath" });
    state().newChat();
    expect(state().fresh).not.toBe(first);
    expect(state().drafts[state().fresh]).toBeUndefined();
    expect(state().drafts[first]?.text).toBe("Ask Eurycleia about the bath");
    state().newChat();
    state().newChat();
    expect(Object.keys(state().drafts)).toEqual([first]);
    expect(unboundDrafts(state().drafts).map((d) => draftTitle(d))).toEqual(["Ask Eurycleia about the bath"]);
    // Its Draft entry opens it again in the new-chat view.
    state().openUnbound(first);
    expect(state().fresh).toBe(first);
  });

  test("emptying a draft that the host never had forgets it", () => {
    const { state } = store();
    const id = state().idFor(ITHACA);
    state().edit(id, ITHACA, { text: "x" });
    state().edit(id, ITHACA, { text: "" });
    expect(state().drafts[id]).toBeUndefined();
  });

  test("an images-only draft is titled by its count", () => {
    expect(draftTitle({ text: "", attachments: [image("a"), image("b")] })).toBe("Draft with 2 images");
    expect(draftTitle({ text: "\n  Harbour fees\nmore", attachments: [] })).toBe("Harbour fees");
  });
});

describe("sends are snapshots", () => {
  test("a send empties the field, and acceptance of the named revision consumes it", () => {
    const { state } = store();
    const id = state().idFor(ITHACA);
    const wax = image("wax.png");
    state().edit(id, ITHACA, { text: "Plug the ears", attachments: [wax] });
    state().setSupport(true);
    const d = state().drafts[id]!;
    state().saved(id, { revision: 3, edit: d.edit, sessionId: ITHACA, attachmentIds: ["att-1"], updatedAt: 1 }, new Map([[wax, "att-1"]]));
    const ref = state().beginSend({ requestId: "req-1", draftId: id, sessionId: ITHACA, text: "Plug the ears", attachments: [wax], message: message("Plug the ears") }, "Plug the ears");
    expect(ref).toEqual({ draftId: id, revision: 3 });
    expect(state().drafts[id]).toMatchObject({ text: "", attachments: [] });
    // The host still holds revision 3 until it accepts the message.
    expect(state().drafts[id]?.host?.revision).toBe(3);
    state().accepted("req-1", ITHACA);
    expect(state().drafts[id]).toBeUndefined();
    expect(state().sends["req-1"]?.state).toBe("accepted");
  });

  test("edits made after submitting survive acceptance, as the next revision of that session", () => {
    const { state } = store();
    const id = state().idFor(ITHACA);
    state().setSupport(true);
    state().edit(id, ITHACA, { text: "Plug the ears" });
    state().saved(id, { revision: 1, edit: state().drafts[id]!.edit, sessionId: ITHACA, attachmentIds: [], updatedAt: 1 }, new Map());
    state().beginSend({ requestId: "req-1", draftId: id, sessionId: ITHACA, text: "Plug the ears", attachments: [], message: message("Plug the ears") }, "Plug the ears");
    state().edit(id, ITHACA, { text: "And tie me to the mast" });
    state().accepted("req-1", ITHACA);
    const now = state().drafts[state().idFor(ITHACA)]!;
    expect(now.text).toBe("And tie me to the mast");
    expect(now.sessionId).toBe(ITHACA);
    // The consumed id is a tombstone on the host: the content moved to a new one.
    expect(now.draftId).not.toBe(id);
    expect(now.host).toBeNull();
    expect(state().orphans).toEqual([]);
  });

  test("a late acceptance binds only its own draft and never moves the new-chat view", () => {
    const { state } = store();
    const first = state().fresh;
    state().edit(first, null, { text: "Which harbour is safest?" });
    state().beginSend({ requestId: "req-first", draftId: first, sessionId: null, text: "Which harbour is safest?", attachments: [], message: message("Which harbour is safest?") }, "Which harbour is safest?");
    state().edit(first, null, { text: "Also ask about the fees" });
    // New chat before the host answered: a fresh draft with its own words.
    state().newChat();
    const second = state().fresh;
    state().edit(second, null, { text: "Letter to Penelope" });
    state().accepted("req-first", ITHACA);
    expect(state().fresh).toBe(second);
    expect(state().drafts[second]).toMatchObject({ text: "Letter to Penelope", sessionId: null });
    expect(state().drafts[first]).toMatchObject({ text: "Also ask about the fees", sessionId: ITHACA });
    expect(state().idFor(ITHACA)).toBe(first);
  });

  test("Edit on a new chat's held first message opens that draft in the new-chat view", () => {
    const { state } = store();
    const first = state().fresh;
    state().edit(first, null, { text: "Which harbour?" });
    state().beginSend({ requestId: "req-1", draftId: first, sessionId: null, text: "Which harbour?", attachments: [], message: message("Which harbour?") }, "Which harbour?");
    state().unconfirmed("disconnected");
    state().newChat();
    expect(state().fresh).not.toBe(first);
    state().editSend("req-1");
    expect(state().fresh).toBe(first);
    expect(state().drafts[first]?.text).toBe("Which harbour?");
  });

  test("a first save acknowledged unbound after the send bound its draft moves the content to that session", () => {
    const { state } = store();
    state().setSupport(true);
    const first = state().fresh;
    state().edit(first, null, { text: "Which harbour?" });
    state().saving(first, 1);
    state().beginSend({ requestId: "req-1", draftId: first, sessionId: null, text: "Which harbour?", attachments: [], message: message("Which harbour?") }, "Which harbour?");
    state().edit(first, null, { text: "And the fees" });
    state().accepted("req-1", ITHACA);
    // The save that was out when the message left is acknowledged now, unbound.
    state().saved(first, { revision: 1, edit: 1, sessionId: null, attachmentIds: [], updatedAt: 1 }, new Map());
    const now = state().drafts[state().idFor(ITHACA)]!;
    expect(now.draftId).not.toBe(first);
    expect(now).toMatchObject({ text: "And the fees", sessionId: ITHACA, host: null });
    expect(state().orphans).toEqual([{ draftId: first, revision: 1 }]);
  });

  test("a refused or unsent send gives its text and images back, ahead of newer edits", () => {
    const { state } = store();
    const id = state().idFor(RAFT);
    const sail = image("sail.png");
    state().edit(id, RAFT, { text: "Lash the beams", attachments: [sail] });
    state().beginSend({ requestId: "req-1", draftId: id, sessionId: RAFT, text: "Lash the beams", attachments: [sail], message: message("Lash the beams") }, "Lash the beams");
    state().edit(id, RAFT, { text: "with Calypso's rope" });
    state().refused("req-1");
    expect(state().drafts[id]).toMatchObject({ text: "Lash the beams\nwith Calypso's rope", attachments: [sail] });
  });

  test("an unconfirmed send waits for the reader; Edit puts it back, Send again re-keys it", () => {
    const { state, revoked } = store();
    const id = state().idFor(RAFT);
    const sail = image("sail.png");
    state().edit(id, RAFT, { text: "Lash the beams", attachments: [sail] });
    state().beginSend({ requestId: "req-1", draftId: id, sessionId: RAFT, text: "Lash the beams", attachments: [sail], message: message("Lash the beams") }, "Lash the beams");
    expect(state().unconfirmed("disconnected")).toEqual(["req-1"]);
    expect(state().sends["req-1"]).toMatchObject({ state: "unconfirmed", reason: "disconnected" });
    // A second silence changes nothing: it is no longer pending.
    expect(state().unconfirmed("disconnected")).toEqual([]);
    const again = state().resend("req-1", "req-2");
    expect(again?.message.requestId).toBe("req-2");
    expect(state().sends["req-1"]).toBeUndefined();
    expect(state().sends["req-2"]?.state).toBe("pending");
    state().unconfirmed("uncorrelated");
    state().editSend("req-2");
    expect(state().sends["req-2"]).toBeUndefined();
    expect(state().drafts[id]).toMatchObject({ text: "Lash the beams", attachments: [sail] });
    // The image was a send's: never revoked under it.
    expect(revoked).toEqual([]);
  });
});

describe("the host's versions", () => {
  test("a clean draft takes a newer host version; a dirty one is in conflict and keeps its words", () => {
    const { state } = store();
    state().restore(hostDraft({ draftId: "d-1", sessionId: ITHACA, revision: 1, text: "Ask about the swineherd" }));
    expect(state().drafts["d-1"]).toMatchObject({ text: "Ask about the swineherd", sessionId: ITHACA });
    expect(draftSaveView(state().drafts["d-1"], { supported: true, limits: state().limits }, 0).state).toBe("saved");
    state().restore(hostDraft({ draftId: "d-1", sessionId: ITHACA, revision: 2, text: "Ask Eumaeus about the swineherd" }));
    expect(state().drafts["d-1"]?.text).toBe("Ask Eumaeus about the swineherd");
    state().edit("d-1", ITHACA, { text: "Ask Eumaeus, and the dog" });
    state().restore(hostDraft({ draftId: "d-1", sessionId: ITHACA, revision: 3, text: "Ask Eumaeus at dawn" }));
    expect(state().drafts["d-1"]?.text).toBe("Ask Eumaeus, and the dog");
    expect(state().drafts["d-1"]?.conflict?.other.text).toBe("Ask Eumaeus at dawn");
    expect(draftSaveView(state().drafts["d-1"], { supported: true, limits: state().limits }, 0)).toMatchObject({ state: "conflict", copy: "draft changed on another device" });
  });

  test("a conflict is shown over an emptied composer", () => {
    const { state } = store();
    state().restore(hostDraft({ draftId: "d-1", sessionId: ITHACA, revision: 1, text: "Ask about the swineherd" }));
    state().edit("d-1", ITHACA, { text: "" });
    state().conflictWith("d-1", hostDraft({ draftId: "d-1", sessionId: ITHACA, revision: 2, text: "Theirs" }), true);
    expect(draftSaveView(state().drafts["d-1"], { supported: true, limits: state().limits }, 0).state).toBe("conflict");
  });

  test("Keep both turns the other version into an unbound Draft entry", () => {
    const { state } = store();
    state().restore(hostDraft({ draftId: "d-1", sessionId: ITHACA, revision: 1, text: "Ask about the swineherd" }));
    state().edit("d-1", ITHACA, { text: "Mine" });
    state().restore(hostDraft({ draftId: "d-1", sessionId: ITHACA, revision: 2, text: "Theirs" }));
    state().resolve("d-1", "both");
    expect(state().drafts["d-1"]).toMatchObject({ text: "Mine", conflict: null });
    // Writing over the host's revision 2, on purpose, on the next save.
    expect(state().drafts["d-1"]?.host?.revision).toBe(2);
    expect(unboundDrafts(state().drafts).map((d) => d.text)).toEqual(["Theirs"]);
  });

  test("a second draft for a session is a conflict, never a switch under the reader", () => {
    const { state } = store();
    const mine = state().idFor(ITHACA);
    state().edit(mine, ITHACA, { text: "Typed here" });
    state().restore(hostDraft({ draftId: "elsewhere", sessionId: ITHACA, text: "Typed on the phone" }));
    expect(state().idFor(ITHACA)).toBe(mine);
    expect(state().drafts[mine]?.conflict).toMatchObject({ sameId: false });
    expect(state().drafts.elsewhere).toBeUndefined();
  });

  test("gone from the host: a clean draft goes, a dirty one becomes a new unbound draft", () => {
    const { state } = store();
    state().restore(hostDraft({ draftId: "d-1", sessionId: ITHACA, text: "Sent on the phone" }));
    state().hostGone("d-1");
    expect(state().drafts["d-1"]).toBeUndefined();
    state().restore(hostDraft({ draftId: "d-2", sessionId: RAFT, text: "Raft" }));
    state().edit("d-2", RAFT, { text: "Raft, and more" });
    state().hostGone("d-2");
    expect(state().drafts["d-2"]).toBeUndefined();
    expect(unboundDrafts(state().drafts).map((d) => d.text)).toEqual(["Raft, and more"]);
  });

  test("a session whose draft was deleted elsewhere is never handed the tombstoned id again", () => {
    const { state } = store();
    const id = state().idFor(RAFT);
    state().edit(id, RAFT, { text: "Raft" });
    state().saved(id, { revision: 1, edit: state().drafts[id]!.edit, sessionId: RAFT, attachmentIds: [], updatedAt: 1 }, new Map());
    state().edit(id, RAFT, { text: "Raft, and more" });
    state().hostGone(id);
    expect(state().idFor(RAFT)).not.toBe(id);
  });

  test("an image given back by a failed send is the draft's again, so removing it releases it", () => {
    const { state, revoked } = store();
    const id = state().idFor(RAFT);
    const sail = image("sail.png");
    state().edit(id, RAFT, { text: "Lash", attachments: [sail] });
    state().beginSend({ requestId: "req-1", draftId: id, sessionId: RAFT, text: "Lash", attachments: [sail], message: message("Lash") }, "Lash");
    state().sendFailed("req-1");
    state().edit(id, RAFT, { attachments: [] });
    expect(revoked).toEqual([sail.previewUrl]);
  });

  test("words typed while the session draft's delete was out stay that session's, under a new id", () => {
    const { state } = store();
    const id = state().idFor(RAFT);
    state().edit(id, RAFT, { text: "Raft" });
    state().saved(id, { revision: 1, edit: state().drafts[id]!.edit, sessionId: RAFT, attachmentIds: [], updatedAt: 1 }, new Map());
    state().edit(id, RAFT, { text: "" });
    state().edit(id, RAFT, { text: "Twenty trees" });
    state().removed(id);
    const now = state().drafts[state().idFor(RAFT)]!;
    expect(now).toMatchObject({ text: "Twenty trees", sessionId: RAFT, host: null });
    expect(now.draftId).not.toBe(id);
  });

  test("saved is printed only for the acknowledged edit", () => {
    const { state } = store();
    const id = state().idFor(ITHACA);
    state().setSupport(true);
    state().edit(id, ITHACA, { text: "Plug" });
    const view = () => draftSaveView(state().drafts[id], state(), Date.now()) as { state: string; copy?: string };
    expect(view().state).toBe("none");
    const edit = state().drafts[id]!.edit;
    state().saved(id, { revision: 1, edit, sessionId: ITHACA, attachmentIds: [], updatedAt: 1 }, new Map());
    expect(view()).toMatchObject({ state: "saved", copy: "draft · saved" });
    state().edit(id, ITHACA, { text: "Plug the" });
    expect(view().state).not.toBe("saved");
    state().saveFailed(id, { kind: "too_large", limit: 8_388_608, bound: "draft" });
    expect(view().copy).toBe("draft · too large to save (8 MB max) · kept on this device");
    state().saveFailed(id, { kind: "full", limit: 100, bound: "drafts" });
    expect(view().copy).toBe("draft · 100 drafts saved · delete one to save this");
    state().setSupport(false);
    expect(view().copy).toBe("draft · this host doesn't keep drafts · kept on this device");
  });
});
