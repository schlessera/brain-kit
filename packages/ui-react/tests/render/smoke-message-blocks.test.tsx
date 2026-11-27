// Render smoke tests for graph answers, attachments, code fences, timed spans and waiting status: mount the components in happy-dom and
// assert the DOM they produce. Fixtures are minimal and keyless; nothing here
// touches the network. Shared setup: ./smoke-harness.tsx.
//
// The DOM module import MUST stay first: it registers the happy-dom globals
// before the component module bodies run (./dom.ts explains why, and why
// `screen` must not be used).
import { registerSmokeMessageBlocksDom, unregisterSmokeMessageBlocksDom } from "./smoke-message-blocks-dom.js";
registerSmokeMessageBlocksDom();

import { installSmokeHarness, render, supportingInput } from "./smoke-harness.js";
import { BrainMarkdown } from "../../src/components/chat/brain-markdown.js";
import { expect, test } from "bun:test";
import { act, fireEvent, waitFor } from "@testing-library/react";
import { RunDetail } from "../../src/components/activity/activity-run-detail.js";
import { BrainUiProvider } from "../../src/root-context.js";
import { createBrainUiRoot, type BrainUiRoot } from "../../src/root.js";
import { registerBuiltinRenderers as registerSupportingRenderers } from "../../src/components/chat/renderers/index.js";
import { MessageBubble as SupportingMessageBubble } from "../../src/components/chat/message-bubble.js";
import { registerBuiltinRenderers as registerGraphRenderers } from "../../src/components/chat/renderers/index.js";
import { BlockCard as GraphAnswerCard } from "../../src/components/chat/tool-cards/block-card.js";
import { MessageBubble as GraphMessageBubble } from "../../src/components/chat/message-bubble.js";
import { SHOW_BLOCK_CONTRACT as GraphContract, parseToolPayload as parseGraphPayload } from "@schlessera/brain-ui-sdk/client";
import { AttachmentRow as SentKitAttachmentRow, type AttachmentRowProps as SentKitAttachmentRowProps } from "@schlessera/brain-ui-kit";
import { sentTrackFiles } from "../sent-track-fixtures.js";
import { renderToStaticMarkup as renderSentAttachmentHtml } from "react-dom/server";
import { trackRowProps as sentTrackRowProps } from "../../src/lib/track-attachment.js";
import { CodeBlock as RuntimeKitCodeBlock } from "@schlessera/brain-ui-kit";
import { MarkdownPre as RuntimeMarkdownPre } from "../../src/components/chat/brain-markdown-code.js";
import { timedSpans as recordedTimedSpans } from "../lane-fixtures.js";
import { MessageBubble as WaitingMessageBubble } from "../../src/components/chat/message-bubble.js";
import { emptyEvidence as waitingEmptyEvidence } from "../../src/lib/trackers.js";
import { StreamingAnswer as WaitingKitAnswer } from "@schlessera/brain-ui-kit";
import { describeRetry as waitingRetryText } from "@schlessera/brain-ui-sdk/internal/client";

installSmokeHarness(unregisterSmokeMessageBlocksDom);

for (const [backend, name] of [["pi", "show_block"], ["claude", "mcp__brain-ui__show_block"]] as const) {
  test(`${backend} session_history replays the supporting list inline in the actual message bubble`, () => {
    const root = createBrainUiRoot({ storage: null }); registerSupportingRenderers(root.renderers);
    const sessionId = "supporting-replay";
    try {
      root.stores.chat.getState().setActiveSession(sessionId);
      root.stores.chat.setState({ backendIds: { [sessionId]: backend } });
      root.connection.handleServerMessage({ type: "session_history", sessionId, messages: [{
        role: "assistant", content: "Supporting notes for the crossing.",
        toolCalls: [{ id: "supporting-replay-tool", name, input: supportingInput, output: JSON.stringify(supportingInput) }],
      }] });
      const messages = root.stores.chat.getState().buffers[sessionId]!.messages;
      expect(messages).toHaveLength(1);
      expect(messages[0]!.toolCalls).toHaveLength(1);
      const noop = () => {};
      const view = render(<BrainUiProvider root={root}><SupportingMessageBubble message={messages[0]!} onToolApproval={noop} onAskUserSubmit={noop} onAskUserCancel={noop} onAskUserListSubmit={noop} /></BrainUiProvider>);
      expect(view.container.querySelectorAll('[data-block="files"]')).toHaveLength(1);
      expect([...view.container.querySelectorAll('.bk-row[role="button"]')].map(row => row.textContent)).toEqual([
        "knowledge/scylla.mdNames the cost in men.", "people/circe.mdGives the directions for the crossing.",
      ]);
    } finally { root.dispose(); }
  });
}

