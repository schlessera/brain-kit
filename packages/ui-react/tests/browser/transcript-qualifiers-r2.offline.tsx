/// <reference types="@vitest/browser-playwright" />
import { afterAll, beforeAll, expect, test, type TestContext } from "vitest";
import { commands, page, userEvent } from "vitest/browser";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { createBrainUiRoot } from "../../src/root.js";
import { BrainUiProvider } from "../../src/root-context.js";
import { ChatPage } from "../../src/components/chat/chat-page.js";
import { ConversationOutput } from "../../src/components/voice/conversation-outputs.js";
import { TranscriptQualifiers } from "@schlessera/brain-ui-kit/internal";
import { transcriptTimelineFor } from "../../src/lib/transcript-timeline.js";
import type { ConversationRecognition } from "../../src/voice/conversation-client.js";
import { installFaultNetwork } from "./offline/fault-network.js";

const SESSION = "odysseus-raft";
let styles: HTMLStyleElement;
beforeAll(async () => { styles = document.createElement("style"); styles.textContent = await commands.formConsumerStyles(); document.head.append(styles); });
afterAll(() => styles.remove());

async function scene(ctx: TestContext, width = 320, theme: "light" | "dark" = "dark", zoom = 1, fullChat = true) {
  const previous = { width: innerWidth, height: innerHeight, theme: document.documentElement.dataset.theme, size: document.documentElement.style.fontSize };
  const outer = await commands.formViewport(width, 720);
  await page.viewport(width, 720);
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.fontSize = `${16 * zoom}px`;
  const network = installFaultNetwork({ routes: url => url.pathname.endsWith("/sessions") ? Response.json({ sessions: [] }) : undefined,
    onOpen(socket) { socket.deliver({ type: "server_hello", protocolRev: 5, principalKey: "odysseus", capabilities: {} }); socket.deliver({ type: "session_info", sessionId: SESSION, isNew: false }); socket.deliver({ type: "session_history", sessionId: SESSION, messages: [] }); socket.deliver({ type: "status", sessionId: SESSION, status: "idle" }); } });
  const ui = createBrainUiRoot({ storage: null, request: network.request });
  ui.stores.chat.getState().setActiveSession(SESSION);
  ui.stores.ui.getState().setTheme(theme);
  const host = document.createElement("div"); host.style.cssText = `position:fixed;inset:0;width:${width}px;height:720px;background:var(--bk-color-canvas);padding:${fullChat ? 0 : 16}px;color:var(--bk-color-ink);overflow:auto`;
  document.body.append(host);
  const root = createRoot(host);
  const render = (content = <ChatPage />) => flushSync(() => root.render(<BrainUiProvider root={ui}>{content}</BrainUiProvider>));
  render(fullChat ? <ChatPage /> : <></>);
  const release = ui.connection.connect();
  ctx.onTestFinished(async () => { flushSync(() => root.unmount()); release(); ui.dispose(); network.restore(); host.remove(); document.documentElement.style.fontSize = previous.size; if (previous.theme === undefined) delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = previous.theme; await page.viewport(previous.width, previous.height); await commands.formViewport(outer.width, outer.height); });
  await expect.poll(() => ui.stores.connection.getState().wsStatus).toBe("connected");
  return { ui, host, render };
}
function fragments(providerId = "gemini-live", count = 100): ConversationRecognition[] {
  return Array.from({ length: count }, (_, sequence) => ({ kind: "unassigned_input_fragment", conversationId: "odysseus-voice", epoch: 1, sessionId: SESSION, providerId, activation: 1, contextual: true, sequence, timing: { kind: "unavailable" }, text: sequence === 0 ? "Find the raft preparation notes. " : "Keep the launch list within reach. ", finalization: sequence === count - 1 ? "final" : "unknown" }));
}
function qualifier(host: ParentNode, kind = "recognized") { return host.querySelector<HTMLButtonElement>(`[data-transcript-qualifiers="${kind}"]`)!; }
async function closeDetails() { await userEvent.keyboard("{Escape}"); await expect.poll(() => document.querySelector("dialog[open]")).toBeNull(); }

