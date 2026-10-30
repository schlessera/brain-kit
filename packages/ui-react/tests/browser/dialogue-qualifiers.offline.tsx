/// <reference types="@vitest/browser-playwright" />
import { afterAll, beforeAll, expect, test, vi, type TestContext } from "vitest";
import { commands, page, userEvent } from "vitest/browser";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { createBrainUiRoot } from "../../src/root.js";
import { BrainUiProvider } from "../../src/root-context.js";
import { ChatPage } from "../../src/components/chat/chat-page.js";
import { CONVERSATION_LIMITS, type ServerConversationOpened } from "@schlessera/brain-ui-sdk/protocol";
import type { ConversationRecognition } from "../../src/voice/conversation-client.js";
import { installFaultNetwork } from "./offline/fault-network.js";

const SESSION = "odysseus-raft";
let styles: HTMLStyleElement;
beforeAll(async () => { vi.useFakeTimers({toFake:["Date"]}); vi.setSystemTime(new Date("2026-07-12T12:00:00Z")); styles = document.createElement("style"); styles.textContent = await commands.formConsumerStyles(); document.head.append(styles); });
afterAll(() => {styles.remove();vi.useRealTimers();});

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
  return { ui, host, render, network };
}
function fragments(providerId = "gemini-live", count = 100): ConversationRecognition[] {
  return Array.from({ length: count }, (_, sequence) => ({ kind: "unassigned_input_fragment", conversationId: "odysseus-voice", epoch: 1, sessionId: SESSION, providerId, activation: 1, contextual: true, sequence, timing: { kind: "unavailable" }, text: sequence === 0 ? "Find the raft preparation notes. " : "Keep the launch list within reach. ", finalization: sequence === count - 1 ? "final" : "unknown" }));
}
async function closeDetails() { await userEvent.keyboard("{Escape}"); await expect.poll(() => document.querySelector("dialog[open]")).toBeNull(); }


