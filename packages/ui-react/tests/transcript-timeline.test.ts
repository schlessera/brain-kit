import { test, expect } from "bun:test";
import { createBrainUiRoot } from "../src/root.js";
import { createTranscriptTimeline, transcriptMessage } from "../src/lib/transcript-timeline.js";

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
    chat.getState().finishAssistantMessage("ithaca");
    chat.getState().addUserMessage("ithaca", "Find the watch note.", "voice-context");
    chat.getState().startAssistantMessage("ithaca", "turn-two");
    chat.getState().appendText("ithaca", "The watch is ready.");
    expect(text().filter(t => t === "The watch is ready.")).toHaveLength(1);
  } finally { timeline.dispose(); root.dispose(); }
});
