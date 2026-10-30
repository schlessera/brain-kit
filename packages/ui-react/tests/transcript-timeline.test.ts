import { test, expect } from "bun:test";
import { createBrainUiRoot } from "../src/root.js";
import { createTranscriptTimeline, transcriptMessage, transcriptRange, transcriptTimelineFor, type TranscriptEntry } from "../src/lib/transcript-timeline.js";

function entryText(e: TranscriptEntry) {
  if (e.kind === "history-notice") return e.label;
  if (e.kind === "voice-boundary") return "";
  if (e.kind === "recognition") return e.fragments.map(f => f.text).join("");
  if (e.kind === "speech") return e.output.generated;
  const message = transcriptMessage(e);
  return e.section === "answer" ? message.content.slice(e.start, e.end) : message.content;
}

for (const source of [undefined, "voice-context"] as const) for (const chunked of [false, true]) test(`recovered peer user precedes its retained ${source ?? "ordinary"} answer (${chunked ? "chunked" : "whole"} history)`, () => {
  const root = createBrainUiRoot({ storage: null });
  try {
    const chat = root.stores.chat.getState();
    const timeline = transcriptTimelineFor(root.stores.chat).state;
    const rows = () => timeline.getState().entries.filter(e => e.sessionId === "ithaca");
    chat.addUserMessage("ithaca", "Sail past the Sirens.");
    chat.startAssistantMessage("ithaca", "old-turn");
    chat.appendText("ithaca", "The wax held.");
    chat.finishAssistantMessage("ithaca");
    const prefix = root.stores.chat.getState().buffers.ithaca!.messages;
    if (source) root.connection.conversation.state.setState({ active: true, sessionId: "ithaca" });
    // A peer's live frames precede the history that proves its user message.
    chat.startAssistantMessage("ithaca", "peer-turn");
    chat.appendText("ithaca", "The crew rowed.");
    const answer = root.stores.chat.getState().buffers.ithaca!.messages.at(-1)!;
    const answerKey = rows().at(-1)!.key;
    root.connection.conversation.state.setState({ outputs: [{ conversationId: "ithaca", epoch: 1, outputId: "sea", sessionId: "ithaca", generated: "A steady wind.", playback: "unknown" }] });
    const speechKey = rows().at(-1)!.key;
    const user = { ...prefix[0]!, id: "recovered-peer-user", content: "Bind me to the mast.", parts: [{ kind: "text" as const, text: "Bind me to the mast." }], source };
    const replay = [...prefix, user, { ...answer, id: "recovered-peer-answer", source }];
    chat.setMessages("ithaca", chunked ? replay.slice(0, -1) : replay);
    if (chunked) chat.appendMessages("ithaca", replay.slice(-1));
    chat.finishHistoryReplay("ithaca", true);
    expect(root.stores.chat.getState().buffers.ithaca!.messages.at(-1)!.id).toBe(answer.id);
    const primary = rows().filter(e => e.kind === "message").filter(e => e.section !== "answer");
    expect(primary.map(e => e.index)).toEqual([0, 1, 2, 3]);
    expect(rows().findIndex(e => e.key === answerKey)).toBeLessThan(rows().findIndex(e => e.key === speechKey));
    expect(rows().findIndex(e => e.kind === "message" && e.message.id === user.id)).toBeLessThan(rows().findIndex(e => e.key === answerKey));
    chat.appendText("ithaca", " Rowing again.");
    const retained = rows().find(e => e.key === answerKey);
    expect(retained?.kind === "message" && retained.message.id).toBe(answer.id);
    expect(rows().filter(e => e.kind === "message").filter(e => e.section !== "answer").map(e => e.index)).toEqual([0, 1, 2, 3]);
  } finally { root.dispose(); }
});

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


