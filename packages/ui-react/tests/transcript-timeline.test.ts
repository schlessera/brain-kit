import { test, expect } from "bun:test";
import { createBrainUiRoot } from "../src/root.js";
import { createTranscriptTimeline, transcriptMessage, transcriptTimelineFor, type TranscriptEntry } from "../src/lib/transcript-timeline.js";

function entryText(e: TranscriptEntry) {
  if (e.kind === "speech") return e.output.generated;
  const message = transcriptMessage(e);
  return e.section === "answer" ? message.content.slice(e.start, e.end) : message.content;
}

test("arrival runs preserve streamed text across tasks, adoption, replay and selection without clock pairing", () => {
  const root = createBrainUiRoot({ storage: null });
  const chat = root.stores.chat;
  const voice = root.connection.conversation.state;
  const timeline = createTranscriptTimeline(chat, voice);
  const rows = () => timeline.state.getState().entries;
  const text = () => rows().map(e => entryText(e)).filter(Boolean);
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
    expect(answers.map(e => entryText(e)).join("")).toBe("See [raft](notes/odysseus-raft.md) before sailing.");
    expect(answers.map(e => entryText(e))).toEqual(["See [raft](notes/odysseus-raft.md)", " before sailing."]);
    expect(timeline.getState().entries.map(e => e.key)).toEqual(keys);
  } finally { root.dispose(); }
});


for (const replacement of ["The bronze owl", "The bronze owl at dawn", "A silver olive branch"]) test(`production replay retains all recovered range content: ${replacement}`, () => {
  const root = createBrainUiRoot({ storage: null });
  try {
    const chat = root.stores.chat.getState();
    chat.addUserMessage("ithaca", "Find the departure signal.", "voice-context");
    chat.startAssistantMessage("ithaca", "signal-turn");
    chat.appendText("ithaca", "bronze");
    root.connection.conversation.state.setState({ outputs: [{ conversationId: "ithaca", epoch: 1, outputId: "signal", sessionId: "ithaca", generated: "A calm sea.", playback: "unknown" }] });
    chat.appendText("ithaca", " owl");
    if (replacement.startsWith("A silver")) chat.finishAssistantMessage("ithaca");
    const before = root.stores.chat.getState().buffers.ithaca!.messages;
    const id = before.at(-1)!.id;
    chat.setMessages("ithaca", before.map((m, i) => i === before.length - 1 ? { ...m, id: "restored-signal", content: replacement, parts: [{ kind: "text", text: replacement }] } : m));
    expect(root.stores.chat.getState().buffers.ithaca!.messages.at(-1)!.id).toBe(id);
    const answers = transcriptTimelineFor(root.stores.chat).state.getState().entries.filter(e => e.kind === "message" && e.section === "answer");
    expect(answers.map(entryText).join("")).toBe(replacement);
    expect(answers[0]!.kind === "message" && answers[0]!.start).toBe(0);
  } finally { root.dispose(); }
});

test("classified source spans retain original text ordinals and tool bindings in exactly one projection", () => {
  const root = createBrainUiRoot({ storage: null });
  try {
    const chat = root.stores.chat.getState();
    chat.addUserMessage(null, "Find the departure watch.", "voice-context");
    chat.startAssistantMessage(null, "watch-turn");
    chat.appendText(null, "The watch note follows.");
    chat.startToolCall(null, "watch-read", "Read");
    chat.appendText(null, "| Island | Watch |\n");
    root.connection.conversation.state.setState({ outputs: [{ conversationId: "ithaca", epoch: 1, outputId: "watch", sessionId: null, generated: "The voyage continues.", playback: "unknown" }] });
    chat.appendText(null, "| --- | --- |\n| Ithaca | Dawn |");
    const original = root.stores.chat.getState().draft!.messages.at(-1)!;
    const table = original.parts.filter(p => p.kind === "text")[1]!.text;
    const block = { partIndex: 1, start: 0, end: table.length, confidence: 1, block: { kind: "table" as const, columns: [{label:"Island"}], rows:[{cells:[{v:"Ithaca"}]}] } };
    chat.setMessageBlocks(null, [block], "watch-turn");
    const entries = transcriptTimelineFor(root.stores.chat).state.getState().entries.filter(e => e.kind === "message");
    const answers = entries.filter(e => e.section === "answer").map(e => transcriptMessage(e));
    expect(answers.flatMap(m => m.blocks ?? [])).toEqual([block]);
    expect(answers.flatMap(m => m.blocks ?? [])[0]).toBe(block);
    expect(answers.every(m => m.parts.filter(p => p.kind === "text")[1]!.text === table)).toBe(true);
    expect(answers.every(m => m.toolCalls.some(t => t.id === "watch-read"))).toBe(true);
    expect(answers.flatMap(m => m.parts).some(p => p.kind === "tool")).toBe(false);
    expect(entries.filter(e => e.section === "progress").flatMap(e => transcriptMessage(e).parts).filter(p => p.kind === "tool")).toHaveLength(1);
  } finally { root.dispose(); }
});
