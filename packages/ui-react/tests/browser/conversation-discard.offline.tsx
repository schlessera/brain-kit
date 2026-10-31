/// <reference types="@vitest/browser-playwright" />
import { transcriptTimelineFor } from "../../src/lib/transcript-timeline.js";
import { afterAll, beforeAll, expect, test, type TestContext } from "vitest";
import { commands, userEvent, page } from "vitest/browser";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { CONVERSATION_LIMITS, type ConversationCapabilities, type ConversationWireEvent, type ServerConversationOpened, type ServerMessage } from "@schlessera/brain-ui-sdk/protocol";
import { createBrainUiRoot } from "../../src/root.js";
import { BrainUiProvider } from "../../src/root-context.js";
import { AppShell } from "../../src/components/layout/app-shell.js";
import { ChatPage } from "../../src/components/chat/chat-page.js";
import { installFaultNetwork } from "./offline/fault-network.js";

const SESSION = "odysseus-ithaca";
const CAPS: ConversationCapabilities = { nonblockingWork: "supported", manualEndpoint: "supported", finalTranscript: "unproven", remoteOutputCancelAck: "unproven", exactPermissionSpeech: "unproven", echoIsolatedInput: "unproven", outputWordAlignment: "unproven" };
const PROFILE: ServerConversationOpened = { type: "conversation_opened", conversationId: "ithaca-voice", epoch: 1, sessionId: SESSION, providerId: "gpt-live", capabilities: CAPS, disclosure: { voiceService: "Odysseus voice fixture", destinations: ["Audio and transcripts: fixture voice API. Retention: unknown."] }, limits: { ...CONVERSATION_LIMITS }, resync: { work: 0, outputs: 0 } };
let styles: HTMLStyleElement;
beforeAll(async () => { styles = document.createElement("style"); styles.textContent = await commands.formConsumerStyles(); document.head.append(styles); });
afterAll(() => styles.remove());