test("multiple promoted edits retain both original arrival ranges", () => {
  const root = createBrainUiRoot({ storage: null });
  try {
    const chat = root.stores.chat.getState();
    chat.addUserMessage(null, "Find the raft and watch notes.", "voice-context");
    chat.startAssistantMessage(null, "two-links");
    chat.appendText(null, "See [raft](notes/raft.md)");
    root.connection.conversation.state.setState({ outputs: [{ conversationId: "ithaca", epoch: 1, outputId: "two-links", sessionId: null, generated: "The watch continues.", playback: "unknown" }] });
    chat.appendText(null, " then [watch](notes/watch.md).");
    const timeline = transcriptTimelineFor(root.stores.chat).state;
    const keys = timeline.getState().entries.map(e => e.key);
    chat.rewriteMessageLinks(null, [{ from: "notes/raft.md", to: "notes/odysseus-raft.md" }, { from: "notes/watch.md", to: "notes/harbour-watch.md" }], "two-links");
    expect(timeline.getState().entries.filter(e => e.kind === "message" && e.section === "answer").map(entryText)).toEqual(["See [raft](notes/odysseus-raft.md)", " then [watch](notes/harbour-watch.md)."]);
    expect(timeline.getState().entries.map(e => e.key)).toEqual(keys);
  } finally { root.dispose(); }
});


test("each arrival keeps the complete current semantic source for actions, including replay", () => {
  const root = createBrainUiRoot({ storage: null });
  try {
    const chat = root.stores.chat.getState();
    chat.addUserMessage("ithaca", "Find the watch note.", "voice-context");
    chat.startAssistantMessage("ithaca", "watch-turn");
    chat.appendText("ithaca", "The bronze owl. ");
    root.connection.conversation.state.setState({ outputs: [{ conversationId: "ithaca", epoch: 1, outputId: "sea", sessionId: "ithaca", generated: "A quiet sea.", playback: "unknown" }] });
    chat.startToolCall("ithaca", "watch-read", "Read");
    chat.completeToolCall("ithaca", "watch-read", "Read", { path: "notes/watch.md" });
    chat.setToolResult("ithaca", "watch-read", "The watch note.", false);
    chat.appendText("ithaca", "The watch is ready.");
    for (const settled of [false, true]) {
      if (settled) chat.finishAssistantMessage("ithaca");
      const original = root.stores.chat.getState().buffers.ithaca!.messages.at(-1)!;
      const answers = transcriptTimelineFor(root.stores.chat).state.getState().entries.filter(e => e.kind === "message" && e.section === "answer");
      expect(answers).toHaveLength(2);
      for (const entry of answers) {
        expect(transcriptRange(entry)!.source).toBe(original);
        expect(transcriptRange(entry)!.source.parts.some(p => p.kind === "tool")).toBe(true);
        expect(transcriptRange(entry)!.source.toolCalls[0]!.output).toBe("The watch note.");
        expect(transcriptRange(entry)!.source.isStreaming).toBe(!settled);
      }
    }
    const before = root.stores.chat.getState().buffers.ithaca!.messages;
    chat.setMessages("ithaca", before.map((m, i) => i === before.length - 1 ? { ...m, content: "Recovered watch.", parts: [{ kind: "text", text: "Recovered watch." }] } : m));
    const original = root.stores.chat.getState().buffers.ithaca!.messages.at(-1)!;
    for (const entry of transcriptTimelineFor(root.stores.chat).state.getState().entries.filter(e => e.kind === "message" && e.section === "answer")) {
      expect(transcriptRange(entry)!.source).toBe(original);
      expect(transcriptRange(entry)!.source.content).toBe("Recovered watch.");
    }
  } finally { root.dispose(); }
});

test("recognition identity, exact deltas, late timing and finish-only evidence use the shared arrival timeline", () => {
  const root = createBrainUiRoot({ storage: null });
  const voice = root.connection.conversation.state;
  const rows = () => transcriptTimelineFor(root.stores.chat).state.getState().entries;
  const fragment = (sequence: number, text: string, extra = {}) => ({ kind: "unassigned_input_fragment" as const, sequence, text, conversationId: "ithaca", epoch: 1, sessionId: null, providerId: "gpt-live", activation: 1, contextual: true, ...extra });
  const first = fragment(0, "Which"), second = fragment(1, " note?");
  try {
    voice.setState({ recognition: [first, second] });
    expect(rows().map(entryText)).toEqual(["Which note?"]);
    const key = rows()[0]!.key;
    voice.setState({ outputs: [{ conversationId: "ithaca", epoch: 1, outputId: "wind", sessionId: null, generated: "The Sirens note.", playback: "unknown" }] });
    const late = fragment(2, "Which note?", { sessionInterval: { startMs: 0, endMs: 100 } });
    const captured = { ...fragment(0, "Same sequence."), kind: "input_fragment" as const, utteranceId: "captured", finalization: "unknown" as const, certainty: "unknown" as const, origin: "unknown" as const };
    voice.setState({ recognition: [first, second, late] });
    voice.setState(s => ({ recognition: [...s.recognition, captured] }));
    expect(rows().map(entryText)).toEqual(["Which note?", "The Sirens note.", "Which note?", "Same sequence."]);
    expect(rows()[0]!.key).toBe(key);
    voice.setState(s => ({ recognition: [...s.recognition, fragment(3, "", { finalization: "final" })] }));
    expect(rows().map(entryText)).toEqual(["Which note?", "The Sirens note.", "Which note?", "Same sequence."]);
    const continued = rows()[2]!;
    expect(continued.kind === "recognition" && continued.fragments.at(-1)?.finalization).toBe("final");
    const keys = rows().map(e => e.key);
    voice.setState(s => ({ recognition: s.recognition.map(f => ({ ...f, sessionId: "ithaca" })), outputs: s.outputs.map(o => ({ ...o, sessionId: "ithaca" })) }));
    expect(rows().map(e => e.key)).toEqual(keys);
    voice.setState({ recognition: [] });
    expect(rows().map(entryText)).toEqual(["The Sirens note."]);
  } finally { root.dispose(); }
});