const graphInput = { block: { kind: "graph" as const, nodes: [{ label: "Scylla", path: "knowledge/scylla.md", focus: true }, { label: "Circe", path: "javascript:alert(1)" }], edges: [[0,1],[1,0]] } };

for (const [backend,name] of [["pi","show_block"],["claude","mcp__brain-ui__show_block"]] as const) {
  test(`${backend} renders actual GraphView, supplied edges and a safe textual node link`, () => {
    const requests:string[]=[]; const root=createBrainUiRoot({storage:null,request:async url=>{requests.push(String(url));throw new Error("unexpected lookup");}});
    registerGraphRenderers(root.renderers);
    try {
      const tool={id:"graph",name,input:graphInput,output:JSON.stringify(graphInput)};
      const Output=root.renderers.resolve(tool,backend)!.Output!;
      const view=render(<BrainUiProvider root={root}><Output tool={tool}/></BrainUiProvider>);
      expect(graphInput.block.nodes.length).toBeGreaterThan(0); expect(graphInput.block.edges.length).toBeGreaterThan(0);
      expect(view.container.querySelectorAll('[data-graph-node]')).toHaveLength(2);
      expect(view.container.querySelectorAll('[data-graph-view] line')).toHaveLength(1);
      expect([...view.container.querySelectorAll('[data-graph-node-list] li')].map(n=>n.textContent)).toEqual(["Scyllaknowledge/scylla.md","Circejavascript:alert(1)"]);
      expect([...view.container.querySelectorAll('[data-graph-node-list] a')].map(n=>n.getAttribute("href"))).toEqual(["#/files/knowledge/scylla.md"]);
      expect(view.container.querySelector('[data-graph-edge-list]')!.textContent).toContain("Scylla ↔ Circe");
      expect(requests).toEqual([]); expect(view.container.textContent).not.toContain("34 nodes");
    } finally {root.dispose();}
  });
}

test("graph refused paths stay plain text; safe activation opens only the current root",async()=>{
  const requests:string[]=[];
  const root=createBrainUiRoot({storage:null,config:{backendUrl:"https://alpha.example"},request:async url=>{
    requests.push(String(url));return String(url).includes("/files/content")?Response.json({path:"knowledge/scylla.md",kind:"markdown",content:"# Scylla"}):Response.json({entries:[]});
  }});
  const paths=["knowledge/scylla.md","../people/circe.md","knowledge/../scylla.md","javascript:alert(1)","https://ithaca.example/scylla","/scylla.md","knowledge/scylla.md?raw=1"];
  try {
    const block={kind:"graph" as const,nodes:paths.map((path,i)=>({label:`Scylla ${i+1}`,path})),edges:[]};
    const view=render(<BrainUiProvider root={root}><GraphAnswerCard block={block}/></BrainUiProvider>);
    expect(paths).toHaveLength(7);
    expect(view.queryAllByRole("link").map(a=>a.getAttribute("href"))).toEqual(["#/files/knowledge/scylla.md"]);
    expect(requests).toEqual([]);fireEvent.click(view.getByRole("link",{name:"Scylla 1"}));
    await waitFor(()=>expect(root.stores.file.getState().currentContent?.path).toBe("knowledge/scylla.md"));
    expect(requests).toHaveLength(2);expect(requests.every(url=>new URL(url).origin==="https://alpha.example"&&new URL(url).searchParams.get("path")==="knowledge/scylla.md")).toBe(true);
  } finally {root.dispose();}
});