async function scene(ctx: TestContext, width = 390, shell = false, theme: "light" | "dark" = "dark") {
  if (shell) {
    const viewport = { width: innerWidth, height: innerHeight };
    const outer = await commands.formViewport(width, 568);
    await page.viewport(width, 568);
    ctx.onTestFinished(async () => { await page.viewport(viewport.width, viewport.height); await commands.formViewport(outer.width, outer.height); });
  }
  const renderRequests: Array<{ content: string; contentType: string; format: string }> = [];
  const network = installFaultNetwork({ routes: (url, init) => {
    if (url.pathname.endsWith("/render")) {
      renderRequests.push(JSON.parse(String(init.body)));
      // Serialization proof stops at the real request boundary, with no server
      // renderer, download or device share sheet involved.
      return Response.json({ error: "Odysseus export fixture stops after serialization" }, { status: 503 });
    }
    return url.pathname.endsWith("/sessions") ? Response.json({ sessions: [] }) : undefined;
  },
    onOpen(socket) { socket.deliver({ type: "server_hello", conversationProfile: {providerId:PROFILE.providerId,capabilities:PROFILE.capabilities,disclosure:PROFILE.disclosure}, protocolRev: 5, principalKey: "odysseus-principal", capabilities: { askReceipts: true, liveConversation: true, conversationPause: true, toolResolution: true, chatRequestAck: true } }); socket.deliver({ type: "session_info", sessionId: SESSION, isNew: false }); socket.deliver({ type: "session_history", sessionId: SESSION, messages: [] }); socket.deliver({ type: "status", sessionId: SESSION, status: "idle" }); } });
  const ui = createBrainUiRoot({ storage: null, request: network.request });
  ui.stores.chat.getState().setActiveSession(SESSION);
  const host = document.createElement("div"); host.style.cssText = `position:fixed;inset:0;width:${width}px;height:568px`; document.body.append(host);
  const renderer = createRoot(host);
  ui.stores.ui.getState().setTheme(theme);
  flushSync(() => renderer.render(<BrainUiProvider root={ui}>{shell ? <AppShell><ChatPage /></AppShell> : <ChatPage />}</BrainUiProvider>));
  const release = ui.connection.connect();
  ctx.onTestFinished(() => { flushSync(() => renderer.unmount()); release(); ui.dispose(); network.restore(); host.remove(); });
  await expect.poll(() => ui.stores.connection.getState().wsStatus).toBe("connected");
  const socket = network.socket()!;
  const deliver = (message: ServerMessage & { turnId?: string }) => socket.deliver(message);
  const client = ui.connection.conversation;
  const button = (name: string) => [...document.querySelectorAll<HTMLElement>('[role="button"],button')].find((node) => (node.getAttribute("aria-label") ?? node.textContent) === name)!;
  const event = (event: ConversationWireEvent, epoch = client.state.getState().profile!.epoch) => socket.deliver({ type: "conversation_event", conversationId: PROFILE.conversationId, epoch, event });
  let pendingOpen: (()=>void) | undefined, lastOpenedRequest: unknown;
  const opened = (epoch = 1, caps = CAPS) => {
    const deliver = () => { const requestId=socket.frames("conversation_start").at(-1)?.requestId; lastOpenedRequest=requestId;
      socket.deliver({...PROFILE,epoch,capabilities:caps,requestId}); event({kind:"ready",input:{encoding:"pcm16",channels:1,sampleRate:24000},output:{encoding:"pcm16",channels:1,sampleRate:24000}},epoch); };
    const requestId=socket.frames("conversation_start").at(-1)?.requestId;
    if(!requestId || requestId===lastOpenedRequest) {
      // Provider metadata is public before Start; no opened/ready is delivered yet.
      socket.deliver({type:"server_hello",protocolRev:5,principalKey:"odysseus-principal",capabilities:{liveConversation:true,conversationPause:true,askReceipts:true,toolResolution:true,chatRequestAck:true},conversationProfile:{providerId:PROFILE.providerId,capabilities:caps,disclosure:PROFILE.disclosure}});
      pendingOpen=deliver;
    } else deliver();
  };
  const socketSend=socket.send.bind(socket);
  socket.send=(data)=>{socketSend(data);if(typeof data === "string" && JSON.parse(data).type === "conversation_start" && pendingOpen){const deliver=pendingOpen;pendingOpen=undefined;deliver();}};
  const enter = async () => { flushSync(() => client.enter()); opened(); await expect.poll(() => button("Start")).not.toBeUndefined(); };
  const start = async () => { await enter(); await userEvent.click(button("Start")); await expect.poll(() => client.state.getState().micOn).toBe(true); await expect.poll(() => socket.frames("conversation_audio").length, { timeout: 5000 }).toBeGreaterThan(0); };
  const input = (text: string, finalization: "final" | "unknown" | "interim" = "unknown", epoch?: number) => {
    const audio = socket.frames("conversation_audio").at(-1)!;
    event({ kind: "input_fragment", utteranceId: String(audio.utteranceId), sequence: 0, text, finalization, certainty: "unknown", origin: "unknown" }, epoch);
  };
  return { ui, client, host, socket, deliver, network, renderRequests, button, event, opened, enter, start, input };
}

function controlledMicrophone(ctx: TestContext) {
  const context = new AudioContext();
  const oscillator = context.createOscillator();
  const gain = context.createGain(); gain.gain.value = 0.15;
  const destination = context.createMediaStreamDestination();
  oscillator.connect(gain); gain.connect(destination); oscillator.start(); void context.resume();
  const media = navigator.mediaDevices;
  const descriptor = Object.getOwnPropertyDescriptor(media, "getUserMedia");
  let opens = 0;
  const streams: MediaStream[] = [];
  Object.defineProperty(media, "getUserMedia", { configurable: true, writable: true, value: async () => { opens++; const stream = destination.stream.clone(); streams.push(stream); return stream; } });
  ctx.onTestFinished(() => { if (descriptor) Object.defineProperty(media, "getUserMedia", descriptor); else Reflect.deleteProperty(media, "getUserMedia"); oscillator.stop(); streams.forEach(stream => stream.getTracks().forEach(track => track.stop())); void context.close(); });
  return { opens: () => opens, quiet: () => { gain.gain.value = 0; }, speak: () => { gain.gain.value = 0.15; }, stream: destination.stream };
}