test("finish-only evidence keeps its arrival position between contiguous deltas", () => {
  const root = createBrainUiRoot({ storage: null });
  try {
    const fragment = (sequence: number, text: string, finalization: "unknown" | "final" = "unknown") => ({ kind: "unassigned_input_fragment" as const, sequence, text, finalization, conversationId: "ithaca", epoch: 1, sessionId: null, providerId: "gemini-live", activation: 1, contextual: true });
    root.connection.conversation.state.setState({ recognition: [fragment(0, "Which"), fragment(1, "", "final"), fragment(2, " note?")] });
    const row = transcriptTimelineFor(root.stores.chat).state.getState().entries[0]!;
    expect(entryText(row)).toBe("Which note?");
    expect(row.kind === "recognition" && row.fragments.map(f => f.sequence)).toEqual([0, 1, 2]);
  } finally { root.dispose(); }
});

test("durable positions reconstruct mixed text without changing full semantic source or provider provenance",()=>{
 const root=createBrainUiRoot({storage:null});
 try{
  const chat=root.stores.chat.getState();chat.addUserMessage("ithaca","Research the mast.","voice-context",undefined,{requestId:"request"});chat.startAssistantMessage("ithaca","turn");
  const first="1. [Mast](notes/mast.md)\n",last="2. Sail\n";chat.appendText("ithaca",first+last);chat.finishAssistantMessage("ithaca");
  const voice=root.connection.conversation.state;
  const recognition=(sequence:number,text:string)=>({sequence,identity:`rec-${sequence}`,evidence:{kind:"voice" as const,conversationId:"original",epoch:1,providerId:"gemini-live",event:{kind:"unassigned_input_fragment" as const,sequence,text,timing:{kind:"unavailable" as const}}}});
  voice.setState({dialogue:{ithaca:{ownerId:"original",sessionId:"ithaca",generation:1,through:7,coverage:"complete",records:[
   recognition(1,"Find the mast."),
   {sequence:2,identity:"request",evidence:{kind:"request",requestId:"request",turnId:"turn"}},
   {sequence:3,identity:"range-1",evidence:{kind:"backend",turnId:"turn",start:0,end:first.length,text:first,digest:"a".repeat(64)}},
   recognition(4,"While we wait."),
   {sequence:5,identity:"range-2",evidence:{kind:"backend",turnId:"turn",start:first.length,end:first.length+last.length,text:last,digest:"b".repeat(64)}},
   {sequence:6,identity:"output-1",evidence:{kind:"voice",conversationId:"original",epoch:1,providerId:"gemini-live",event:{kind:"output_transcript",outputId:"reply",sequence:0,text:"The mast "}}},
   {sequence:7,identity:"output-2",evidence:{kind:"voice",conversationId:"original",epoch:1,providerId:"gemini-live",event:{kind:"output_transcript",outputId:"reply",sequence:1,text:"is ready."}}},
  ]}},dialogueRestoredThrough:{ithaca:7}});
  const entries=transcriptTimelineFor(root.stores.chat).state.getState().entries.filter(e=>e.sessionId==="ithaca");
  expect(entries.map(entryText).filter(Boolean)).toEqual(["Find the mast.","Research the mast.",first,"While we wait.",last,"The mast is ready."]);
  const answers=entries.filter(e=>e.kind==="message"&&e.section==="answer");expect(answers).toHaveLength(2);
  const progressIndex=entries.findIndex(e=>e.kind==="message"&&e.section==="progress");
  expect(progressIndex).toBeGreaterThan(0);expect(progressIndex).toBeLessThan(entries.indexOf(answers[0]!));
  for(const e of answers){expect(transcriptRange(e)?.source.content).toBe(first+last);}
  const reply=entries.find(e=>e.kind==="speech");expect(reply?.kind==="speech"&&reply.output.providerId).toBe("gemini-live");expect(reply?.kind==="speech"&&reply.restored).toBe(true);
  voice.setState(current=>({dialogue:{...current.dialogue,ithaca:{...current.dialogue.ithaca!,records:current.dialogue.ithaca!.records.filter(r=>r.sequence!==5)}}}));
  const partial=transcriptTimelineFor(root.stores.chat).state.getState().entries;
  expect(partial.filter(e=>e.kind==="message").map(entryText).join("\n")).toContain(first+last);
  expect(partial.some(e=>e.kind==="history-notice"&&e.label==="Original discussion position unknown.")).toBe(true);

 }finally{root.dispose();}
});