const profile=(providerId="gpt-live"):ServerConversationOpened=>({type:"conversation_opened",conversationId:"new-voice",epoch:2,sessionId:SESSION,providerId,historyOwnerId:"odysseus-voice",historyGeneration:1,capabilities:{nonblockingWork:"supported",manualEndpoint:"supported",finalTranscript:"unproven",remoteOutputCancelAck:"unproven",exactPermissionSpeech:"unproven",echoIsolatedInput:"unproven",outputWordAlignment:"unproven",contextualTasks:"supported"},disclosure:{voiceService:providerId==="gpt-live"?"Audio goes to GPT-Live.":"Audio goes to Gemini Live.",destinations:[]},limits:{...CONVERSATION_LIMITS},resync:{work:0,outputs:0}});
function retained(sequence:number,text:string,kind:"input"|"output"="input"){
 return {sequence,identity:`record-${sequence}`,evidence:{kind:"voice" as const,conversationId:"odysseus-voice",epoch:1,providerId:"gemini-live",event:kind==="input"?{kind:"unassigned_input_fragment" as const,sequence,text,timing:{kind:"unavailable" as const}}:{kind:"output_transcript" as const,outputId:"retained-reply",sequence,text}}};
}
function evidence(s:Awaited<ReturnType<typeof scene>>){
 flushSync(()=>s.ui.connection.conversation.state.setState({sessionId:SESSION,profile:profile(),dialogue:{[SESSION]:{ownerId:"odysseus-voice",sessionId:SESSION,generation:1,coverage:"partial",through:2,records:[retained(1,"Check the mast lashings. "),retained(2,"The mast lashings were checked.","output")]}},dialogueRestoredThrough:{[SESSION]:2},recognition:[{...fragments("gemini-live",1)[0]!,sequence:3,text:"Also check the sail.",unsaved:true}],outputs:[{conversationId:"odysseus-voice",epoch:1,sessionId:SESSION,providerId:"gemini-live",outputId:"unsaved-reply",generated:"",unsavedGenerated:"The sail still needs review.",unsavedFragments:1,playback:"unknown"}]}));
}
for(const theme of ["light","dark"] as const)for(const width of [320,1280])for(const zoom of [1,2])test(`saved and unsaved evidence reflows with accessible details ${theme} ${width} ${zoom*100}%`,async ctx=>{
 const s=await scene(ctx,width,theme,zoom);evidence(s);
 const column=s.host.querySelector<HTMLElement>("[data-reading-column]")!;
 const qualifiers=[...column.querySelectorAll<HTMLButtonElement>("[data-transcript-qualifiers]")];
 expect(qualifiers).toHaveLength(4);const unsaved=qualifiers.filter(q=>q.getAttribute("aria-label")!.includes("unsaved"));expect(unsaved).toHaveLength(2);
 expect(qualifiers[0]!.getAttribute("aria-label")).toContain("Gemini Live; unverified; restored");
 expect(column.textContent).not.toContain("Original discussion position unknown");
 expect(column.querySelectorAll("[data-conversation-recognition] [aria-live],[data-conversation-output] [aria-live]")).toHaveLength(0);
 expect(column.scrollWidth).toBeLessThanOrEqual(column.clientWidth+1);
 const scroll=column.parentElement!;scroll.scrollTop=0;
 await page.screenshot({element:s.host,path:`../../.vitest-attachments/durable-dialogue/rows-${theme}-${width}-${zoom}.png`});
 scroll.scrollTop=scroll.scrollHeight;
 await page.screenshot({element:s.host,path:`../../.vitest-attachments/durable-dialogue/tail-${theme}-${width}-${zoom}.png`});
 const trigger=unsaved.find(q=>q.dataset.transcriptQualifiers==="recognized")!;trigger.scrollIntoView({block:"center"});await userEvent.hover(trigger);
 await expect.poll(()=>document.querySelector('[role="tooltip"]')?.textContent).toContain("Unsaved text evidence");
 trigger.focus();await userEvent.keyboard("{Enter}");
 const dialog=document.querySelector<HTMLDialogElement>("dialog[open]")!;
 expect(dialog.textContent).toContain("These words are not saved and are unavailable after reload.");
 expect(dialog.textContent).toContain("Words may be uncertain; speaker unverified.");
 expect(dialog.querySelector("details")!.open).toBe(false);expect(dialog.scrollWidth).toBeLessThanOrEqual(dialog.clientWidth+1);
 [...dialog.querySelectorAll("p")].find(p=>p.textContent?.startsWith("Unsaved text evidence"))!.scrollIntoView({block:"center"});
 await page.screenshot({element:dialog,path:`../../.vitest-attachments/durable-dialogue/unsaved-details-${theme}-${width}-${zoom}.png`});
 await closeDetails();expect(document.activeElement).toBe(trigger);
 await userEvent.click(unsaved.find(q=>q.dataset.transcriptQualifiers==="generated")!);expect(document.querySelector("dialog[open]")!.textContent).toContain("Playback unknown");await closeDetails();
});
for(const unsaved of [true,false])for(const kind of ["recognition","speech"] as const)test(`paging and live-tail windowing preserve the ${kind} unsaved=${unsaved} reader until real source removal`,async ctx=>{
 const s=await scene(ctx);evidence(s);
 const voice=s.ui.connection.conversation.state;
 const trigger=[...s.host.querySelectorAll<HTMLButtonElement>(`[data-transcript-qualifiers="${kind==="recognition"?"recognized":"generated"}"]`)].find(q=>q.getAttribute("aria-label")!.includes("unsaved")===unsaved)!;
 const key=trigger.closest<HTMLElement>("[data-arrival-key]")!.dataset.arrivalKey;
 await userEvent.click(trigger);expect(document.querySelector("dialog[open]")).not.toBeNull();
 flushSync(()=>voice.setState(current=>({dialogue:{[SESSION]:{...current.dialogue[SESSION]!,records:[retained(0,"Earlier mast note. "),...current.dialogue[SESSION]!.records]}},recognition:[...current.recognition,{...fragments("gemini-live",1)[0]!,sequence:4,text:" Keep the sail within reach.",unsaved:true}],outputs:[...current.outputs.map(o=>o.unsavedGenerated ? {...o,unsavedGenerated:o.unsavedGenerated+" Keep the rigging clear."} : o),...Array.from({length:41},(_,i)=>({conversationId:"tail",epoch:1,sessionId:SESSION,providerId:"gpt-live",outputId:`tail-${i}`,generated:`Later report ${i}.`,playback:"unknown" as const}))]})));
 expect(trigger.isConnected).toBe(true);expect(trigger.closest<HTMLElement>("[data-arrival-key]")!.dataset.arrivalKey).toBe(key);
 expect(s.host.querySelectorAll("[data-arrival-key]").length).toBeLessThanOrEqual(41);expect(document.querySelector("dialog[open]")).not.toBeNull();await closeDetails();expect(document.activeElement).toBe(trigger);
 const elsewhere=document.createElement("button");elsewhere.textContent="Continue reading";document.body.append(elsewhere);ctx.onTestFinished(()=>elsewhere.remove());elsewhere.focus();await expect.poll(()=>trigger.isConnected).toBe(false);expect(s.host.querySelectorAll("[data-arrival-key]")).toHaveLength(40);
 // Reveal earlier history with the actual existing window control.
 const earlier=[...s.host.querySelectorAll<HTMLElement>('button,[role="button"]')].find(b=>b.textContent?.includes("earlier message"))!;await userEvent.click(earlier);
 const restored=[...s.host.querySelectorAll<HTMLButtonElement>(`[data-transcript-qualifiers="${kind==="recognition"?"recognized":"generated"}"]`)].find(q=>q.getAttribute("aria-label")!.includes("unsaved")===unsaved)!;
 await userEvent.click(restored);const anchor=s.host.querySelector("[data-reading-column]");
 flushSync(()=>voice.setState(current=>unsaved ? kind==="recognition"?{recognition:[]}:{outputs:current.outputs.filter(o=>!o.unsavedGenerated)} : {dialogue:{[SESSION]:{...current.dialogue[SESSION]!,records:current.dialogue[SESSION]!.records.filter(r=>r.evidence.kind!=="voice" || (kind==="recognition" ? r.evidence.event.kind==="output_transcript" : r.evidence.event.kind!=="output_transcript"))}}}));
 await expect.poll(()=>document.querySelector("dialog[open]")).toBeNull();expect(document.activeElement).toBe(anchor);
});
for(const providerId of ["gemini-live","gpt-live"])test(`${providerId} consent discloses durable text without audio or engine receipt`,async ctx=>{
 const s=await scene(ctx,320,"light");s.ui.stores.provider.setState({available:[{id:"athena",label:"Athena",backendId:"local"}],selectedId:"athena",loaded:true});flushSync(()=>s.ui.connection.conversation.state.setState({active:true,sessionId:SESSION,connection:"Connected",profile:profile(providerId),disclosureOpen:true}));
 const dialog=document.querySelector<HTMLDialogElement>("dialog[open]")!;expect(dialog.textContent).toContain("Recognized speech and generated voice replies are saved as text with this chat.");expect(dialog.textContent).toContain("This feature does not save audio.");expect(dialog.textContent).toContain("does not replay audio or prove the voice service received this history");
 const body=dialog.querySelector<HTMLElement>(".bk-overlay-body")!;body.scrollTop=0;
 await page.screenshot({element:dialog,path:`../../.vitest-attachments/durable-dialogue/consent-top-${providerId}.png`});
 [...dialog.querySelectorAll("p")].find(p=>p.textContent?.startsWith("Recognized speech and generated"))!.scrollIntoView({block:"center"});
 await page.screenshot({element:dialog,path:`../../.vitest-attachments/durable-dialogue/consent-retention-${providerId}.png`});
});