test("a static graph retains its nodes and edges, clears sample metadata and makes no requests",()=>{
  const root=createBrainUiRoot({storage:null});
  try {
    const payload=parseGraphPayload(GraphContract,JSON.stringify(graphInput))!;
    const view=render(<BrainUiProvider root={root}><GraphAnswerCard {...payload} isStatic/></BrainUiProvider>);
    expect(view.container.querySelectorAll('[data-graph-node-list] li')).toHaveLength(2);
    expect(view.container.querySelectorAll('[data-graph-edge-list] li')).toHaveLength(1);
    expect(view.queryAllByRole("link")).toHaveLength(0);expect(view.queryAllByRole("button")).toHaveLength(0);
    expect(view.container.textContent).not.toContain("2-hop");
  } finally {root.dispose();}
});

for(const [backend,name] of [["pi","show_block"],["claude","mcp__brain-ui__show_block"]] as const){
  test(`${backend} session_history draws the graph in the actual replayed answer`,()=>{
    const root=createBrainUiRoot({storage:null});registerGraphRenderers(root.renderers);const sessionId="graph-replay";
    try {
      root.stores.chat.getState().setActiveSession(sessionId);root.stores.chat.setState({backendIds:{[sessionId]:backend}});
      root.connection.handleServerMessage({type:"session_history",sessionId,messages:[{role:"assistant",content:"Connections at the crossing.",toolCalls:[{id:"graph-replay-tool",name,input:graphInput,output:JSON.stringify(graphInput)}]}]});
      const messages=root.stores.chat.getState().buffers[sessionId]!.messages;expect(messages).toHaveLength(1);expect(messages[0]!.toolCalls).toHaveLength(1);
      const noop=()=>{};const view=render(<BrainUiProvider root={root}><GraphMessageBubble message={messages[0]!} onToolApproval={noop} onAskUserSubmit={noop} onAskUserCancel={noop} onAskUserListSubmit={noop}/></BrainUiProvider>);
      expect(view.container.querySelectorAll('[data-graph-node]')).toHaveLength(2);expect(view.container.querySelectorAll('[data-graph-view] line')).toHaveLength(1);
    } finally {root.dispose();}
  });
}

for (const backend of ["claude", "pi"] as const) for (const [clock, hour, minute] of [["10:38", 10, 38], ["12:15", 12, 15]] as const) {
  test(`${backend} actual sent and replayed validated tracks use identical static kit attachment rows (${clock} message time)`, () => {
    // The message clock may resemble audio duration; attachment assertions own only their rows (#1264).
    const timestamp = new Date(2026, 6, 12, hour, minute).getTime();
    const root = createBrainUiRoot({ storage: null }); const files = sentTrackFiles(); const sessionId = `sent-tracks-${backend}`;
    expect(files[0]!.detected).toBe("gpx"); expect(files[0]!.summary!.status).not.toBe("no_line");
    expect(files[1]!.detected).toBe("kml"); expect(files[1]!.summary!.status).toBe("no_line"); expect(files[1]!.summary!.waypointCount).toBe(4);
    for (const file of files) { expect(file.bytes).toBeGreaterThan(0); expect(file.bytes).toBeLessThan(1024); }
    root.stores.chat.getState().setActiveSession(sessionId); root.stores.chat.setState({ backendIds: { [sessionId]: backend } });
    root.stores.chat.getState().addUserMessage(sessionId, "Here is the route.", undefined, undefined, undefined, files);
    const noop = () => {};
    const bubble = () => <BrainUiProvider root={root}><SupportingMessageBubble message={{ ...root.stores.chat.getState().buffers[sessionId]!.messages.at(-1)!, timestamp }}
      onToolApproval={noop} onAskUserSubmit={noop} onAskUserCancel={noop} onAskUserListSubmit={noop}/></BrainUiProvider>;
    try {
      const view = render(bubble()); expect(root.stores.chat.getState().buffers[sessionId]!.messages[0]!.files).toHaveLength(2);
      const rows = [...view.container.querySelectorAll('[data-kit-attachment-row]')]; expect(rows).toHaveLength(2);
      expect(view.container.textContent).toContain(clock);
      for (const row of rows) {
        expect(row.textContent).not.toContain("sent · staged");
        expect(row.textContent).not.toContain("0:38");
        expect(row.textContent).not.toContain("transcribed on device");
        expect(row.textContent).not.toContain("untrusted");
        expect(row.querySelectorAll('a,button,[role="button"],[tabindex]')).toHaveLength(0);
      }
      const text = rows.map(row => row.textContent);
      expect(text[0]).toBe(files[0]!.incomingName + `GPX · ${files[0]!.bytes} B · sentStaged as ${files[0]!.name}`);
      expect(text[1]).toBe(files[1]!.name + `KML · ${files[1]!.bytes} B · sent4 waypoints; no usable track line. The original is attached.`);
      act(() => root.connection.handleServerMessage({ type: "session_history", sessionId, messages: [{ role: "user", content: "Here is the route.", toolCalls: [], files }] }));
      view.rerender(bubble()); expect([...view.container.querySelectorAll('[data-kit-attachment-row]')].map(row => row.textContent)).toEqual(text);
      expect(view.container.textContent).toContain(clock);
    } finally { act(() => root.dispose()); }
  });
}