// The replay ledger spans the epoch; Discard owns only the current draft.
for (const consumed of ["submitted", "question", "permission", "lost-profile"] as const) test(`Discard retains earlier ${consumed} recognition and rejects retired input replay`, async ctx => {
  const mic = controlledMicrophone(ctx);
  const s = await scene(ctx, 390, true);
  await s.start();
  const first = String(s.socket.frames("conversation_audio").at(-1)!.utteranceId);
  const text = consumed === "permission" ? "brain, stop" : "First retained question.";
  if (consumed === "question") {
    s.deliver({ type: "text_delta", sessionId: SESSION, turnId: "ithaca-turn", text: "Which departure works?" });
    s.deliver({ type: "ask_user_request", sessionId: SESSION, turnId: "ithaca-turn", requestId: "ithaca-question", questions: [{ question: "Which day?", header: "Day", multiSelect: false, options: [{ label: "Tomorrow", description: "Before departure" }] }] });
  }
  if (consumed === "permission") {
    s.deliver({ type: "text_delta", sessionId: SESSION, turnId: "ithaca-turn", text: "Checking the raft plan." });
    s.deliver({ type: "tool_approval_request", sessionId: SESSION, turnId: "ithaca-turn", toolUseId: "ithaca-write", toolName: "Write", kind: "tool", input: { file_path: "notes/raft.md", content: "Repair the raft." }, description: "Review the raft change." });
    s.event({ kind: "input_fragment", utteranceId: first, sequence: 0, text, finalization: "final", certainty: "known", confidence: 0.99, origin: "user" });
    expect(s.socket.frames("tool_denial")).toHaveLength(1);
  } else {
    s.input(text);
    expect(s.client.commit(s.client.state.getState().token)).toBe(true);
    await expect.poll(() => s.socket.frames(consumed === "question" ? "ask_user_response" : "conversation_commit").length).toBe(1);
  }
  const firstEntry = transcriptTimelineFor(s.ui.stores.chat).state.getState().entries.find(e => e.kind === "recognition" && e.fragments.some(f => f.kind === "input_fragment" && f.utteranceId === first))!;
  mic.quiet();
  await expect.poll(() => s.socket.frames("conversation_endpoint").length).toBeGreaterThan(0);
  mic.speak();
  await expect.poll(() => s.socket.frames("conversation_audio").at(-1)?.utteranceId).not.toBe(first);
  const second = String(s.socket.frames("conversation_audio").at(-1)!.utteranceId);
  s.event({ kind: "unassigned_input_fragment", sequence: 0, text: "Independent recognition.", timing: { kind: "unavailable" } });
  s.input("Discard this second draft.");
  await expect.poll(() => s.host.querySelectorAll("[data-recognized-text]").length).toBe(3);
  if (consumed === "lost-profile") {
    s.deliver({ type: "error", code: "CONVERSATION_UNKNOWN", message: "Voice scope is unavailable." });
    expect(s.client.state.getState().profile).toBe(null);
  }
  await userEvent.click(s.button("Discard"));
  expect(s.client.state.getState().recognition.map(f => f.text), "Discard must retain earlier consumed recognition").toEqual([text, "Independent recognition."]);
  await expect.poll(() => [...s.host.querySelectorAll("[data-recognized-text]")].map(n => n.textContent)).toEqual([text, "Independent recognition."]);
  expect(transcriptTimelineFor(s.ui.stores.chat).state.getState().entries.some(e => e.key === firstEntry.key)).toBe(true);
  const late = (utteranceId: string) => s.event({ kind: "input_fragment", utteranceId, sequence: 1, text: "Late retired words.", finalization: "final", certainty: "known", confidence: 0.99, origin: "user" }, 1);
  late(first); late(second);
  expect(s.client.state.getState().text, "Retired input cannot become a new draft").toBe("");
  expect(s.client.state.getState().recognition.map(f => f.text)).toEqual([text, "Independent recognition."]);
  s.client.discard(); // An empty draft must not erase earlier consumed input either.
  expect(s.client.state.getState().recognition.map(f => f.text)).toEqual([text, "Independent recognition."]);
  expect(s.client.state.getState().text).toBe("");
  expect(s.socket.frames("conversation_commit")).toHaveLength(consumed === "submitted" || consumed === "lost-profile" ? 1 : 0);
  expect(s.socket.frames("ask_user_response")).toHaveLength(consumed === "question" ? 1 : 0);
  expect(s.socket.frames("tool_denial")).toHaveLength(consumed === "permission" ? 1 : 0);
  expect(s.socket.frames("tool_approval")).toHaveLength(0);
  expect(s.client.state.getState().micOn).toBe(consumed !== "lost-profile");
});
