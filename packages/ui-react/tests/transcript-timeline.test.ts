import { test, expect } from "bun:test";
import { createBrainUiRoot } from "../src/root.js";
import { createTranscriptTimeline, transcriptMessage, transcriptTimelineFor } from "../src/lib/transcript-timeline.js";

test("arrival runs preserve streamed text across tasks, adoption, replay and selection without clock pairing", () => {
  const root = createBrainUiRoot({ storage: null });
  const chat = root.stores.chat;
  const voice = root.connection.conversation.state;
  const timeline = createTranscriptTimeline(chat, voice);
  const rows = () => timeline.state.getState().entries;
  const text = () => rows().map(e => e.kind === "speech" ? e.output.generated : transcriptMessage(e).content).filter(Boolean);
  const speech = (generated: string) => voice.setState({ outputs: [{ conversationId: "ithaca", epoch: 1, outputId: "epoch-output", sessionId: null, generated, playback: "unknown" }] });
  try {
    speech("Voyage A.");
    chat.getState().addUserMessage(null, "Find the departure note.", "voice-context");
    chat.getState().startAssistantMessage(null, "turn-one");
    speech("Voyage A.Voyage B.Voyage C.");
    chat.getState().appendText(null, "The bronze");
    const keys = rows().map(e => e.key);
    speech("Voyage A.Voyage B.Voyage C.While we wait.");
    chat.getState().appendText(null, " owl.");
    expect(text()).toEqual(["Voyage A.", "Find the departure note.", "Voyage B.Voyage C.", "The bronze", "While we wait.", " owl."]);
    expect(rows().filter(e => keys.includes(e.key)).map(e => e.key)).toEqual(keys);
    const before = rows().map(e => e.key);
    chat.getState().bindDraftSession("ithaca");
    voice.setState(s => ({ outputs: s.outputs.map(o => ({ ...o, sessionId: "ithaca" })) }));
    expect(rows().map(e => e.key)).toEqual(before);
    const messages = chat.getState().buffers.ithaca!.messages;
    chat.getState().setMessages("ithaca", messages.map(m => ({ ...m, id: `replay-${m.id}` })));
    expect(rows().map(e => e.key)).toEqual(before);
    chat.getState().setActiveSession("pylos");
    chat.getState().addUserMessage("pylos", "A separate harbour.");
    expect(rows().filter(e => e.sessionId === "pylos")).toHaveLength(1);
    chat.getState().setActiveSession("ithaca");
    expect(rows().filter(e => e.sessionId === "ithaca").map(e => e.key)).toEqual(before);
    voice.setState(s => ({ outputs: s.outputs.map(o => ({ ...o, generated: o.generated + "A quiet sea." })) }));
    const speechCount = rows().filter(e => e.kind === "speech").length;
    chat.getState().addUserMessage("pylos", "A separate watch.");
    voice.setState(s => ({ outputs: s.outputs.map(o => ({ ...o, generated: o.generated + "A steady wind." })) }));
    expect(rows().filter(e => e.kind === "speech")).toHaveLength(speechCount);
    chat.getState().finishAssistantMessage("ithaca");
    chat.getState().addUserMessage("ithaca", "Find the watch note.", "voice-context");
    chat.getState().startAssistantMessage("ithaca", "turn-two");
    chat.getState().appendText("ithaca", "The watch is ready.");
    expect(text().filter(t => t === "The watch is ready.")).toHaveLength(1);
  } finally { timeline.dispose(); root.dispose(); }
});


test("promoted links rebase display ranges without adding words or moving entries", () => {
  const root = createBrainUiRoot({ storage: null });
  const chat = root.stores.chat;
  const voice = root.connection.conversation.state;
  try {
    chat.getState().addUserMessage(null, "Find the raft note.", "voice-context");
    chat.getState().startAssistantMessage(null, "raft-turn");
    chat.getState().appendText(null, "See [raft](notes/raft.md)");
    voice.setState({ outputs: [{ conversationId: "ithaca", epoch: 1, outputId: "sea", sessionId: null, generated: "The sea is quiet.", playback: "unknown" }] });
    chat.getState().appendText(null, " before sailing.");
    const timeline = transcriptTimelineFor(root.stores.chat).state;
    const keys = timeline.getState().entries.map(e => e.key);
    chat.getState().rewriteMessageLinks(null, [{ from: "notes/raft.md", to: "notes/odysseus-raft.md" }], "raft-turn");
    const answers = timeline.getState().entries.filter(e => e.kind === "message" && e.section === "answer");
    expect(answers.map(e => e.kind === "message" ? transcriptMessage(e).content : "").join("")).toBe("See [raft](notes/odysseus-raft.md) before sailing.");
    expect(answers.map(e => e.kind === "message" ? transcriptMessage(e).content : "")).toEqual(["See [raft](notes/odysseus-raft.md)", " before sailing."]);
    expect(timeline.getState().entries.map(e => e.key)).toEqual(keys);
  } finally { root.dispose(); }
});