test("no fabricated attachment label when a legacy JavaScript caller supplies none", () => {
  const view = render(<SentKitAttachmentRow {...({ kind: "doc", actionIcon: "" } as SentKitAttachmentRowProps)}/>);
  expect(view.container.textContent).toBe("");
});

test("an explicit audio identity invents no duration, extract, metadata or waveform", () => {
  const view = render(<SentKitAttachmentRow kind="audio" label="Crossing directions" actionIcon=""/>);
  expect(view.container.textContent).toBe("Crossing directions");
  expect([...view.container.querySelectorAll<HTMLElement>('span')].filter(span => span.style.width === "2px")).toHaveLength(0);
});

test("image-count-only history keeps the truthful chip without attachment rows", () => {
  const root = createBrainUiRoot({ storage: null }); const noop = () => {};
  try {
    root.stores.chat.getState().setActiveSession("images-replay");
    root.connection.handleServerMessage({ type: "session_history", sessionId: "images-replay", messages: [{ role: "user", content: "The crossing.", attachmentCount: 2, toolCalls: [] }] });
    const message = root.stores.chat.getState().buffers["images-replay"]!.messages[0]!;
    const view = render(<BrainUiProvider root={root}><SupportingMessageBubble message={message} onToolApproval={noop} onAskUserSubmit={noop} onAskUserCancel={noop} onAskUserListSubmit={noop}/></BrainUiProvider>);
    expect(view.container.textContent).toContain("2 images"); expect(view.container.querySelectorAll('[data-kit-attachment-row],img')).toHaveLength(0);
    expect(view.container.textContent).not.toContain("Sailing directions");
  } finally { root.dispose(); }
});

test("static sent-track HTML retains supplied facts as escaped text without pretend controls", () => {
  const files = sentTrackFiles(); files[0]!.incomingName = '<b>Scylla</b>.gpx';
  const html = renderSentAttachmentHtml(<>{files.map(file => <SentKitAttachmentRow key={file.path} {...sentTrackRowProps(file)}/>)}</>);
  const view = document.createElement("div"); view.innerHTML = html;
  expect(view.querySelectorAll('[data-kit-attachment-row]')).toHaveLength(2);
  expect(view.textContent).toContain('<b>Scylla</b>.gpx'); expect(view.querySelector('b b')).toBeNull();
  expect(view.querySelectorAll('a,button,[role="button"],[tabindex]')).toHaveLength(0);
  expect(view.textContent).toContain("4 waypoints; no usable track line. The original is attached.");
});

test("missing sent-track metadata invents no original name, byte count or provenance", () => {
  const file = { path: "voyage/unknown", name: "", mediaType: "application/octet-stream" } as import("@schlessera/brain-ui-sdk/protocol").SharedFileMeta;
  const view = render(<SentKitAttachmentRow {...sentTrackRowProps(file)}/>);
  expect(view.container.textContent).toBe("Unnamed tracktrack file · sent");
  expect(view.container.textContent).not.toContain("Sailing directions"); expect(view.container.textContent).not.toContain("0 B");
  expect(view.container.querySelectorAll('[role="button"],[tabindex]')).toHaveLength(0);
});