test("an observed unsaved tail stays after its committed prefix across later commits and older paging",()=>{
 const root=createBrainUiRoot({storage:null});try{
  const voice=root.connection.conversation.state;
  const event=(sequence:number,text:string)=>({kind:"unassigned_input_fragment" as const,sequence,text,timing:{kind:"unavailable" as const}});
  const record=(sequence:number,inputSequence:number,text:string)=>({sequence,identity:`source-${inputSequence}`,evidence:{kind:"voice" as const,conversationId:"ithaca",epoch:1,providerId:"gpt-live",event:event(inputSequence,text)}});
  const first=record(1001,0,"First."),second=record(1002,1,"Second."),later=record(1003,3,"Later."),older=record(999,4,"Earlier.");
  const page={ownerId:"ithaca",sessionId:"voyage",generation:1,through:1002,coverage:"partial" as const,records:[first,second]};
  voice.setState({dialogue:{voyage:page}});
  voice.setState({recognition:[{...event(2,"Unsaved."),conversationId:"ithaca",epoch:1,providerId:"gpt-live",sessionId:"voyage",activation:1,contextual:true,unsaved:true}]});
  const texts=()=>transcriptTimelineFor(root.stores.chat).state.getState().entries.map(entryText);
  expect(texts().join("")).toBe("First.Second.Unsaved.");
  voice.setState({dialogue:{voyage:{...page,through:1003,records:[first,second,later]}}});
  expect(texts().join("")).toBe("First.Second.Unsaved.Later.");
  voice.setState({dialogue:{voyage:{...page,through:1003,records:[older,first,second,later]}}});
  expect(texts().join("")).toBe("Earlier.First.Second.Unsaved.Later.");
  voice.setState({dialogue:{voyage:{...page,through:1003,records:[later]}}});
  expect(texts().join("")).toBe("Unsaved.Later.");
 }finally{root.dispose();}
});


test("generated committed prefix and unsaved tail keep separate retention qualifiers",()=>{
 const root=createBrainUiRoot({storage:null});try{
  root.connection.conversation.state.setState({dialogue:{voyage:{ownerId:"ithaca",sessionId:"voyage",generation:1,through:1,coverage:"partial",records:[{sequence:1,identity:"reply-0",evidence:{kind:"voice",conversationId:"ithaca",epoch:1,providerId:"gpt-live",event:{kind:"output_transcript",outputId:"reply",sequence:0,text:"Saved."}}}]}},outputs:[{conversationId:"ithaca",epoch:1,providerId:"gpt-live",outputId:"reply",sessionId:"voyage",generated:"Saved.",unsavedGenerated:"Unsaved.",unsavedFragments:1,playback:"unknown"}]});
  const rows=transcriptTimelineFor(root.stores.chat).state.getState().entries.filter(e=>e.kind==="speech");
  expect(rows.map(entryText)).toEqual(["Saved.","Unsaved."]);
  expect(rows.map(e=>e.output.unsaved)).toEqual([undefined,true]);
  expect(rows[0]!.output.unsavedGenerated).toBeUndefined();
 }finally{root.dispose();}
});