// Independent R1 regressions, retained as causal browser assertions.
test("review: technical evidence is reachable with native Tab", async ctx => {
  const s = await scene(ctx, 320, "dark", 1, false);
  s.render(<ConversationOutput output={{conversationId:"odysseus-voice",epoch:1,sessionId:SESSION,providerId:"gemini-live",outputId:"raft",generated:"The raft is ready.",playback:"unknown"}} />);
  const trigger=qualifier(s.host,"generated"); trigger.focus();
  await userEvent.keyboard("{Enter}");
  const visited:string[]=[];
  for(let n=0;n<4;n++){await userEvent.keyboard("{Tab}");visited.push(document.activeElement?.tagName+":"+document.activeElement?.textContent);}
  console.log("REVIEW_TAB", JSON.stringify(visited));
  expect(visited.some(x=>x.startsWith("SUMMARY:")),"Tab must reach collapsed technical evidence").toBe(true);
  const summary = document.querySelector<HTMLDialogElement>("dialog[open]")!.querySelector("summary")!;
  expect(document.activeElement).toBe(summary);
  await userEvent.keyboard(" ");
  expect(summary.parentElement!.hasAttribute("open"), "Space operates the reached native disclosure").toBe(true);
  await closeDetails();
  expect(document.activeElement).toBe(trigger);
});
test("review: task request offers exact View result", async ctx => {
  const s = await scene(ctx);
  s.ui.stores.chat.getState().addUserMessage(SESSION,"Find the raft notes.","voice-context");
  s.ui.stores.chat.setState(state=>({buffers:{...state.buffers,[SESSION]:{...state.buffers[SESSION]!,messages:state.buffers[SESSION]!.messages.map(m=>({...m,requestId:"raft-request",turnId:"raft-turn"}))}}}));
  flushSync(()=>s.ui.connection.conversation.state.setState({work:{"raft-request":{conversationId:"odysseus-voice",epoch:1,sessionId:SESSION,requestId:"raft-request",turnId:"raft-turn",taskId:"raft-task",nativeHandle:"raft-native",provenance:"contextual",state:"completed",delivery:"returned",submitted:"Find the raft notes.",recognized:""}}}));
  const request=s.ui.stores.chat.getState().buffers[SESSION]!.messages.at(-1)!;
  const answer={...request,id:"raft-answer",role:"assistant" as const,source:undefined,content:"The raft notes are ready.",parts:[{kind:"text" as const,text:"The raft notes are ready."}],toolCalls:[],isStreaming:false};
  flushSync(()=>s.ui.stores.chat.setState(state=>({buffers:{...state.buffers,[SESSION]:{...state.buffers[SESSION]!,messages:[...state.buffers[SESSION]!.messages,{...answer,id:"unrelated-answer",requestId:"unrelated-request",turnId:"unrelated-turn"},answer]}}})));
  await expect.poll(()=>s.host.querySelector("[data-conversation-task-result]")).not.toBeNull();
  expect([...s.host.querySelectorAll('button,[role="button"]')].some(x=>x.textContent==="View request"),"fixture has exact backlink").toBe(true);
  console.log("REVIEW_LINKS",JSON.stringify([...s.host.querySelectorAll('button,[role="button"]')].map(x=>x.textContent).filter(x=>x?.includes("View"))));
  expect([...s.host.querySelectorAll('button,[role="button"]')].some(x=>x.textContent==="View result"),"request must expose exact retained result").toBe(true);
  const answerEntry = transcriptTimelineFor(s.ui.stores.chat).state.getState().entries.find(e => e.kind === "message" && e.message.id === answer.id && e.section !== "progress")!;
  await userEvent.click(page.getByRole("button", { name: "View result", exact: true }));
  await expect.poll(() => (document.activeElement as HTMLElement)?.dataset.arrivalKey).toBe(answerEntry.key);
  await userEvent.click(page.getByRole("button", { name: "View request", exact: true }));
  await expect.poll(() => document.activeElement?.textContent).toContain("Conversation task · Complete");
});
test("review: incoming rows preserve open details and focus fallback", async ctx => {
  const s=await scene(ctx);
  const outputs=Array.from({length:40},(_,i)=>({conversationId:"odysseus-voice",epoch:1,sessionId:SESSION,providerId:"gemini-live",outputId:`raft-${i}`,generated:`Raft report ${i}.`,playback:"unknown" as const}));
  flushSync(()=>s.ui.connection.conversation.state.setState({outputs}));
  const trigger=qualifier(s.host,"generated"); trigger.scrollIntoView(); await userEvent.click(trigger);
  expect(document.querySelector("dialog[open]")).not.toBeNull();
  flushSync(()=>s.ui.connection.conversation.state.setState({outputs:[...outputs,{...outputs[0]!,outputId:"raft-new",generated:"A new report."}]}));
  console.log("REVIEW_WINDOW",JSON.stringify({dialog:!!document.querySelector("dialog[open]"),connected:trigger.isConnected,focus:document.activeElement?.tagName}));
  expect(document.querySelector("dialog[open]"),"new arrival must not dismiss evidence being read").not.toBeNull();
  const added = Array.from({length:100},(_,i)=>({...outputs[0]!,outputId:`raft-more-${i}`,generated:`Later report ${i}.`}));
  flushSync(()=>s.ui.connection.conversation.state.setState({outputs:[...outputs,...added]}));
  expect(trigger.isConnected, "canonical owner stays mounted").toBe(true);
  expect(s.host.querySelectorAll("[data-arrival-key]"), "pin retains one row, not the whole growing transcript").toHaveLength(41);
  expect(document.activeElement?.closest("dialog[open]"), "reader focus remains in dialog").not.toBeNull();
  await closeDetails();
  expect(document.activeElement, "closing returns to the retained source opener").toBe(trigger);
  await userEvent.keyboard("{Tab}");
  await expect.poll(()=>s.host.querySelectorAll("[data-arrival-key]").length).toBe(40);
  expect(document.activeElement).not.toBe(document.body);
  expect(trigger.isConnected, "pin releases when focus leaves its row").toBe(false);
});