test("an ordinary nonempty Markdown fence uses the kit CodeBlock", () => {
  const root = createBrainUiRoot({ storage: null });
  try {
    const view = render(<BrainUiProvider root={root}><BrainMarkdown content={'```js\nconst crossing = "Scylla";\n```'} /></BrainUiProvider>);
    expect(view.container.querySelector("pre")!.textContent).toContain('const crossing = "Scylla";');
    expect(view.container.querySelectorAll('[data-kit-code-block]')).toHaveLength(1);
  } finally { root.dispose(); }
});

test("highlighted and linkified fence Copy retains the exact source rather than painted text", async () => {
  const source = 'echo "Circe"\n[[circe|guide]]\nknowledge/scylla.md\n<b>Odysseus</b>';
  const writes: string[] = [];
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: (text: string) => { writes.push(text); return Promise.resolve(); } } });
  const root = createBrainUiRoot({ storage: null });
  root.stores.file.setState({ wikilinkLoaded: true, wikilinkMap: { circe: "people/circe.md" } });
  try {
    const view = render(<BrainUiProvider root={root}><BrainMarkdown content={'```bash\n' + source + '\n```'} fileLinks /></BrainUiProvider>);
    await waitFor(() => expect(view.container.querySelectorAll('.hljs-string').length).toBeGreaterThan(0));
    expect(view.container.querySelectorAll('pre .brain-wiki-link')).toHaveLength(1);
    expect(view.container.querySelector('pre')!.textContent!.includes('[[circe|guide]]')).toBe(false);
    fireEvent.click(view.getByRole("button", { name: /^Copy$/ }));
    expect(writes).toEqual([source]);
    expect(view.container.querySelector('pre b')).toBeNull();
  } finally { root.dispose(); }
});

test("code without an info string has no invented language or sample or copy glyph", () => {
  const view = render(<RuntimeKitCodeBlock />);
  expect(view.container.textContent).toBe("");
  expect(view.container.querySelectorAll("svg")).toHaveLength(0);
});

test("Mermaid keeps its renderer instead of a code card", async () => {
  const root = createBrainUiRoot({ storage: null });
  try {
    const view = render(<BrainUiProvider root={root}><RuntimeMarkdownPre><code className="language-mermaid">{"graph LR; Troy-->Ithaca\n"}</code></RuntimeMarkdownPre></BrainUiProvider>);
    await waitFor(() => expect(view.container.querySelector('[data-content-renderer="mermaid"]'), "MERMAID_LAZY_RENDERER_SETTLED").toBeTruthy());
    expect(view.container.querySelectorAll('[data-kit-code-block]')).toHaveLength(0);
    expect(view.container.textContent).toContain("graph LR; Troy-->Ithaca");
  } finally { root.dispose(); }
});

for (const backend of ["claude", "pi"] as const) {
  test(`${backend} streamed and replayed code fences keep nonempty source in the actual message bubble`, () => {
    const root = createBrainUiRoot({ storage: null });
    const sessionId = `code-${backend}`;
    root.stores.file.setState({ wikilinkLoaded: true, wikilinkMap: {} });
    root.stores.chat.getState().setActiveSession(sessionId);
    root.stores.chat.setState({ backendIds: { [sessionId]: backend } });
    const partial = '```bash\necho "Scylla"'; const complete = partial + ' --final-argument\n```';
    const noop = () => {};
    const bubble = () => <BrainUiProvider root={root}><SupportingMessageBubble message={root.stores.chat.getState().buffers[sessionId]!.messages.at(-1)!}
      onToolApproval={noop} onAskUserSubmit={noop} onAskUserCancel={noop} onAskUserListSubmit={noop}/></BrainUiProvider>;
    try {
      root.stores.chat.getState().startAssistantMessage(sessionId);
      root.connection.handleServerMessage({ type: "text_delta", sessionId, text: partial });
      root.connection.flushChatDeltas();
      const view = render(bubble());
      expect(root.stores.chat.getState().buffers[sessionId]!.messages.at(-1)!.content).toBe(partial);
      expect(view.container.querySelectorAll('[data-kit-code-block]')).toHaveLength(1);
      expect(view.container.querySelector('pre')!.textContent).toContain('echo "Scylla"');
      root.stores.chat.getState().finishAssistantMessage(sessionId);
      act(() => root.connection.handleServerMessage({ type: "session_history", sessionId, messages: [{ role: "assistant", content: complete, toolCalls: [] }] }));
      view.rerender(bubble());
      expect(root.stores.chat.getState().buffers[sessionId]!.messages.at(-1)!.content).toBe(complete);
      expect(view.container.querySelectorAll('[data-kit-code-block]')).toHaveLength(1);
      expect(view.container.querySelector('pre')!.textContent).toContain('echo "Scylla" --final-argument');
    } finally { root.dispose(); }
  });
}

