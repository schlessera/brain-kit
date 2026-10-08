import { describe, expect, test } from "bun:test";
import type { Draft } from "@schlessera/brain-ui-sdk/protocol";
import { createDraftStore, holdsUnsaved, type DraftSend, type LocalDraft } from "../src/stores/draft-state.ts";
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
    expect(state().drafts[id]).toMatchObject({ text: "Lash the beams\nwith Calypso's rope" });
    expect(state().drafts[id]!.attachments.map((a) => a.attachment)).toEqual([sail.attachment]);
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
    state().restore(hostDraft({ draftId: "d-1", sessionId: ITHACA, revision: 2, text: "Ask Eumaeus about the swineherd", attachments: [{ attachmentId: "att-chart", mime: "image/png", bytes: "iVBORw0KGgo=", name: "chart.png" }] }));
    expect(state().drafts["d-1"]?.text).toBe("Ask Eumaeus about the swineherd");
    expect(state().drafts["d-1"]?.attachments).toEqual([{
      attachment: { data: "iVBORw0KGgo=", mediaType: "image/png" },
      previewUrl: "data:image/png;base64,iVBORw0KGgo=", bytes: 8, name: "chart.png",
    }]);
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

  test("accepted while a newer save is out: the host's answer to that save decides consumption", () => {
    const { state } = store();
    state().setSupport(true);
    const first = state().fresh;
    state().edit(first, null, { text: "Which harbour?" });
    state().saved(first, { revision: 1, edit: state().drafts[first]!.edit, sessionId: null, attachmentIds: [], updatedAt: 1 }, new Map());
    state().beginSend({ requestId: "req-1", draftId: first, sessionId: null, text: "Which harbour?", attachments: [], message: message("Which harbour?") }, "Which harbour?");
    state().edit(first, null, { text: "And the fees" });
    state().saving(first, 5);
    state().accepted("req-1", ITHACA);
    // Still the same id: the save that is out may have been kept.
    expect(state().drafts[first]).toMatchObject({ sessionId: ITHACA, bind: { sessionId: ITHACA, requestId: "req-1" } });
    // It was: revision 2 lives on the host, unbound until the bind.
    state().saved(first, { revision: 2, edit: state().drafts[first]!.edit, sessionId: null, attachmentIds: [], updatedAt: 2 }, new Map());
    expect(state().drafts[first]).toMatchObject({ text: "And the fees", sessionId: ITHACA, host: { revision: 2 } });
    expect(state().orphans).toEqual([]);
  });

  test("work started on a draft before it rotated lands on its successor", () => {
    const { state } = store();
    state().setSupport(true);
    const id = state().idFor(ITHACA);
    state().edit(id, ITHACA, { text: "Plug" });
    state().saved(id, { revision: 1, edit: state().drafts[id]!.edit, sessionId: ITHACA, attachmentIds: [], updatedAt: 1 }, new Map());
    state().beginSend({ requestId: "req-1", draftId: id, sessionId: ITHACA, text: "Plug", attachments: [], message: message("Plug") }, "Plug");
    state().edit(id, ITHACA, { text: "And bind me" });
    state().accepted("req-1", ITHACA);
    // An image decoded meanwhile, written to the id the composer captured.
    state().edit(id, ITHACA, { attachments: [image("mast.png")] });
    const drafts = Object.values(state().drafts).filter((d) => d.sessionId === ITHACA);
    expect(drafts, "one draft for the session").toHaveLength(1);
    expect(drafts[0]).toMatchObject({ text: "And bind me" });
    expect(drafts[0]!.attachments).toHaveLength(1);
  });

  test("a send names a revision of its own draft only: a successor at the same number is not consumed", () => {
    const { state } = store();
    state().setSupport(true);
    const id = state().idFor(RAFT);
    state().edit(id, RAFT, { text: "Lash" });
    state().saved(id, { revision: 1, edit: state().drafts[id]!.edit, sessionId: RAFT, attachmentIds: [], updatedAt: 1 }, new Map());
    state().beginSend({ requestId: "req-1", draftId: id, sessionId: RAFT, text: "Lash", attachments: [], message: message("Lash") }, "Lash");
    state().unconfirmed("disconnected");
    state().edit(id, RAFT, { text: "Newer" });
    state().hostGone(id);
    const next = state().idFor(RAFT) === id ? undefined : Object.values(state().drafts).find((d) => d.text === "Newer")!;
    expect(next).toBeDefined();
    state().saved(next!.draftId, { revision: 1, edit: next!.edit, sessionId: next!.sessionId, attachmentIds: [], updatedAt: 2 }, new Map());
    state().accepted("req-1", RAFT);
    expect(state().drafts[next!.draftId], "the successor survives").toMatchObject({ text: "Newer" });
  });

  test("the same words bound on another device make the draft that session's here", () => {
    const { state } = store();
    const first = state().fresh;
    state().edit(first, null, { text: "Letter to Penelope" });
    state().restore(hostDraft({ draftId: first, sessionId: ITHACA, revision: 2, text: "Letter to Penelope" }));
    expect(state().drafts[first]).toMatchObject({ sessionId: ITHACA, host: { revision: 2 } });
    expect(unboundDrafts(state().drafts)).toHaveLength(0);
  });

  test("disposing the root releases previews only a draft or a held send owns", () => {
    const { state, revoked } = store();
    const id = state().idFor(ITHACA);
    const kept = image("kept.png");
    const sent = image("sent.png");
    state().edit(id, ITHACA, { text: "x", attachments: [kept, sent] });
    state().beginSend({ requestId: "req-1", draftId: id, sessionId: ITHACA, text: "x", attachments: [sent], message: message("x") }, "x");
    state().accepted("req-1", ITHACA);
    state().release();
    expect(revoked).toEqual([kept.previewUrl]);
  });

  test("images a refused message gives back get previews of their own", () => {
    const { state } = store();
    const id = state().idFor(RAFT);
    const sail = image("sail.png");
    state().edit(id, RAFT, { text: "Lash", attachments: [sail] });
    state().beginSend({ requestId: "req-1", draftId: id, sessionId: RAFT, text: "Lash", attachments: [sail], message: message("Lash") }, "Lash");
    state().refused("req-1");
    const back = state().drafts[id]!.attachments[0]!;
    expect(back.previewUrl, "not the transcript's URL").not.toBe(sail.previewUrl);
    expect(back.previewUrl.startsWith("data:image/png;base64,")).toBe(true);
    expect(back.attachment).toEqual(sail.attachment);
  });

  test("an image decoded after a new chat's first message was accepted lands in that session's draft", () => {
    const { state } = store();
    const first = state().fresh;
    state().edit(first, null, { text: "Which harbour?" });
    state().beginSend({ requestId: "req-1", draftId: first, sessionId: null, text: "Which harbour?", attachments: [], message: message("Which harbour?") }, "Which harbour?");
    state().accepted("req-1", ITHACA);
    expect(state().drafts[first]).toBeUndefined();
    // The composer captured the new chat's id and owner before decoding.
    state().edit(first, null, { attachments: [image("chart.png")] });
    expect(unboundDrafts(state().drafts), "no stray unbound draft").toHaveLength(0);
    expect(state().drafts[state().idFor(ITHACA)]?.attachments).toHaveLength(1);
  });

  test("disposing the root releases a held send's previews", () => {
    const { state, revoked } = store();
    const id = state().idFor(ITHACA);
    const map = image("map.png");
    state().edit(id, ITHACA, { text: "x", attachments: [map] });
    state().beginSend({ requestId: "req-1", draftId: id, sessionId: ITHACA, text: "x", attachments: [map], message: message("x") }, "x");
    state().unconfirmed("disconnected");
    state().release();
    expect(revoked).toEqual([map.previewUrl]);
  });

  test("a forgotten new-chat draft's id reads and writes as its session's draft", () => {
    const { state } = store();
    const first = state().fresh;
    state().edit(first, null, { text: "Which harbour?" });
    state().beginSend({ requestId: "req-1", draftId: first, sessionId: null, text: "Which harbour?", attachments: [], message: message("Which harbour?") }, "Which harbour?");
    state().accepted("req-1", ITHACA);
    const chart = image("chart.png");
    state().edit(state().idFor(ITHACA), ITHACA, { attachments: [chart] });
    // What the composer reads for its captured id is what it would write to.
    expect(state().resolveId(first)).toBe(state().idFor(ITHACA));
    expect(state().drafts[state().resolveId(first)]?.attachments).toEqual([chart]);
  });

  test("a rotated new-chat draft keeps its first id as its tracks' owner", () => {
    const { state } = store();
    const first = state().fresh;
    state().edit(first, null, { text: "Letter" });
    state().saved(first, { revision: 1, edit: state().drafts[first]!.edit, sessionId: null, attachmentIds: [], updatedAt: 1 }, new Map());
    state().edit(first, null, { text: "Letter, longer" });
    state().hostGone(first);
    expect(state().fresh).not.toBe(first);
    expect(state().originOf(state().fresh)).toBe(first);
  });

  test("an emptied draft still on the host, or one with a save out, is unsaved work", () => {
    const { state } = store();
    const id = state().idFor(ITHACA);
    state().edit(id, ITHACA, { text: "Plug" });
    state().saved(id, { revision: 1, edit: state().drafts[id]!.edit, sessionId: ITHACA, attachmentIds: [], updatedAt: 1 }, new Map());
    expect(holdsUnsaved(state())).toBe(false);
    state().edit(id, ITHACA, { text: "" });
    expect(holdsUnsaved(state()), "the delete has not landed").toBe(true);
    state().removed(id);
    expect(holdsUnsaved(state())).toBe(false);
    const pending = state().idFor(RAFT);
    state().edit(pending, RAFT, { text: "Lash" });
    state().saving(pending, 1);
    state().edit(pending, RAFT, { text: "" });
    expect(state().drafts[pending]).toMatchObject({ text: "", attachments: [], host: null, savingSince: 1 });
    expect(holdsUnsaved(state()), "the first save's answer is still owed").toBe(true);
  });

  test("Edit, refusal and a failed send never pass through a state with nothing held", () => {
    for (const settle of ["edit", "refused", "failed"] as const) {
      const { s, state } = store();
      const id = state().idFor(RAFT);
      state().edit(id, RAFT, { text: "Lash" });
      state().beginSend({ requestId: "req-1", draftId: id, sessionId: RAFT, text: "Lash", attachments: [], message: message("Lash") }, "Lash");
      if (settle === "edit") state().unconfirmed("disconnected");
      const seen: boolean[] = [];
      const off = s.subscribe((now) => seen.push(holdsUnsaved(now)));
      if (settle === "edit") state().editSend("req-1");
      else if (settle === "refused") state().refused("req-1");
      else state().sendFailed("req-1");
      off();
      expect(seen.length, settle).toBeGreaterThan(0);
      expect(seen.every(Boolean), `${settle}: the words are held at every step`).toBe(true);
    }
  });

  test("an image begun in an empty session composer lands in the draft restored for it meanwhile", () => {
    const { state } = store();
    const handed = state().idFor(ITHACA);
    state().restore(hostDraft({ draftId: "d-phone", sessionId: ITHACA, text: "From the phone" }));
    state().edit(handed, ITHACA, { attachments: [image("late.png")] });
    const all = Object.values(state().drafts).filter((d) => d.sessionId === ITHACA);
    expect(all, "one draft for the session").toHaveLength(1);
    expect(all[0]).toMatchObject({ draftId: "d-phone", text: "From the phone" });
    expect(all[0]!.attachments).toHaveLength(1);
  });

  test("the open new chat's draft bound on another device leaves the new-chat view", () => {
    const { state } = store();
    const first = state().fresh;
    state().edit(first, null, { text: "Letter to Penelope" });
    state().restore(hostDraft({ draftId: first, sessionId: ITHACA, revision: 2, text: "Letter to Penelope" }));
    expect(state().fresh, "a fresh new chat").not.toBe(first);
    expect(state().idFor(null)).not.toBe(state().idFor(ITHACA));
  });

  test("an emptied unbound draft with another device's version waiting stays a Draft entry, named by that version", () => {
    const { state } = store();
    state().restore(hostDraft({ draftId: "d-letter", sessionId: null, revision: 1, text: "Letter to Penelope" }));
    state().edit("d-letter", null, { text: "" });
    state().conflictWith("d-letter", hostDraft({ draftId: "d-letter", sessionId: null, revision: 2, text: "Letter to Telemachus" }), true);
    const entries = unboundDrafts(state().drafts);
    expect(entries.map((d) => d.draftId)).toEqual(["d-letter"]);
    expect(draftTitle(entries[0]!)).toBe("Letter to Telemachus");
  });

  test("a read that confirms a save whose answer was lost settles the doubt", () => {
    const { state } = store();
    const id = state().idFor(ITHACA);
    state().edit(id, ITHACA, { text: "Ask Aeolus" });
    state().saveFailed(id, { kind: "unsaved" }, true);
    expect(holdsUnsaved(state())).toBe(true);
    state().restore(hostDraft({ draftId: id, sessionId: ITHACA, revision: 1, text: "Ask Aeolus" }));
    expect(state().drafts[id]?.uncertain).toBe(false);
    expect(holdsUnsaved(state())).toBe(false);
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

describe("drafts kept on this device (#1014)", () => {
  const kept = (over: Partial<LocalDraft> & Pick<LocalDraft, "draftId">): LocalDraft =>
    ({ sessionId: null, text: "", attachments: [], editedAt: 900, host: null, ...over });

  test("a kept draft fills a gap; whatever this page holds already stays", () => {
    const { state } = store();
    const live = state().idFor(ITHACA);
    state().edit(live, ITHACA, { text: "Typed on this page" });
    state().restoreLocal([
      kept({ draftId: "kept-ithaca", sessionId: ITHACA, text: "Kept for Ithaca" }),
      kept({ draftId: "kept-raft", sessionId: RAFT, text: "Kept for the raft", attachments: [image("sail.png")] }),
      kept({ draftId: "kept-empty", text: "" }),
    ]);
    expect(state().drafts[state().idFor(ITHACA)]!.text).toBe("Typed on this page");
    expect(state().drafts["kept-ithaca"]).toBeUndefined();
    const raft = state().drafts[state().idFor(RAFT)]!;
    expect(raft.draftId).toBe("kept-raft");
    expect(raft.text).toBe("Kept for the raft");
    expect(raft.attachments.map((a) => a.name)).toEqual(["sail.png"]);
    expect(state().drafts["kept-empty"]).toBeUndefined();
  });

  test("a kept draft keeps the host revision it knew: clean stays clean, dirty is owed a save", () => {
    const { state } = store();
    state().setSupport(true);
    state().restoreLocal([
      kept({ draftId: "clean", sessionId: ITHACA, text: "Saved words", host: { revision: 3, sessionId: ITHACA, updatedAt: 1, clean: true } }),
      kept({ draftId: "dirty", sessionId: RAFT, text: "Newer words", host: { revision: 2, sessionId: RAFT, updatedAt: 1, clean: false } }),
    ]);
    const view = (id: string) => draftSaveView(state().drafts[id], state(), Date.now());
    expect(view("clean").state).toBe("saved");
    expect(view("dirty").state).not.toBe("saved");
    expect(state().drafts.dirty!.host!.revision).toBe(2);
    // The host's newer revision replaces the clean one, and meets the dirty one as a conflict.
    state().restore(hostDraft({ draftId: "clean", sessionId: ITHACA, revision: 4, text: "From the other device" }));
    expect(state().drafts.clean!.text).toBe("From the other device");
    state().restore(hostDraft({ draftId: "dirty", sessionId: RAFT, revision: 3, text: "Also elsewhere" }));
    expect(state().drafts.dirty!.text).toBe("Newer words");
    expect(state().drafts.dirty!.conflict?.other.text).toBe("Also elsewhere");
  });

  test("an id handed to a session before its kept draft arrived goes to that draft", () => {
    const { state } = store();
    // The composer asked first, and an image began decoding under that id.
    const handed = state().idFor(ITHACA);
    state().restoreLocal([kept({ draftId: "kept-ithaca", sessionId: ITHACA, text: "Kept for Ithaca" })]);
    state().edit(handed, ITHACA, { attachments: [image("harbour.png")] });
    expect(state().idFor(ITHACA)).toBe("kept-ithaca");
    expect(Object.values(state().drafts).filter((d) => d.sessionId === ITHACA)).toHaveLength(1);
    expect(state().drafts["kept-ithaca"]!.attachments.map((a) => a.name)).toEqual(["harbour.png"]);
  });

  test("an emptied draft comes back only while the host still holds it", () => {
    const { state } = store();
    state().setSupport(true);
    state().restoreLocal([
      kept({ draftId: "owed", sessionId: ITHACA, host: { revision: 2, sessionId: ITHACA, updatedAt: 1, clean: false } }),
      kept({ draftId: "gone", sessionId: RAFT }),
    ]);
    expect(state().drafts.owed).toMatchObject({ text: "", host: { revision: 2 } });
    // Its deletion is owed: it is not clean.
    expect(state().drafts.owed!.host!.edit).not.toBe(state().drafts.owed!.edit);
    expect(state().drafts.gone).toBeUndefined();
  });

  test("a failed device write takes `kept on this device` off the line", () => {
    const { state } = store();
    const id = state().idFor(ITHACA);
    state().edit(id, ITHACA, { text: "Plug the ears with wax" });
    state().setSupport(false);
    expect(draftSaveView(state().drafts[id], { ...state(), localFailed: true }, Date.now()))
      .toMatchObject({ state: "unavailable", copy: "draft · this host doesn't keep drafts", word: "not saved yet" });
    state().setSupport(true);
    state().saveFailed(id, { kind: "too_large", limit: 65_536, bound: "text" });
    expect(draftSaveView(state().drafts[id], { ...state(), localFailed: true }, Date.now()))
      .toMatchObject({ state: "too_large", copy: "draft · too large to save (64 KB max)" });
  });
});


test("a pending new-chat send accepts onto its retained branch, leaving the newer original unbound", () => {
  const {state} = store();
  const id = state().idFor(null);
  state().edit(id,null,{text:"Telemachus leaves the harbour"});
  state().beginSend({requestId:"voyage",draftId:id,sessionId:null,text:"Telemachus leaves the harbour",attachments:[],message:message("Telemachus leaves the harbour")},"Telemachus leaves the harbour");
  state().keepDeviceBranch(id,"voyage-branch",{draftId:id,sessionId:null,text:"Penelope keeps the loom",attachments:[],editedAt:1,host:null},null);
  state().accepted("voyage",ITHACA);
  expect(state().drafts[id]!.sessionId, "acceptance must not bind the newer original").toBeNull();
  expect(state().sends.voyage!.draftId, "the send snapshot keeps its original identity").toBe(id);
});