test("missing dialogue read purges its page and principal replacement rejects a late requested page",async ctx=>{
 const s=await scene(ctx);const socket=s.network.socket()!;
 socket.deliver({type:"server_hello",protocolRev:5,principalKey:"odysseus",capabilities:{sessionDialogue:true}});
 evidence(s);s.ui.connection.conversation.loadDialogue(SESSION);
 const request=socket.frames("dialogue_read").at(-1)!;
 socket.deliver({type:"error",code:"SESSION_NOT_FOUND",sessionId:SESSION,requestId:request.requestId,message:"This conversation is not available on this host."});
 await expect.poll(()=>s.ui.connection.conversation.state.getState().dialogue[SESSION]).toBeUndefined();
 socket.deliver({type:"dialogue_history",requestId:request.requestId,ownerId:"odysseus-voice",sessionId:SESSION,generation:1,coverage:"legacy",through:0,records:[]});
 expect(s.ui.connection.conversation.state.getState().dialogue[SESSION],"MISSING_READ_CANNOT_REAPPEAR_AS_LEGACY").toBeUndefined();
 s.ui.connection.conversation.loadDialogue(SESSION);const late=socket.frames("dialogue_read").at(-1)!;
 socket.deliver({type:"server_hello",protocolRev:5,principalKey:"penelope",capabilities:{sessionDialogue:true}});
 socket.deliver({type:"dialogue_history",requestId:late.requestId,ownerId:"odysseus-voice",sessionId:SESSION,generation:1,coverage:"complete",through:1,records:[retained(1,"Old principal mast note.")]});
 await expect.poll(()=>s.ui.connection.conversation.state.getState().dialogue).toEqual({});
 expect(s.ui.connection.conversation.state.getState().recognition).toEqual([]);
 expect(s.host.textContent).not.toContain("Old principal mast note.");
 expect(s.host.querySelector("dialog[open]")).toBeNull();
});