for (const backend of ["claude","pi"] as const) {
  test(`${backend} actual run detail renders LaneChart from overlapping recorded intervals`,async()=>{
    const spans=recordedTimedSpans();const root=createBrainUiRoot({storage:null,request:async()=>Response.json({runId:"crossing-lanes",detailPruned:false,spans,events:[],highWaterSeq:0})});
    root.stores.activity.setState({supported:true});root.stores.chat.setState({backendIds:{"crossing-chat":backend}});
    try{
      const view=render(<BrainUiProvider root={root}><RunDetail runId="crossing-lanes" onBack={()=>{}}/></BrainUiProvider>);
      await waitFor(()=>expect(root.stores.activity.getState().spanRun['ledger']).toBe('crossing-lanes'));
      expect(spans.filter(s=>s.parentSpanId)).toHaveLength(4);
      expect(view.container.querySelectorAll('[data-kit-lane-chart]')).toHaveLength(1);
      const ledger=view.container.querySelector('[data-lane-name="ledger"] [data-lane-segment]') as HTMLElement;
      expect(ledger.style.left).toBe('25%');expect(ledger.style.width).toBe('50%');
      expect(view.container.querySelectorAll('[data-lane-hatch="true"]')).toHaveLength(1);
      expect(view.container.querySelectorAll('[data-lane-fade="true"]')).toHaveLength(0);
      expect(view.container.querySelector('[data-run-lanes]')!.textContent).toContain('cancelled');
      expect(view.container.querySelector('[data-run-lanes]')!.textContent).toContain('denied');
    }finally{await act(async()=>root.dispose());}
  });
}

function waitingBubble(root: BrainUiRoot, message: import("../../src/stores/chat-store.js").ChatMessage) {
  const noop = () => {};
  return <BrainUiProvider root={root}><WaitingMessageBubble message={message} onToolApproval={noop}
    onAskUserSubmit={noop} onAskUserCancel={noop} onAskUserListSubmit={noop}/></BrainUiProvider>;
}

for (const backend of ["claude", "pi"] as const) {
  test(`${backend} actual no-first-token turn uses two kit ghosts without answer text or its own Stop`, () => {
    const root = createBrainUiRoot({ storage: null });
    try {
      const chat = root.stores.chat.getState(); chat.setActiveSession("waiting-turn");
      root.stores.chat.setState({ backendIds: { "waiting-turn": backend } });
      chat.startAssistantMessage("waiting-turn", "odysseus-turn");
      const message = root.stores.chat.getState().buffers["waiting-turn"]!.messages[0]!;
      expect(message.isStreaming).toBe(true); expect(message.parts).toHaveLength(0);
      const view = render(waitingBubble(root, message));
      const row = view.container.querySelector('[data-kit-streaming-answer]'); expect(row !== null).toBe(true);
      expect(row!.querySelector('[aria-live="polite"]')!.textContent).toBe("thinking");
      expect(row!.querySelectorAll('.bk-ghost')).toHaveLength(2);
      expect(row!.querySelectorAll('[role="button"],button')).toHaveLength(0);
      expect(row!.textContent).not.toContain("Stop"); expect(row!.textContent).not.toContain("$");
      expect(row!.textContent).not.toContain("tools done"); expect(row!.textContent).not.toContain("Three venues");
      act(() => chat.appendText("waiting-turn", "Circe **names the passage**."));
      view.rerender(waitingBubble(root, root.stores.chat.getState().buffers["waiting-turn"]!.messages[0]!));
      expect(view.container.querySelector('[data-kit-streaming-answer]')).toBeNull();
      expect(view.container.querySelector('strong')!.textContent).toBe("names the passage");
    } finally { act(() => root.dispose()); }
  });
}