test("nested native disclosures participate only while actually visible", async ctx => {
  const s = await scene(ctx, 320, "dark", 1, false);
  s.render(<TranscriptQualifiers kind="recognized" source="Gemini Live" evidenceLabel="Technical evidence (host request)"><details><summary>Nested evidence</summary><button type="button">Read nested evidence</button></details></TranscriptQualifiers>);
  const trigger = qualifier(s.host); trigger.focus(); await userEvent.keyboard("{Enter}");
  const dialog = document.querySelector<HTMLDialogElement>("dialog[open]")!;
  await userEvent.keyboard("{Tab}{Tab}");
  expect(document.activeElement?.textContent).toBe("Technical evidence (host request)");
  await userEvent.keyboard("{Enter}{Tab}");
  expect(document.activeElement?.textContent).toBe("Nested evidence");
  await userEvent.keyboard("{Tab}");
  expect(document.activeElement?.getAttribute("aria-label")).toBe("Close transcript details");
  await userEvent.keyboard("{Shift>}{Tab}{/Shift}");
  expect(document.activeElement?.textContent).toBe("Nested evidence");
  await userEvent.keyboard("{Enter}{Tab}");
  expect(document.activeElement?.textContent).toBe("Read nested evidence");
  expect(dialog.contains(document.activeElement)).toBe(true);
  await closeDetails();
  expect(document.activeElement).toBe(trigger);
});