test("kit status supplies no unmeasured cost, target, elapsed, phase or answer", () => {
  const view = render(<WaitingKitAnswer bars={false}/>);
  expect(view.container.textContent).not.toContain("$");
  expect(view.container.textContent).toBe("Stop");
});

test("kit announces only the phase word, leaving supplied elapsed and target outside it", () => {
  const view = render(<WaitingKitAnswer phase="thinking" elapsed="4s" target="Scylla passage" bars={false} stoppable={false}/>);
  const live = view.container.querySelector('[aria-live="polite"]')!;
  expect(live.textContent).toBe("thinking");
  view.rerender(<WaitingKitAnswer phaseLabel="waiting for approval" elapsed="5s" target="Write" bars={false} stoppable={false}/>);
  expect(live.textContent).toBe("waiting for approval");
});

test("waiting status follows thinking, tools, approvals, retry and terminal facts without duplicating prose", () => {
  const root = createBrainUiRoot({ storage: null });
  try {
    const chat = root.stores.chat.getState(); chat.startAssistantMessage(null, "crossing-turn");
    const current = () => root.stores.chat.getState().draft!.messages.at(-1)!;
    const view = render(waitingBubble(root, current()));
    const redraw = () => view.rerender(waitingBubble(root, current()));
    expect(view.container.querySelector('[data-kit-streaming-answer]') !== null).toBe(true);
    act(() => chat.appendThinking(null, "Compare the cost of each passage.")); redraw();
    expect(view.container.querySelector('[data-kit-streaming-answer]')).toBeNull();
    expect(view.container.textContent).toContain("Compare the cost of each passage.");
    act(() => chat.startToolCall(null, "read-directions", "Read")); redraw();
    expect(current().toolCalls).toHaveLength(1);
    expect(view.container.querySelector('[data-kit-streaming-answer]')).toBeNull();
    act(() => chat.requestToolApproval(null, "write-directions", "Write", { file_path: "voyage/crossing.md", content: "Keep six men clear of Scylla." })); redraw();
    const row = view.container.querySelector('[data-kit-streaming-answer]')!;
    expect(row !== null).toBe(true); expect(row.textContent).toContain("waiting for approval"); expect(row.textContent).toContain("Write");
    expect(row.querySelectorAll('.bk-ghost,button,[role="button"]')).toHaveLength(0);
    expect(view.getByRole('button', { name: 'Allow' })).toBeTruthy();
    const retry = { attempt: 2, maxAttempts: 5, delayMs: 8000, errorClass: "overloaded", status: 503 };
    act(() => chat.setRetry(null, retry)); redraw();
    expect(view.container.querySelectorAll('[data-kit-streaming-answer]')).toHaveLength(1);
    expect(view.container.querySelector('[data-kit-streaming-answer]')!.textContent).toContain(waitingRetryText(retry));
    expect(view.container.querySelector('[aria-live="polite"]')!.textContent).toBe("retrying");
    act(() => { chat.resolveToolApproval(null, "write-directions", true); chat.appendText(null, "Take the **Scylla passage**."); }); redraw();
    expect(view.container.querySelector('[data-kit-streaming-answer]')).toBeNull();
    expect(view.container.querySelector('strong')!.textContent).toBe("Scylla passage");
    act(() => chat.finishAssistantMessage(null)); redraw();
    expect(current().isStreaming).toBe(false); expect(view.container.querySelector('[data-kit-streaming-answer]')).toBeNull();
  } finally { act(() => root.dispose()); }
});

test("a recovered waiting shell without a host start has no elapsed, and host timing matches its turn", () => {
  const root = createBrainUiRoot({ storage: null });
  try {
    const chat = root.stores.chat.getState(); chat.setActiveSession("restored-wait"); chat.startAssistantMessage("restored-wait", "restored-turn");
    const base = root.stores.chat.getState().buffers["restored-wait"]!.messages[0]!;
    const shell = { ...base, turnShell: true as const };
    const view = render(waitingBubble(root, shell));
    expect(view.container.querySelector('[data-stream-elapsed]')).toBeNull();
    act(() => root.stores.trackers.setState({ recoverySupported: true, evidence: { "restored-wait": {
      ...waitingEmptyEvidence(), latest: { requestId: null, turnId: "different-turn", state: "running", outcome: null, endedAt: null, startedAt: Date.now() - 70_000 }
    } } }));
    expect(view.container.querySelector('[data-stream-elapsed]')).toBeNull();
    act(() => root.stores.trackers.setState({ evidence: { "restored-wait": {
      ...waitingEmptyEvidence(), latest: { requestId: null, turnId: "restored-turn", state: "running", outcome: null, endedAt: null, startedAt: Date.now() - 70_000 }
    } } }));
    expect(view.container.querySelector('[data-stream-elapsed]')!.textContent).toMatch(/^1m (9|10)s$/);
  } finally { act(() => root.dispose()); }
});