test("canonical source removal closes details onto a surviving reading anchor", async ctx => {
  const s = await scene(ctx);
  const output = {conversationId:"odysseus-voice",epoch:1,sessionId:SESSION,providerId:"gemini-live",outputId:"raft-source",generated:"The raft source.",playback:"unknown" as const};
  flushSync(()=>s.ui.connection.conversation.state.setState({outputs:[output]}));
  const trigger=qualifier(s.host,"generated"); const readingAnchor = trigger.closest("[data-reading-column]"); await userEvent.click(trigger);
  expect(document.querySelector("dialog[open]")).not.toBeNull();
  flushSync(()=>s.ui.connection.conversation.state.setState({outputs:[{...output,outputId:"raft-retained",generated:"Another retained report."}]}));
  await expect.poll(()=>document.querySelector("dialog[open]")).toBeNull();
  await expect.poll(()=>document.activeElement).not.toBe(document.body);
  expect(document.activeElement).toBe(readingAnchor);
});

for (const kind of ["recognized", "legend"] as const) test(`recognition ${kind} shares bounded reading ownership`, async ctx => {
  const s = await scene(ctx);
  const recognition = fragments("gemini-live", 1);
  const outputs=Array.from({length:39},(_,i)=>({conversationId:"odysseus-voice",epoch:1,sessionId:SESSION,providerId:"gemini-live",outputId:`raft-${i}`,generated:`Report ${i}.`,playback:"unknown" as const}));
  flushSync(()=>s.ui.connection.conversation.state.setState({recognition}));
  flushSync(()=>s.ui.connection.conversation.state.setState({outputs}));
  const row = s.host.querySelector<HTMLElement>("[data-conversation-recognition]")!;
  const trigger = kind === "recognized" ? qualifier(row) : [...row.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent === "Transcript symbols")!;
  expect(s.host.querySelector("[data-arrival-key]")!.contains(trigger), "fixture recognition is the oldest visible canonical row").toBe(true);
  trigger.scrollIntoView(); await userEvent.click(trigger);
  expect(document.querySelector("dialog[open]")).not.toBeNull();
  flushSync(()=>s.ui.connection.conversation.state.setState({outputs:[...outputs,{...outputs[0]!,outputId:"raft-tail"}]}));
  expect(document.querySelector("dialog[open]")).not.toBeNull();
  expect(trigger.isConnected).toBe(true);
  await closeDetails();
  expect(document.activeElement).toBe(trigger);
  const target = document.createElement("button"); target.textContent = "Continue reading elsewhere"; document.body.append(target); ctx.onTestFinished(() => target.remove());
  target.focus();
  await expect.poll(()=>trigger.isConnected).toBe(false);
  expect(s.host.querySelectorAll("[data-arrival-key]")).toHaveLength(40);
});

test("focused qualifier explanation retains its source before activation", async ctx => {
  const s=await scene(ctx);
  const outputs=Array.from({length:40},(_,i)=>({conversationId:"odysseus-voice",epoch:1,sessionId:SESSION,providerId:"gemini-live",outputId:`focus-raft-${i}`,generated:`Report ${i}.`,playback:"unknown" as const}));
  flushSync(()=>s.ui.connection.conversation.state.setState({outputs}));
  const trigger=qualifier(s.host,"generated"); trigger.scrollIntoView(); trigger.focus();
  await expect.poll(()=>document.querySelector('[role="tooltip"]')).not.toBeNull();
  flushSync(()=>s.ui.connection.conversation.state.setState({outputs:[...outputs,{...outputs[0]!,outputId:"focus-tail"}]}));
  expect(document.activeElement).toBe(trigger);
  expect(document.querySelector('[role="tooltip"]')).not.toBeNull();
  await userEvent.keyboard("{Escape}{Tab}");
  await expect.poll(()=>s.host.querySelectorAll("[data-arrival-key]").length).toBe(40);
  expect(trigger.isConnected).toBe(false);
  expect(document.activeElement).not.toBe(document.body);
});