test("actual restored pending approval shell keeps truthful wait status until the host closes it", () => {
  const root = createBrainUiRoot({ storage: null });
  try {
    const chat = root.stores.chat.getState(); chat.setActiveSession("restored-approval-wait");
    chat.addUserMessage("restored-approval-wait", "Write the directions.", "typed");
    chat.requestToolApproval("restored-approval-wait", "pending-write", "Write", { file_path: "voyage/directions.md" }, undefined, "tool", true, "restored-turn");
    const current = () => root.stores.chat.getState().buffers["restored-approval-wait"]!.messages.at(-1)!;
    expect(current().turnShell).toBe(true); expect(current().isStreaming).toBe(false); expect(current().toolCalls[0]!.restored).toBe(true);
    const view = render(waitingBubble(root, current()));
    expect(view.container.querySelector('[data-kit-streaming-answer]') !== null).toBe(true);
    expect(view.container.querySelector('[aria-live="polite"]')!.textContent).toBe("waiting for approval");
    expect(view.container.querySelector('[data-stream-elapsed]')).toBeNull();
    act(() => chat.closeRestoredApprovals("restored-approval-wait", [{ toolUseId: "pending-write", closure: "ended" }]));
    view.rerender(waitingBubble(root, current()));
    expect(view.container.querySelector('[data-kit-streaming-answer]')).toBeNull();
  } finally { act(() => root.dispose()); }
});

test("an older pending tool does not label a later running tool group as approval-wait", () => {
  const root = createBrainUiRoot({ storage: null });
  try {
    const chat = root.stores.chat.getState(); chat.startAssistantMessage(null);
    chat.requestToolApproval(null, "old-write", "Write", { file_path: "voyage/directions.md" });
    chat.appendText(null, "The passage remains open."); chat.startToolCall(null, "new-read", "Read");
    const message = root.stores.chat.getState().draft!.messages.at(-1)!;
    expect(message.toolCalls[0]!.status).toBe("pending_approval"); expect(message.toolCalls[1]!.status).toBe("streaming");
    const view = render(waitingBubble(root, message));
    expect(view.container.querySelector('[data-kit-streaming-answer]') !== null).toBe(false);
    expect(view.container.textContent).toContain("The passage remains open.");
  } finally { act(() => root.dispose()); }
});

test("actual history with a restored approval never uses replay time as elapsed", () => {
  const root = createBrainUiRoot({ storage: null });
  try {
    const chat = root.stores.chat.getState(); chat.setActiveSession("restored-history-wait");
    root.connection.handleServerMessage({ type: "session_history", sessionId: "restored-history-wait", messages: [
      { role: "user", content: "Write the directions.", toolCalls: [] },
      { role: "assistant", content: "The directions are ready.", toolCalls: [], turnId: "restored-turn" }
    ] });
    chat.requestToolApproval("restored-history-wait", "pending-write", "Write", { file_path: "voyage/directions.md" }, undefined, "tool", true, "restored-turn");
    const message = root.stores.chat.getState().buffers["restored-history-wait"]!.messages.at(-1)!;
    expect(message.turnShell).toBeUndefined(); expect(message.toolCalls[0]!.restored).toBe(true); expect(message.content).toBe("The directions are ready.");
    const view = render(waitingBubble(root, message));
    expect(view.container.querySelector('[data-kit-streaming-answer]') !== null).toBe(true);
    expect(view.container.querySelector('[data-stream-elapsed]') !== null).toBe(false);
  } finally { act(() => root.dispose()); }
});
