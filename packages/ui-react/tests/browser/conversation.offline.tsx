/// <reference types="@vitest/browser-playwright" />
import { afterAll, beforeAll, expect, test, type TestContext } from "vitest";
import { commands, userEvent, page } from "vitest/browser";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { CONVERSATION_LIMITS, type ConversationCapabilities, type ConversationWireEvent, type ServerConversationOpened, type ServerMessage } from "@schlessera/brain-ui-sdk/protocol";
import { createBrainUiRoot } from "../../src/root.js";
import { BrainUiProvider } from "../../src/root-context.js";
import { AppShell } from "../../src/components/layout/app-shell.js";
import { contrast, parse } from "../../../ui-kit/tests/_contrast.js";
import { ChatPage } from "../../src/components/chat/chat-page.js";
import { createConversationPlayback } from "../../src/voice/conversation-pcm.js";
import { hidePage } from "./offline/fake-microphone.js";
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
    ctx.onTestFinished(async () => { await page.viewport(viewport.width, viewport.height); await commands.formViewport(outer.width - 100, outer.height - 120); });
  }
  const network = installFaultNetwork({ routes: (url) => url.pathname.endsWith("/sessions") ? Response.json({ sessions: [] }) : undefined,
    onOpen(socket) { socket.deliver({ type: "server_hello", conversationProfile: {providerId:PROFILE.providerId,capabilities:PROFILE.capabilities,disclosure:PROFILE.disclosure}, protocolRev: 5, principalKey: "odysseus-principal", capabilities: { askReceipts: true, liveConversation: true, conversationPause: true, toolResolution: true, chatRequestAck: true } }); socket.deliver({ type: "session_info", sessionId: SESSION, isNew: false }); socket.deliver({ type: "session_history", sessionId: SESSION, messages: [] }); socket.deliver({ type: "status", sessionId: SESSION, status: "idle" }); } });
  const ui = createBrainUiRoot({ storage: null, request: network.request });
  ui.stores.chat.getState().setActiveSession(SESSION);
  const host = document.createElement("div"); host.style.cssText = `position:fixed;inset:0;width:${width}px;height:568px`; document.body.append(host);
  const renderer = createRoot(host);
  ui.stores.ui.getState().setTheme(theme);
  flushSync(() => renderer.render(<BrainUiProvider root={ui}>{shell ? <AppShell><ChatPage /></AppShell> : <ChatPage />}</BrainUiProvider>));
  const release = ui.connection.connect();
  let disposed = false;
  const dispose = () => { if (disposed) return; disposed = true; flushSync(() => renderer.unmount()); release(); ui.dispose(); network.restore(); host.remove(); };
  ctx.onTestFinished(dispose);
  await expect.poll(() => ui.stores.connection.getState().wsStatus).toBe("connected");
  const socket = network.socket()!;
  const deliver = (message: ServerMessage & { turnId?: string }) => socket.deliver(message);
  const client = ui.connection.conversation;
  const button = (name: string) => [...document.querySelectorAll<HTMLElement>('[role="button"],button')].find((node) => (node.getAttribute("aria-label") ?? node.textContent) === name)!;
  const event = (event: ConversationWireEvent, epoch = client.state.getState().profile!.epoch) => socket.deliver({ type: "conversation_event", conversationId: PROFILE.conversationId, epoch, event });
  let pendingOpen: (()=>void) | undefined, lastOpenedRequest: unknown;
  const opened = (epoch = 1, caps = CAPS, overrides: Partial<ServerConversationOpened> = {}) => {
    const deliver = () => { const requestId=socket.frames("conversation_start").at(-1)?.requestId; lastOpenedRequest=requestId;
      socket.deliver({...PROFILE,...overrides,epoch,capabilities:caps,requestId}); event({kind:"ready",input:{encoding:"pcm16",channels:1,sampleRate:24000},output:{encoding:"pcm16",channels:1,sampleRate:24000}},epoch); };
    const requestId=socket.frames("conversation_start").at(-1)?.requestId;
    if(!requestId || requestId===lastOpenedRequest) {
      // Provider metadata is public before Start; no opened/ready is delivered yet.
      socket.deliver({type:"server_hello",protocolRev:5,principalKey:"odysseus-principal",capabilities:{liveConversation:true,conversationPause:true,askReceipts:true,toolResolution:true,chatRequestAck:true,...(overrides.historyOwnerId ? {sessionDialogue:true} : {})},conversationProfile:{providerId:PROFILE.providerId,capabilities:caps,disclosure:PROFILE.disclosure}});
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
  return { ui, client, host, socket, deliver, network, button, event, opened, enter, start, input, dispose,
    remountControls() { flushSync(() => renderer.render(<BrainUiProvider root={ui}><ChatPage key="odysseus-remount" /></BrainUiProvider>)); },
    unmountControls() { flushSync(() => renderer.render(null)); },
  };
}

test("capture truth and disclosure: a ready speech session cannot mark an unopened microphone on", async (ctx) => {
  const s = await scene(ctx);
  await s.enter();
  expect(s.client.state.getState().micOn).toBe(false);
  expect(s.socket.frames("conversation_audio")).toHaveLength(0);
  // The Start card (#3698) keeps the former sheet's disclosure behind "What's shared".
  await userEvent.click(document.querySelector<HTMLElement>("[data-start-card] .bk-voice-shared")!);
  expect(document.body.textContent).toContain("Host relay:");
  expect(document.body.textContent).toContain("Independently selected agent backend:");
  await userEvent.click(s.button("Start"));
  await expect.poll(() => s.client.state.getState().micOn).toBe(true);
  await expect.poll(() => s.socket.frames("conversation_audio").length, { timeout: 5000 }).toBeGreaterThan(0);
  expect(document.activeElement?.getAttribute("aria-label")).toBe("Mute");
});

test("commit only: GPT-Live fragments remain NOT SENT while ordinary progress and tools keep streaming", async (ctx) => {
  const s = await scene(ctx);
  await s.start();
  s.input("Find the departure note");
  expect(s.socket.frames("conversation_commit"), "unknown fragments cannot commit themselves").toHaveLength(0);
  await expect.poll(() => s.host.querySelector("[data-conversation-field] .bk-voice-label-meta")?.textContent, { message: "the field says the draft is not sent" }).toBe("Draft · not sent yet");
  s.deliver({ type: "text_delta", sessionId: SESSION, text: "Looking through the voyage notes" });
  s.deliver({ type: "tool_use_start", sessionId: SESSION, toolUseId: "ithaca-search", toolName: "brain_search" });
  s.deliver({ type: "tool_use_complete", sessionId: SESSION, toolUseId: "ithaca-search", toolName: "brain_search", input: { query: "departure" } });
  s.ui.connection.flushChatDeltas();
  await expect.poll(() => s.host.textContent).toContain("Looking through the voyage notes");
  expect(s.ui.stores.chat.getState().buffers[SESSION]?.messages.at(-1)?.toolCalls[0]?.name).toBe("brain_search");
  await userEvent.click(s.button("Send now"));
  expect(s.socket.frames("conversation_commit")).toHaveLength(1);
  expect(s.socket.frames("conversation_commit")[0]?.text).toBe("Find the departure note");
  expect(s.socket.frames("chat_message")).toHaveLength(0);
});

test("late epoch and session change: a stale fragment and submit cannot target the replacement", async (ctx) => {
  const s = await scene(ctx);
  await s.start(); s.input("Ask Nestor about the ships", "final");
  const token = s.client.state.getState().token;
  const audio = s.socket.frames("conversation_audio").at(-1)!;
  flushSync(() => s.ui.stores.chat.getState().setActiveSession("odysseus-harbour"));
  expect(s.client.state.getState().active).toBe(false);
  expect(s.client.state.getState().micOn).toBe(false);
  s.event({ kind: "input_fragment", utteranceId: String(audio.utteranceId), sequence: 1, text: "stale", finalization: "final", certainty: "unknown", origin: "unknown" }, 1);
  expect(s.client.commit(token)).toBe(false);
  expect(s.socket.frames("conversation_commit")).toHaveLength(0);
  const drafts = s.ui.stores.drafts.getState();
  expect(drafts.drafts[drafts.idFor(SESSION)]?.text).toBe("Ask Nestor about the ships");
  expect(drafts.drafts[drafts.idFor("odysseus-harbour")]?.text ?? "").toBe("");
});

function controlledMicrophone(ctx: TestContext, freshStreams = false) {
  const context = new AudioContext();
  const oscillator = context.createOscillator();
  const gain = context.createGain(); gain.gain.value = 0.15;
  const destination = context.createMediaStreamDestination();
  oscillator.connect(gain); gain.connect(destination); oscillator.start(); void context.resume();
  const media = navigator.mediaDevices;
  const descriptor = Object.getOwnPropertyDescriptor(media, "getUserMedia");
  let opens = 0;
  const streams: MediaStream[] = [];
  Object.defineProperty(media, "getUserMedia", { configurable: true, writable: true, value: async () => { opens++; const stream = freshStreams ? destination.stream.clone() : destination.stream; streams.push(stream); return stream; } });
  ctx.onTestFinished(() => { if (descriptor) Object.defineProperty(media, "getUserMedia", descriptor); else Reflect.deleteProperty(media, "getUserMedia"); oscillator.stop(); streams.forEach(stream => stream.getTracks().forEach(track => track.stop())); destination.stream.getTracks().forEach(track => track.stop()); void context.close(); });
  return { streams, opens: () => opens, quiet: () => { gain.gain.value = 0; }, speak: () => { gain.gain.value = 0.15; }, stream: destination.stream };
}

for (const ending of ["leave", "hide", "disconnect"] as const) test(`${ending}: capture suspends synchronously and finalized text stays with its original draft`, async (ctx) => {
  const mic = controlledMicrophone(ctx);
  const s = await scene(ctx); await s.start(); s.input("Remember the harbour meeting", "final");
  let hidden: ReturnType<typeof hidePage> | undefined;
  if (ending === "leave") s.client.leave();
  else if (ending === "hide") hidden = hidePage();
  else s.network.drop();
  if (ending === "disconnect") await expect.poll(() => s.client.state.getState().micOn).toBe(false);
  expect(s.client.state.getState().micOn).toBe(false);
  expect(mic.stream.getAudioTracks().every((track) => track.readyState === "ended")).toBe(true);
  const drafts = s.ui.stores.drafts.getState();
  expect(drafts.drafts[drafts.idFor(SESSION)]?.text).toBe("Remember the harbour meeting");
  hidden?.show();
  expect(s.client.state.getState().micOn).toBe(false);
});

test("hold: 700 ms silence and 500 ms hold require fresh final evidence; speech cancels the hold", async (ctx) => {
  const mic = controlledMicrophone(ctx);
  const s = await scene(ctx); await s.enter();
  // This fixture deliberately supplies stronger evidence than either built-in
  // service. It proves scheduling, not provider recognition or echo isolation.
  s.opened(1, { ...CAPS, finalTranscript: "supported" });
  await userEvent.click(s.button("Start"));
  await expect.poll(() => s.socket.frames("conversation_audio").length).toBeGreaterThan(0);
  mic.quiet();
  await expect.poll(() => s.socket.frames("conversation_endpoint").length).toBe(1);
  const id = String(s.socket.frames("conversation_audio").at(-1)!.utteranceId);
  s.event({ kind: "input_fragment", utteranceId: id, sequence: 0, text: "Find the voyage note", finalization: "final", certainty: "known", confidence: 0.99, origin: "user" });
  await expect.poll(() => s.client.state.getState().interaction).toBe("Sending soon");
  mic.speak();
  await expect.poll(() => s.socket.frames("conversation_audio").at(-1)?.utteranceId).not.toBe(id);
  expect(s.socket.frames("conversation_commit")).toHaveLength(0);
  mic.quiet();
  await expect.poll(() => s.socket.frames("conversation_endpoint").length).toBe(2);
  const second = String(s.socket.frames("conversation_audio").at(-1)!.utteranceId);
  s.event({ kind: "input_fragment", utteranceId: second, sequence: 0, text: " before departure", finalization: "unknown", certainty: "unknown", origin: "unknown" });
  await expect.poll(() => s.client.state.getState().interaction).toBe("Review before sending");
  expect(s.socket.frames("conversation_commit")).toHaveLength(0);
});

test("barge-in flush: Stop reply discards every queued PCM chunk without revoking microphone intent", async (ctx) => {
  const descriptor = Object.getOwnPropertyDescriptor(BaseAudioContext.prototype, "createBufferSource")!;
  const original = descriptor.value as BaseAudioContext["createBufferSource"];
  const ended: boolean[] = [];
  Object.defineProperty(BaseAudioContext.prototype, "createBufferSource", { ...descriptor, value: function(this: BaseAudioContext) {
    const node = original.call(this); const index = ended.push(false) - 1;
    node.addEventListener("ended", () => { ended[index] = true; });
    return node;
  } });
  ctx.onTestFinished(() => { Object.defineProperty(BaseAudioContext.prototype, "createBufferSource", descriptor); });
  const s = await scene(ctx); await s.start(); s.client.mute();
  const bytes = new Uint8Array(48_000); const view = new DataView(bytes.buffer);
  for (let i = 0; i < bytes.length / 2; i++) view.setInt16(i * 2, Math.sin(i * 2 * Math.PI * 440 / 24000) * 6000, true);
  let binary = ""; for (const byte of bytes) binary += String.fromCharCode(byte);
  s.event({ kind: "output_transcript", outputId: "ithaca-reply", sequence: 0, text: "The note is ready." });
  for (let sequence = 0; sequence < 3; sequence++) s.event({ kind: "audio", outputId: "ithaca-reply", sequence, format: { encoding: "pcm16", sampleRate: 24000, channels: 1 }, pcm: btoa(binary) });
  await expect.poll(() => s.client.state.getState().playing).toBe(true);
  await userEvent.click(s.button("Interrupt"));
  expect(s.client.state.getState().playing).toBe(false);
  expect(ended).toHaveLength(3);
  await expect.poll(() => ended.every(Boolean), { timeout: 500, message: "every real scheduled audio source ended at the cut, including future chunks" }).toBe(true);
  expect(s.client.state.getState().micOn).toBe(false);
  expect(s.client.state.getState().outputRecovery).toBe("checking");
  expect(s.socket.frames("conversation_stop")).toHaveLength(0);
  expect(s.socket.frames("conversation_playback").at(-1)?.playback).toBe("unknown");
  expect(s.client.state.getState().outputs[0]?.playback).toBe("unknown");
  s.event({ kind: "audio", outputId: "late-reply", sequence: 0, format: { encoding: "pcm16", sampleRate: 24000, channels: 1 }, pcm: btoa(binary) });
  expect(s.client.state.getState().playing).toBe(false);
  expect(s.client.commit(s.client.state.getState().token)).toBe(false);
  await expect.poll(() => s.host.textContent).toContain("spoken portion unknown");
});

// #3356 ruling A (docs/decisions/answer-delivery.md, "A question whose turn
// ended"): an unanswered card whose turn ends stays the editable question
// under an ended prompt, so a draft survives; the "no longer waiting" note
// appears only once the user dismisses it. Voice must still stop treating it
// as the question being answered.
test("terminal: an unanswered card ends without tool_result and voice stops answering it", async (ctx) => {
  const s = await scene(ctx); await s.start(); s.client.mute();
  s.deliver({ type: "text_delta", sessionId: SESSION, turnId: "ithaca-turn", text: "Checking the route" });
  s.deliver({ type: "ask_user_request", sessionId: SESSION, turnId: "ithaca-turn", requestId: "ithaca-question", questions: [{ question: "Which day?", header: "Day", multiSelect: false, options: [{ label: "Tomorrow", description: "Before departure" }] }] });
  await expect.poll(() => s.host.querySelector('[data-ask-waiting]')).not.toBe(null);
  await expect.poll(() => s.client.state.getState().interaction).toBe("Answering question");
  s.deliver({ type: "result", sessionId: SESSION, turnId: "ithaca-turn", isError: false, durationMs: 100, numTurns: 1 });
  await expect.poll(() => s.host.querySelector('[data-ask-waiting]')).toBe(null);
  await expect.poll(() => s.host.querySelector('[data-ask-ended]')?.textContent ?? "").toContain("The turn ended before you answered");
  await expect.poll(() => s.client.state.getState().interaction).not.toBe("Answering question");
  expect(s.ui.stores.chat.getState().buffers[SESSION]?.askUser).toMatchObject({ terminal: true, cancelled: true });
  await userEvent.click(s.button("Dismiss"));
  await expect.poll(() => s.host.textContent).toContain("no longer waiting · the turn ended");
  expect(s.host.querySelector('[data-ask-ended]')).toBe(null);
  expect(s.socket.frames("ask_user_response")).toHaveLength(0);
  expect(s.socket.frames("ask_user_cancel")).toHaveLength(0);
});

test("epoch guard: stale transcript and an old Send callback cannot consume a new epoch's review candidate", async (ctx) => {
  const s = await scene(ctx); await s.start(); s.input("Old departure note");
  const oldToken = s.client.state.getState().token;
  const oldId = String(s.socket.frames("conversation_audio").at(-1)!.utteranceId);
  s.client.mute();
  s.socket.deliver({ type: "conversation_closed", conversationId: PROFILE.conversationId, epoch: 1, reason: "stopped" });
  s.opened(2);
  expect(s.client.state.getState().micOn).toBe(false);
  expect(s.client.state.getState().disclosureOpen).toBe(false);
  s.client.resume();
  await expect.poll(() => s.socket.frames("conversation_audio").at(-1)?.epoch).toBe(2);
  s.input("New harbour note");
  s.event({ kind: "input_fragment", utteranceId: oldId, sequence: 1, text: " stale", finalization: "final", certainty: "unknown", origin: "unknown" }, 1);
  expect(s.client.state.getState().text).toBe("New harbour note");
  expect(s.client.commit(oldToken)).toBe(false);
  expect(s.socket.frames("conversation_commit")).toHaveLength(0);
  expect(s.client.commit(s.client.state.getState().token)).toBe(true);
  expect(s.socket.frames("conversation_commit")[0]?.epoch).toBe(2);
});

test("single-question binding: a reviewed voice answer uses the existing answer queue while chat keeps working", async (ctx) => {
  const s = await scene(ctx); await s.start();
  s.deliver({ type: "text_delta", sessionId: SESSION, turnId: "ithaca-turn", text: "Which departure works?" });
  s.deliver({ type: "ask_user_request", sessionId: SESSION, turnId: "ithaca-turn", requestId: "ithaca-question", questions: [{ question: "Which day?", header: "Day", multiSelect: false, options: [{ label: "Tomorrow", description: "Before departure" }] }] });
  s.input("Tomorrow before departure");
  await expect.poll(() => s.button("Send now")).not.toBeUndefined();
  await userEvent.click(s.button("Send now"));
  await expect.poll(() => s.socket.frames("ask_user_response").length).toBe(1);
  expect(s.socket.frames("conversation_commit")).toHaveLength(0);
  expect(s.socket.frames("ask_user_response")[0]?.answers).toEqual({ "Which day?": "Tomorrow before departure" });
  expect(s.socket.frames("ask_user_response")[0]?.turnId).toBe("ithaca-turn");
  expect(s.client.state.getState().micOn).toBe(true);
});

for (const theme of ["dark", "light"] as const) for (const width of [320, 1280]) test(`layout ${theme} ${width}: the voice strip preserves transcript space, 44px targets and 4.5:1 text`, async (ctx) => {
  const s = await scene(ctx, width, true, theme);
  await s.start(); s.input("Add the departure note before the harbour meeting", "final");
  s.ui.stores.followUp.getState().addLocal(SESSION, { requestId: "ithaca-pending", text: "Check the harbour fees", source: "voice-conversation", queuedAt: Date.now() });
  s.deliver({ type: "text_delta", sessionId: SESSION, text: "The harbour work continues while you speak." });
  await expect.poll(() => s.host.querySelector('[data-conversation-review]')).not.toBe(null);
  const strip = s.host.querySelector<HTMLElement>('[data-conversation-field]')!;
  const area = [...s.host.querySelectorAll<HTMLElement>('div')].find((element) => element.classList.contains("@container"))!;
  expect(area.getBoundingClientRect().height, "the actual scrolling transcript keeps at least 264 pixels at 320 × 568").toBeGreaterThanOrEqual(264);
  expect(strip.scrollWidth).toBeLessThanOrEqual(strip.clientWidth);
  for (const target of strip.querySelectorAll<HTMLElement>('[role="button"],button')) {
    const rect = target.getBoundingClientRect();
    expect(rect.height, target.textContent ?? "control").toBeGreaterThanOrEqual(44);
    expect(rect.width, target.textContent ?? "control").toBeGreaterThanOrEqual(44);
    expect(rect.right).toBeLessThanOrEqual(strip.getBoundingClientRect().right + 0.5);
  }
  await page.screenshot({ element: s.host, path: `../../.vitest-attachments/conversation/${theme}-${width}.png` });
  for (const leaf of strip.querySelectorAll<HTMLElement>('div,span')) {
    if (leaf.closest('.sr-only') || ![...leaf.childNodes].some((node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim())) continue;
    let element: HTMLElement | null = leaf;
    let background = parse(getComputedStyle(strip).backgroundColor);
    while (element) {
      const candidate = parse(getComputedStyle(element).backgroundColor);
      if (candidate.alpha >= 0.99) { background = candidate; break; }
      element = element.parentElement;
    }
    const foreground = parse(getComputedStyle(leaf).color);
    const rgb = foreground.rgb.map((value, index) => value * foreground.alpha + background.rgb[index]! * (1 - foreground.alpha)) as [number, number, number];
    expect(contrast(rgb, background.rgb), leaf.textContent ?? "strip text").toBeGreaterThanOrEqual(4.5);
  }
});

test("a refused voice commit arriving after Leave returns once to its original draft", async (ctx) => {
  const s = await scene(ctx);
  const draft = s.ui.stores.drafts.getState().idFor(SESSION);
  s.ui.stores.drafts.getState().edit(draft, SESSION, { text: "Typed route question" });
  await s.start(); s.input("Find the harbour note");
  expect(s.client.commit(s.client.state.getState().token)).toBe(true);
  const commit = s.socket.frames("conversation_commit")[0]!;
  s.client.leave();
  flushSync(() => s.ui.stores.chat.getState().setActiveSession("odysseus-harbour"));
  const receipt: ServerMessage = { type: "conversation_work", conversationId: PROFILE.conversationId, epoch: 1, utteranceId: String(commit.utteranceId), requestId: String(commit.requestId), sessionId: SESSION, state: "refused", delivery: "discarded", recognized: "Find the harbour note", submitted: "Find the harbour note", reason: "The queue is full." };
  s.deliver(receipt); s.deliver(receipt);
  const drafts = s.ui.stores.drafts.getState();
  expect(drafts.drafts[drafts.idFor(SESSION)]?.text, "an unaccepted send cannot erase its recognized text or the pre-existing typed draft").toBe("Typed route question\n\nFind the harbour note");
  expect(drafts.drafts[drafts.idFor("odysseus-harbour")]?.text ?? "").toBe("");
});

test("busy session: one pending voice pill becomes exactly one YOU message, and the existing question stays interactive", async (ctx) => {
  const s = await scene(ctx); await s.start();
  s.deliver({ type: "text_delta", sessionId: SESSION, turnId: "ithaca-first", text: "Searching the harbour notes" });
  s.input("Also check the departure time");
  expect(s.client.commit(s.client.state.getState().token)).toBe(true);
  const commit = s.socket.frames("conversation_commit")[0]!;
  expect(s.ui.stores.followUp.getState().pending[SESSION]).toHaveLength(1);
  expect(s.ui.stores.chat.getState().buffers[SESSION]?.messages.filter((message) => message.role === "user" && message.requestId === commit.requestId)).toHaveLength(0);
  s.deliver({ type: "ask_user_request", sessionId: SESSION, turnId: "ithaca-first", requestId: "ithaca-live-question", questions: [{ question: "Which day?", header: "Day", multiSelect: false, options: [{ label: "Tomorrow", description: "Before departure" }] }] });
  await expect.poll(() => s.host.querySelector('[role="radio"]')).not.toBe(null);
  await userEvent.click(s.host.querySelector<HTMLElement>('[role="radio"]')!);
  await expect.poll(() => s.button("Submit")).not.toBeUndefined();
  await userEvent.click(s.button("Submit"));
  await expect.poll(() => s.socket.frames("ask_user_response").length).toBe(1);
  s.deliver({ type: "text_delta", sessionId: SESSION, turnId: "ithaca-first", text: ". The agent is still working." });
  s.ui.connection.flushChatDeltas();
  await expect.poll(() => s.host.textContent).toContain("The agent is still working");
  s.deliver({ type: "result", sessionId: SESSION, turnId: "ithaca-first", isError: false, durationMs: 1, numTurns: 1 });
  const started: ServerMessage & { turnId: string } = { type: "session_info", sessionId: SESSION, turnId: "ithaca-follow", requestId: String(commit.requestId), isNew: false };
  s.deliver(started); s.deliver(started);
  expect(s.ui.stores.followUp.getState().pending[SESSION] ?? []).toHaveLength(0);
  expect(s.ui.stores.chat.getState().buffers[SESSION]?.messages.filter((message) => message.role === "user" && message.requestId === commit.requestId)).toHaveLength(1);
  expect(s.socket.frames("conversation_commit")).toHaveLength(1);
  expect(s.socket.frames("chat_message")).toHaveLength(0);
  expect(s.client.state.getState().micOn).toBe(true);
});

const cardCases: (ServerMessage & { turnId: string; requestId: string })[] = [
  { type: "ask_user_request", sessionId: SESSION, turnId: "ithaca-card", requestId: "ithaca-multi", questions: ["Which day?", "Which harbour?"].map((question) => ({ question, header: "Voyage", multiSelect: false, options: [{ label: "Tomorrow", description: "Before departure" }] })) },
  { type: "ask_user_list_request", sessionId: SESSION, turnId: "ithaca-card", requestId: "ithaca-list", prompt: "Review the supplies", scale: [{ label: "Ready" }, { label: "Missing" }], items: [{ id: "rope", label: "Rope" }], allowSkip: false, notes: false },
  { type: "ask_user_rank_request", sessionId: SESSION, turnId: "ithaca-card", requestId: "ithaca-rank", prompt: "Order the supplies", items: [{ id: "rope", label: "Rope" }, { id: "timber", label: "Timber" }] },
  { type: "ask_user_form_request", sessionId: SESSION, turnId: "ithaca-card", requestId: "ithaca-form", prompt: "Plan the departure", nodes: [{ kind: "text", id: "day", prompt: "Which day?" }] },
];
for (const card of cardCases) test(`${card.requestId}: speech remains an ordinary message and preserves the card's own controls`, async (ctx) => {
  const s = await scene(ctx); await s.start();
  s.deliver({ type: "text_delta", sessionId: SESSION, turnId: "ithaca-card", text: "Review the voyage choices" });
  s.deliver(card);
  await expect.poll(() => s.host.querySelector('[data-ask-waiting]')).not.toBe(null);
  s.input("Tomorrow before departure");
  expect(s.client.commit(s.client.state.getState().token)).toBe(true);
  expect(s.socket.frames("conversation_commit")).toHaveLength(1);
  for (const type of ["ask_user_response", "ask_user_list_response", "ask_user_rank_response", "ask_user_form_response"]) expect(s.socket.frames(type)).toHaveLength(0);
  expect(s.host.querySelector('[data-ask-waiting]')).not.toBe(null);
});

for (const late of [false, true]) test(`hold finalized=${!late}: fresh trustworthy final commits once; a final after the 2s deadline stays reviewable`, async (ctx) => {
  const mic = controlledMicrophone(ctx);
  const s = await scene(ctx); await s.enter();
  s.opened(1, { ...CAPS, finalTranscript: "supported" });
  await userEvent.click(s.button("Start"));
  await expect.poll(() => s.socket.frames("conversation_audio").length).toBeGreaterThan(0);
  mic.quiet();
  await expect.poll(() => s.socket.frames("conversation_endpoint").length).toBe(1);
  const endpointAt = performance.now();
  if (late) await expect.poll(() => performance.now() - endpointAt, { timeout: 3000 }).toBeGreaterThan(2100);
  const id = String(s.socket.frames("conversation_audio").at(-1)!.utteranceId);
  s.event({ kind: "input_fragment", utteranceId: id, sequence: 0, text: "Find the departure note", finalization: "final", certainty: "known", confidence: 0.99, origin: "user" });
  if (late) {
    await expect.poll(() => performance.now() - endpointAt, { timeout: 3500 }).toBeGreaterThan(2750);
    expect(s.socket.frames("conversation_commit")).toHaveLength(0);
    expect(s.client.state.getState().interaction).toBe("Review before sending");
  } else {
    await expect.poll(() => s.socket.frames("conversation_commit").length).toBe(1);
    expect(s.socket.frames("conversation_commit")[0]?.text).toBe("Find the departure note");
  }
});

test("quiet-boundary delivery waits during capture, drains once, and host terminal alone cannot finish playback", async (ctx) => {
  const mic = controlledMicrophone(ctx);
  const s = await scene(ctx); await s.start();
  const audio: ConversationWireEvent = { kind: "audio", outputId: "ithaca-quiet", sequence: 0, pcm: outputPcm(0.5), format: { encoding: "pcm16", channels: 1, sampleRate: 24000 } };
  s.deliver({ type: "text_delta", sessionId: SESSION, turnId: "ithaca-quiet-turn", text: "The note is ready" });
  s.event(audio);
  expect(s.client.state.getState().playing).toBe(false);
  s.deliver({ type: "result", sessionId: SESSION, turnId: "ithaca-quiet-turn", durationMs: 1, numTurns: 1, isError: false });
  expect(s.client.state.getState().interaction).toBe("Working");
  s.client.mute(); mic.quiet();
  await expect.poll(() => s.client.state.getState().playing).toBe(true);
  await expect.poll(() => s.socket.frames("conversation_playback").filter((frame) => frame.playback === "played").length).toBe(1);
  await expect.poll(() => s.client.state.getState().interaction).toBe("Listening");
  s.client.leave();
  s.event({ ...audio, outputId: "ithaca-background" });
  expect(s.client.state.getState().playing).toBe(false);
  expect(s.socket.frames("conversation_playback")).toHaveLength(1);
});

function outputPcm(seconds = 1, audibleSeconds = seconds) {
  const bytes = new Uint8Array(Math.round(48000 * seconds));
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < Math.min(bytes.length / 2, audibleSeconds * 24000); i++) view.setInt16(i * 2, Math.sin(i * 2 * Math.PI * 440 / 24000) * 6000, true);
  let binary = ""; for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

for (const tail of [false, true]) test(`${tail ? "silent tail" : "silence-only"}: transport PCM does not turn user speech into a stop`, async (ctx) => {
  const mic = controlledMicrophone(ctx);
  const s = await scene(ctx); await s.start(); mic.quiet();
  await expect.poll(() => s.socket.frames("conversation_endpoint").length).toBe(1);
  s.event({ kind: "audio", outputId: "ithaca-silence", sequence: 0, pcm: outputPcm(1, tail ? 0.2 : 0), format: { encoding: "pcm16", channels: 1, sampleRate: 24000 } });
  if (tail) await expect.poll(() => s.client.state.getState().playing).toBe(true);
  await expect.poll(() => s.client.state.getState().playing, { timeout: 600 }).toBe(false);
  // The real source still has PCM queued; draining the source is not the
  // same thing as reaching the end of potentially audible samples.
  expect(s.socket.frames("conversation_playback")).toHaveLength(0);
  const before = s.socket.frames("conversation_audio").length;
  mic.speak();
  await expect.poll(() => s.socket.frames("conversation_audio").length).toBeGreaterThan(before);
  expect(s.client.state.getState().micOn).toBe(true);
  expect(s.socket.frames("conversation_stop")).toHaveLength(0);
  expect(s.client.state.getState().interaction).not.toBe("Checking whether the reply stopped");
});

// GPT-Live has one output identity for the entire epoch, including later
// replies (the adapter's audio/output_transcript handlers), not one per turn.
for (const trigger of ["silence-only", "silent tail", "permission earcon"] as const) test(`${trigger}: later GPT-Live replies reuse the epoch output ID after a local flush`, async (ctx) => {
  const mic = controlledMicrophone(ctx);
  const s = await scene(ctx); await s.start();
  const outputId = `output-${PROFILE.epoch}`;
  let sequence = 0;
  const audio = (pcm: string) => s.event({ kind: "audio", outputId, sequence: sequence++, pcm, format: { encoding: "pcm16", channels: 1, sampleRate: 24000 } });
  if (trigger === "permission earcon") {
    // Waiting provider transport is flushed by the once-only local tone.
    audio(outputPcm(1, 0));
    approval(s, "ithaca-stream-announcement");
    mic.quiet();
    await expect.poll(() => s.client.permissions.state.getState().records[0]?.announced).toBe(true);
  } else {
    mic.quiet();
    await expect.poll(() => s.socket.frames("conversation_endpoint").length).toBe(1);
    audio(outputPcm(1, trigger === "silent tail" ? 0.2 : 0));
    if (trigger === "silent tail") await expect.poll(() => s.client.state.getState().playing).toBe(true);
    await expect.poll(() => s.client.state.getState().playing, { timeout: 600 }).toBe(false);
    const before = s.socket.frames("conversation_audio").length;
    mic.speak();
    await expect.poll(() => s.socket.frames("conversation_audio").length).toBeGreaterThan(before);
    mic.quiet();
    await expect.poll(() => s.socket.frames("conversation_endpoint").length).toBe(2);
  }
  // Repeated replies and input turns must survive without Resume/new epoch.
  for (let turn = 0; turn < 2; turn++) {
    s.event({ kind: "output_transcript", outputId, sequence: sequence++, text: "The departure note is ready." });
    const played = s.socket.frames("conversation_playback").filter(frame => frame.outputId === outputId && frame.playback === "played").length;
    audio(outputPcm(0.3));
    await expect.poll(() => s.client.state.getState().playing).toBe(true);
    await expect.poll(() => s.socket.frames("conversation_playback").filter(frame => frame.outputId === outputId && frame.playback === "played").length).toBe(played + 1);
    const before = s.socket.frames("conversation_audio").length;
    const endpoints = s.socket.frames("conversation_endpoint").length;
    mic.speak();
    await expect.poll(() => s.socket.frames("conversation_audio").length).toBeGreaterThan(before);
    mic.quiet();
    await expect.poll(() => s.socket.frames("conversation_endpoint").length).toBe(endpoints + 1);
  }
  expect(s.client.state.getState().micOn).toBe(true);
  expect(s.socket.frames("conversation_stop")).toHaveLength(0);
  expect(s.socket.frames("conversation_start")).toHaveLength(1);
});

for (const receipt of ["output", "work"] as const) test(`Start before ready waits visibly, then opens capture after the last ${receipt} resync receipt`, async (ctx) => {
  controlledMicrophone(ctx);
  const s = await scene(ctx);
  s.client.enter();
  await expect.poll(() => s.button("Start")).not.toBeUndefined();
  await userEvent.click(s.button("Start"));
  s.socket.deliver({ ...PROFILE, resync: { work: receipt === "work" ? 1 : 0, outputs: receipt === "output" ? 1 : 0 }, requestId: s.socket.frames("conversation_start").at(-1)?.requestId });
  expect(s.client.state.getState().micOn).toBe(false);
  expect(s.client.state.getState().notice).toContain("Waiting for voice readiness");
  s.event({ kind: "ready", input: { encoding: "pcm16", channels: 1, sampleRate: 24000 }, output: { encoding: "pcm16", channels: 1, sampleRate: 24000 } });
  expect(s.client.state.getState().notice).toContain("Synchronizing voice");
  if (receipt === "output") s.deliver({ type: "conversation_output", conversationId: PROFILE.conversationId, epoch: 1, outputId: "ithaca-old", generated: "Earlier reply", playback: "unknown" });
  else s.deliver({ type: "conversation_work", conversationId: PROFILE.conversationId, epoch: 1, utteranceId: "ithaca-old-input", requestId: "ithaca-old-work", state: "completed", delivery: "returned", recognized: "Find the departure note", submitted: "Find the departure note" });
  await expect.poll(() => s.client.state.getState().micOn).toBe(true);
  expect(s.client.state.getState().notice).toBe("");
});

test("barge-in from actual PCM speech cuts output and retains capture and initiating PCM", async (ctx) => {
  const mic = controlledMicrophone(ctx);
  const s = await scene(ctx); await s.start(); mic.quiet();
  await expect.poll(() => s.socket.frames("conversation_endpoint").length).toBe(1);
  s.event({ kind: "audio", outputId: "ithaca-barge", sequence: 0, pcm: outputPcm(), format: { encoding: "pcm16", channels: 1, sampleRate: 24000 } });
  await expect.poll(() => s.client.state.getState().playing).toBe(true);
  const before = s.socket.frames("conversation_audio").length;
  mic.speak();
  await expect.poll(() => s.client.state.getState().playing).toBe(false);
  expect(s.client.state.getState().micOn, "INTERRUPTION_RETAINS_CAPTURE").toBe(true);
  await expect.poll(() => s.socket.frames("conversation_audio").length).toBeGreaterThan(before);
  expect(s.socket.frames("conversation_stop")).toHaveLength(0);
  expect(s.socket.frames("conversation_commit")).toHaveLength(0);
});

test("one tracker activation leaves voice and preserves the original draft without a dialog", async (ctx) => {
  const s = await scene(ctx, 390, true); await s.start();
  s.deliver({ type: "status", sessionId: "odysseus-timber", status: "thinking", turnId: "timber-turn" });
  await expect.poll(() => s.host.querySelector('[data-strip-summary]')).not.toBe(null);
  await userEvent.click(s.host.querySelector<HTMLElement>('[data-strip-summary]')!);
  await expect.poll(() => document.querySelector('[data-working-sheet] [role="button"]')).not.toBe(null);
  s.input("Save the departure note", "final");
  await userEvent.click(document.querySelector<HTMLElement>('[data-working-sheet] [role="button"]')!);
  await expect.poll(() => s.ui.stores.chat.getState().activeSessionId).toBe("odysseus-timber");
  expect(s.client.state.getState().active).toBe(false);
  expect(s.client.state.getState().micOn).toBe(false);
  const drafts = s.ui.stores.drafts.getState();
  expect(drafts.drafts[drafts.idFor(SESSION)]?.text).toBe("Save the departure note");
  expect(document.querySelector('[role="dialog"]')).toBe(null);
});

test("abandoned opening is closed before replacement; late opening cannot reactivate capture", async (ctx) => {
  const s = await scene(ctx);
  s.client.enter(); s.client.start();
  const old = String(s.socket.frames("conversation_start")[0]?.requestId);
  s.client.leave(); s.client.enter(); s.client.start(); s.client.mute();
  expect(s.socket.frames("conversation_start")).toHaveLength(1);
  s.socket.deliver({ ...PROFILE, requestId: old });
  await expect.poll(() => s.socket.frames("conversation_start").length).toBe(2);
  expect(s.client.state.getState().micOn).toBe(false);
  expect(s.socket.frames("conversation_stop").at(-1)?.conversationId).toBe(PROFILE.conversationId);
  s.opened();
  expect(s.client.state.getState().disclosureOpen).toBe(false);
  expect(s.client.state.getState().micOn).toBe(false);
});

test("a voice-first session binds its original typed draft and generated output, not the next new-chat draft", async (ctx) => {
  const s = await scene(ctx);
  flushSync(() => s.ui.stores.chat.getState().setActiveSession(null));
  const drafts = s.ui.stores.drafts.getState();
  const original = drafts.idFor(null);
  drafts.edit(original, null, { text: "Typed departure question" });
  await s.start(); s.input("Find the harbour note");
  expect(s.client.commit(s.client.state.getState().token)).toBe(true);
  const commit = s.socket.frames("conversation_commit")[0]!;
  s.event({ kind: "output_transcript", outputId: "ithaca-new-output", sequence: 0, text: "The note is ready" });
  s.deliver({ type: "session_info", sessionId: "odysseus-new-voyage", requestId: String(commit.requestId), isNew: true, turnId: "ithaca-new-turn" });
  expect(s.client.state.getState().sessionId).toBe("odysseus-new-voyage");
  expect(s.client.state.getState().outputs.at(-1)?.sessionId).toBe("odysseus-new-voyage");
  expect(s.ui.stores.drafts.getState().drafts[s.ui.stores.drafts.getState().resolveId(original)]).toMatchObject({ sessionId: "odysseus-new-voyage", text: "Typed departure question" });
  s.client.leave();
  flushSync(() => s.ui.stores.chat.getState().setActiveSession(null));
  s.ui.stores.drafts.getState().newChat();
  const next = s.ui.stores.drafts.getState().idFor(null);
  s.ui.stores.drafts.getState().edit(next, null, { text: "New raft question" });
  const previousOpening=s.socket.frames("conversation_start").at(-1)!;
  s.client.enter();
  expect(s.socket.frames("conversation_start").at(-1)!.requestId,"NEW_DRAFT_ENTRY_WAITS_FOR_START").toBe(previousOpening.requestId);
  s.client.start();
  const replacementOpening=s.socket.frames("conversation_start").at(-1)!;
  expect(replacementOpening.requestId,"REPLACEMENT_HAS_ITS_OWN_EXPLICIT_OPENING").not.toBe(previousOpening.requestId);
  s.deliver({ ...PROFILE, sessionId:undefined, conversationId: "ithaca-replacement", requestId: replacementOpening.requestId as string });
  expect(s.client.state.getState().profile?.conversationId,"NEW_DRAFT_IDENTITY_TEST_HAS_AN_ACTUAL_ACCEPTED_REPLACEMENT").toBe("ithaca-replacement");
  s.deliver({ type: "session_info", sessionId: "odysseus-new-voyage", requestId: String(commit.requestId), isNew: true, turnId: "ithaca-new-turn" });
  expect(s.client.state.getState().sessionId).toBe(null);
  expect(s.ui.stores.drafts.getState().drafts[next]?.text).toBe("New raft question");
});

function approval(s: Awaited<ReturnType<typeof scene>>, toolUseId: string, sessionId = SESSION, turnId = "ithaca-permission") {
  s.deliver({ type: "tool_approval_request", sessionId, turnId, toolUseId, toolName: "Write", kind: "tool", input: { file_path: "voyage/raft.md", content: "Private command payload stays on screen" }, description: "Unvetted words must never become approved speech" });
}
function recognition(s: Awaited<ReturnType<typeof scene>>, text: string, origin: "user" | "assistant" | "unknown" = "user", confidence = 0.99) {
  s.event({ kind: "input_fragment", utteranceId: String(s.socket.frames("conversation_audio").at(-1)!.utteranceId), sequence: 0, text, finalization: "final", certainty: "known", confidence, origin });
}

test("voice refusal: isolated original input sends a scoped denial, locks only its card and awaits the host", async (ctx) => {
  const s = await scene(ctx); await s.start();
  s.deliver({ type: "text_delta", sessionId: SESSION, turnId: "ithaca-permission", text: "Checking the raft plan" });
  approval(s, "ithaca-write");
  recognition(s, "brain, stop");
  expect(s.socket.frames("tool_denial"), "a trusted scoped refusal must reach the existing host denial channel").toHaveLength(1);
  expect(s.socket.frames("tool_denial")[0]).toMatchObject({ toolUseId: "ithaca-write", turnId: "ithaca-permission", channel: "voice" });
  expect(s.socket.frames("tool_approval")).toHaveLength(0);
  expect(s.socket.frames("conversation_commit")).toHaveLength(0);
  await expect.poll(() => s.host.textContent).toContain("Refusal sent · checking");
  expect(s.ui.stores.chat.getState().buffers[SESSION]?.messages.flatMap(m => m.toolCalls).find(t => t.id === "ithaca-write")?.status, "dispatch is not host-confirmed denial").toBe("pending_approval");
  s.deliver({ type: "text_delta", sessionId: SESSION, turnId: "ithaca-permission", text: ". Other async work continues." });
  s.ui.connection.flushChatDeltas();
  await expect.poll(() => s.host.textContent).toContain("Other async work continues");
  s.deliver({ type: "tool_resolution", sessionId: SESSION, turnId: "ithaca-permission", toolUseId: "ithaca-write", outcome: "denied", channel: "voice" });
  await expect.poll(() => s.host.textContent).toContain("Denied · by voice");
});

test("ambiguous refusal snapshots current-turn approvals only; duplicate input and later arrivals cannot widen it", async (ctx) => {
  const s = await scene(ctx); await s.start();
  s.deliver({ type: "text_delta", sessionId: SESSION, turnId: "ithaca-permission", text: "Review the voyage" });
  approval(s, "ithaca-one"); approval(s, "ithaca-two"); approval(s, "harbour-other", "odysseus-harbour", "harbour-turn");
  recognition(s, "brain st", "user", 0.2);
  expect(s.socket.frames("tool_denial"), "the refusal snapshots every current-turn approval and excludes background sessions").toHaveLength(2);
  expect(s.socket.frames("tool_denial").map((frame) => frame.toolUseId)).toEqual(["ithaca-one", "ithaca-two"]);
  approval(s, "ithaca-later"); recognition(s, "brain st", "user", 0.2);
  expect(s.socket.frames("tool_denial")).toHaveLength(2);
  for (const toolUseId of ["ithaca-one", "ithaca-two"]) s.deliver({ type: "tool_resolution", sessionId: SESSION, turnId: "ithaca-permission", toolUseId, outcome: "denied", channel: "voice" });
  await expect.poll(() => s.host.textContent).toContain("heard unclearly · taken as refusal");
});

test("affirmatives, bare stop and unproven acoustic origin can never decide permissions", async (ctx) => {
  const s = await scene(ctx); await s.start(); approval(s, "ithaca-safe");
  for (const text of ["yes", "approve", "go ahead", "brain allow", "always allow", "stop", "no", "cancel"]) recognition(s, text);
  recognition(s, "brain, stop", "assistant"); recognition(s, "brain, stop", "unknown");
  expect(s.socket.frames("tool_denial")).toHaveLength(0);
  expect(s.socket.frames("tool_approval")).toHaveLength(0);
  expect(s.client.state.getState().text).toBe("brain, stop");
});

test("outside a refusal window the phrase stays ordinary review text", async (ctx) => {
  const s = await scene(ctx); await s.start(); recognition(s, "brain, stop");
  expect(s.socket.frames("tool_denial")).toHaveLength(0);
  expect(s.client.state.getState().text).toBe("brain, stop");
});

test("permission fallback: one native earcon waits for quiet, never reads payload, and user refusal works during it", async (ctx) => {
  const mic = controlledMicrophone(ctx);
  const descriptor = Object.getOwnPropertyDescriptor(BaseAudioContext.prototype, "createBufferSource")!;
  const original = descriptor.value as BaseAudioContext["createBufferSource"];
  const live: AudioBufferSourceNode[] = [];
  Object.defineProperty(BaseAudioContext.prototype, "createBufferSource", { ...descriptor, value: function(this: BaseAudioContext) { const source = original.call(this); live.push(source); return source; } });
  ctx.onTestFinished(() => { Object.defineProperty(BaseAudioContext.prototype, "createBufferSource", descriptor); });
  const s = await scene(ctx); await s.start();
  approval(s, "ithaca-announcement"); approval(s, "ithaca-announcement");
  expect(live).toHaveLength(0);
  mic.quiet();
  await expect.poll(() => live.length).toBe(1);
  const receipt = s.client.permissions.state.getState().records[0]!;
  expect(receipt.announced).toBe(true);
  approval(s, "ithaca-announcement");
  expect(live, "a pending duplicate after its earcon never announces twice").toHaveLength(1);
  expect(receipt.script).not.toMatch(/raft\.md|Private command|Unvetted/);
  let ended = false; live[0]!.addEventListener("ended", () => { ended = true; });
  expect(ended).toBe(false);
  const beforeSpeech = s.socket.frames("conversation_audio").length;
  mic.speak();
  await expect.poll(() => s.socket.frames("conversation_audio").length > beforeSpeech || !s.client.state.getState().micOn).toBe(true);
  expect(s.client.state.getState().micOn, "speaking over the permission earcon keeps the recognizer capture open").toBe(true);
  recognition(s, "brain, stop", "assistant");
  expect(s.socket.frames("tool_denial")).toHaveLength(0);
  recognition(s, "brain, stop", "user");
  expect(s.socket.frames("tool_denial")).toHaveLength(1);
  expect(s.client.state.getState().micOn).toBe(true);
  approval(s, "ithaca-announcement");
  s.client.mute();
  expect(live).toHaveLength(1);
  expect(s.socket.frames("conversation_commit")).toHaveLength(0);
});

test("a resolved queued announcement is dropped; terminal expiry without tool_result makes controls inert", async (ctx) => {
  const s = await scene(ctx); await s.start(); approval(s, "ithaca-expiry");
  const receipt = () => s.client.permissions.state.getState().records.find(r => r.toolUseId === "ithaca-expiry")!;
  expect(receipt().announced).toBe(false);
  s.deliver({ type: "result", sessionId: SESSION, turnId: "ithaca-permission", durationMs: 1, numTurns: 1, isError: false });
  expect(receipt().phase).toBe("expired");
  s.client.mute();
  expect(receipt().announced).toBe(false);
  expect(s.socket.frames("tool_denial")).toHaveLength(0);
  await expect.poll(() => s.host.textContent).toContain("Expired · denied");
  expect(s.host.querySelector('[data-approval-card]')).toBe(null);
});

test("a visual grant winning a voice-refusal race reports the host grant instead of an invented denial", async (ctx) => {
  const s = await scene(ctx); await s.start(); approval(s, "ithaca-race");
  recognition(s, "brain, stop");
  s.deliver({ type: "tool_resolution", sessionId: SESSION, turnId: "ithaca-permission", toolUseId: "ithaca-race", outcome: "granted", channel: "card" });
  const receipt = s.client.permissions.state.getState().records[0]!;
  expect(receipt.phase).toBe("granted");
  expect(receipt.byVoice).toBe(false);
  await expect.poll(() => s.host.textContent).toContain("The screen decision was already accepted.");
  expect(s.host.textContent).not.toContain("Denied · by voice");
  // The receipt owns the confirmed decision; the ordinary tool result still
  // owns transcript status and restored-card recovery.
  expect(s.host.querySelector('[data-approval-card]')).toBe(null);
});

test("a disconnect after refusal keeps the outcome unknown and never resends the old denial", async (ctx) => {
  const s = await scene(ctx); await s.start(); approval(s, "ithaca-disconnect"); recognition(s, "brain, stop");
  s.network.drop({ announce: true });
  await expect.poll(() => s.client.state.getState().micOn).toBe(false);
  expect(s.client.permissions.state.getState().records[0]?.phase).toBe("unknown");
  await expect.poll(() => s.host.textContent).toContain("Couldn't confirm the refusal");
  s.network.recover(); s.ui.connection.reconnectNow();
  await expect.poll(() => s.network.socket() !== s.socket && s.ui.stores.connection.getState().wsStatus === "connected").toBe(true);
  expect(s.network.sockets.flatMap(socket => socket.frames("tool_denial"))).toHaveLength(1);
  s.network.socket()!.deliver({ type: "tool_resolution", sessionId: SESSION, turnId: "ithaca-permission", toolUseId: "ithaca-disconnect", outcome: "denied", channel: "voice" });
  await expect.poll(() => s.host.textContent).toContain("Denied · by voice");
  expect(s.client.state.getState().micOn).toBe(false);
});

test("already-denied voice posture yields one outcome receipt and no card or refusal window", async (ctx) => {
  const s = await scene(ctx); await s.start();
  const outcome: ServerMessage & { turnId: string } = { type: "tool_resolution", sessionId: SESSION, turnId: "ithaca-posture", toolUseId: "ithaca-posture", outcome: "denied", reason: "voice_posture" };
  s.deliver(outcome); s.deliver(outcome);
  await expect.poll(() => s.host.querySelectorAll('[data-voice-posture-outcome]').length).toBe(1);
  expect(s.host.textContent).toContain("denied by voice posture · no card");
  expect(s.host.querySelector('[data-approval-card]')).toBe(null);
  expect(s.host.querySelector('[data-voice-refusal-window]')).toBe(null);
  recognition(s, "brain, stop");
  expect(s.socket.frames("tool_denial")).toHaveLength(0);
  expect(s.client.state.getState().text).toBe("brain, stop");
});

for (const theme of ["dark", "light"] as const) test(`permission layout ${theme} 320: review and refusal retain 264px transcript and 44px controls`, async (ctx) => {
  const s = await scene(ctx, 320, true, theme); await s.start(); approval(s, "ithaca-layout");
  recognition(s, "Review the departure note");
  await expect.poll(() => s.host.querySelector('[data-voice-refusal-window]')).not.toBe(null);
  const strip = s.host.querySelector<HTMLElement>('[data-conversation-field]')!;
  const area = [...s.host.querySelectorAll<HTMLElement>('div')].find(element => element.classList.contains("@container"))!;
  expect(area.getBoundingClientRect().height).toBeGreaterThanOrEqual(264);
  for (const target of strip.querySelectorAll<HTMLElement>('[role="button"],button')) expect(target.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
  expect(strip.scrollWidth).toBeLessThanOrEqual(strip.clientWidth);
  await page.screenshot({ element: s.host, path: `../../.vitest-attachments/conversation/${theme}-320-permission.png` });
});

test("scheduled audible output stays pending during leading silence and becomes speaking on the audio clock", async (ctx) => {
  const reports: string[] = [];
  const playback = createConversationPlayback((id) => reports.push(id), () => {});
  ctx.onTestFinished(() => playback.dispose());
  playback.quiet(true);
  playback.enqueue("ithaca-leading-silence", new Uint8Array(24000), { encoding: "pcm16", channels: 1, sampleRate: 24000 });
  playback.enqueue("ithaca-future-tone", Uint8Array.from(atob(outputPcm()), c => c.charCodeAt(0)), { encoding: "pcm16", channels: 1, sampleRate: 24000 });
  expect(playback.pending()).toBe(true);
  expect(playback.playingIds()).toEqual([]);
  await expect.poll(() => playback.playingIds()).toEqual(["ithaca-future-tone"]);
  expect(reports).toEqual(["ithaca-leading-silence"]);
  playback.cut();
  expect(playback.pending()).toBe(false);
  expect(playback.playingIds()).toEqual([]);
});

test("cancellation cut retires both live and waiting identities even after the quiet gate reopens", async (ctx) => {
  const reports: { id: string; state: string }[] = [];
  const playback = createConversationPlayback((id, state) => reports.push({ id, state }), () => {});
  ctx.onTestFinished(() => playback.dispose());
  const format = { encoding: "pcm16", channels: 1, sampleRate: 24000 } as const;
  const pcm = Uint8Array.from(atob(outputPcm()), c => c.charCodeAt(0));
  playback.quiet(true);
  playback.enqueue("output-1", pcm, format);
  await expect.poll(() => playback.playing()).toBe(true);
  playback.quiet(false);
  playback.enqueue("ithaca-waiting", pcm, format);
  playback.cut();
  expect(reports).toEqual([{ id: "output-1", state: "unknown" }, { id: "ithaca-waiting", state: "discarded" }]);
  playback.quiet(true);
  playback.enqueue("output-1", pcm, format);
  playback.enqueue("ithaca-waiting", pcm, format);
  expect(playback.pending(), "late cancelled chunks cannot restart even with an open quiet gate").toBe(false);
  expect(playback.playing()).toBe(false);
  expect(reports).toHaveLength(2);
});

test("replacement epoch rejects old PCM but plays the new epoch output identity", async (ctx) => {
  controlledMicrophone(ctx);
  const s = await scene(ctx); await s.start();
  s.client.mute();
  s.client.mute(); s.deliver({ type: "conversation_closed", conversationId: PROFILE.conversationId, epoch: 1, reason: "stopped" }); s.client.resume(); s.opened(2);
  await expect.poll(() => s.client.state.getState().micOn).toBe(true);
  s.client.mute();
  const audio = (epoch: number) => s.event({ kind: "audio", outputId: `output-${epoch}`, sequence: 0, pcm: outputPcm(0.3), format: { encoding: "pcm16", channels: 1, sampleRate: 24000 } }, epoch);
  audio(1);
  expect(s.client.state.getState().playing).toBe(false);
  audio(2);
  await expect.poll(() => s.client.state.getState().playing).toBe(true);
  await expect.poll(() => s.socket.frames("conversation_playback").filter(frame => frame.outputId === "output-2" && frame.playback === "played").length).toBe(1);
  expect(s.socket.frames("conversation_playback").some(frame => frame.outputId === "output-1")).toBe(false);
});

test("speech before a scheduled audible reply cancels the queued sources without closing capture", async (ctx) => {
  const mic = controlledMicrophone(ctx);
  const s = await scene(ctx); await s.start(); mic.quiet();
  await expect.poll(() => s.socket.frames("conversation_endpoint").length).toBe(1);
  s.event({ kind: "audio", outputId: "ithaca-leading", sequence: 0, pcm: outputPcm(1, 0), format: { encoding: "pcm16", channels: 1, sampleRate: 24000 } });
  s.event({ kind: "audio", outputId: "ithaca-future", sequence: 0, pcm: outputPcm(), format: { encoding: "pcm16", channels: 1, sampleRate: 24000 } });
  const before = s.socket.frames("conversation_audio").length;
  mic.speak();
  await expect.poll(() => s.socket.frames("conversation_audio").length).toBeGreaterThan(before);
  expect(s.client.state.getState().micOn).toBe(true);
  expect(s.socket.frames("conversation_stop")).toHaveLength(0);
  expect(s.socket.frames("conversation_playback").map(frame => frame.outputId)).toEqual(["ithaca-leading", "ithaca-future"]);
  expect(s.client.state.getState().playing).toBe(false);
});

test("microphone permission denial is visible and a late ready cannot undo explicit mute", async (ctx) => {
  const media = navigator.mediaDevices;
  const descriptor = Object.getOwnPropertyDescriptor(media, "getUserMedia");
  let calls = 0;
  Object.defineProperty(media, "getUserMedia", { configurable: true, writable: true, value: async () => { calls++; throw new DOMException("Fixture permission refusal", "NotAllowedError"); } });
  ctx.onTestFinished(() => { if (descriptor) Object.defineProperty(media, "getUserMedia", descriptor); else Reflect.deleteProperty(media, "getUserMedia"); });
  const s = await scene(ctx); await s.enter();
  await userEvent.click(s.button("Start"));
  await expect.poll(() => s.client.state.getState().notice).toContain("Microphone is blocked");
  expect(s.client.state.getState().micOn).toBe(false);
  await expect.poll(() => s.host.textContent).toContain("Microphone is blocked. Allow it in this site’s browser settings, then Start again.");
  expect(s.host.querySelector<HTMLElement>("[data-conversation-field]")?.dataset.liveState, "a blocked microphone stops the conversation (L9)").toBe("L9");
  expect(s.button("Start again"), "the copy names the action L9 offers").not.toBeUndefined();
  s.client.mute();
  s.event({ kind: "ready", input: { encoding: "pcm16", channels: 1, sampleRate: 24000 }, output: { encoding: "pcm16", channels: 1, sampleRate: 24000 } });
  expect(calls).toBe(1);
  expect(s.client.state.getState().notice).toContain("Microphone muted");
});

test("mute while awaiting readiness withdraws Start consent", async (ctx) => {
  const s = await scene(ctx); s.client.enter(); s.client.start();
  s.socket.deliver({ ...PROFILE, requestId: s.socket.frames("conversation_start").at(-1)?.requestId });
  s.client.start(); s.client.mute();
  s.event({ kind: "ready", input: { encoding: "pcm16", channels: 1, sampleRate: 24000 }, output: { encoding: "pcm16", channels: 1, sampleRate: 24000 } });
  // Wait for a real audio scheduling boundary; an erroneously opened capture
  // would have completed by then, even with a silent fake microphone.
  const clock = new AudioContext(); const source = clock.createBufferSource();
  source.buffer = clock.createBuffer(1, 12000, 24000); source.connect(clock.destination);
  await clock.resume();
  await new Promise<void>(resolve => { source.onended = () => resolve(); source.start(); });
  await clock.close();
  expect(s.client.state.getState().micOn).toBe(false);
  expect(s.socket.frames("conversation_audio")).toHaveLength(0);
});

test("Resume before a replacement disclosure cannot authorize a changed voice service", async (ctx) => {
  const mic = controlledMicrophone(ctx);
  const s = await scene(ctx); await s.start();
  expect(mic.opens()).toBe(1);
  s.client.mute();
  s.deliver({ type: "conversation_closed", conversationId: PROFILE.conversationId, epoch: 1, reason: "stopped" });
  s.client.resume();
  s.socket.deliver({ ...PROFILE, epoch: 2, disclosure: { voiceService: "Changed Odysseus voice fixture", destinations: ["Changed fixture destination. Retention: unknown."] }, requestId: s.socket.frames("conversation_start").at(-1)?.requestId });
  s.event({ kind: "ready", input: { encoding: "pcm16", channels: 1, sampleRate: 24000 }, output: { encoding: "pcm16", channels: 1, sampleRate: 24000 } }, 2);
  expect(s.client.state.getState().disclosureOpen).toBe(true);
  expect(s.client.state.getState().micOn).toBe(false);
  expect(mic.opens()).toBe(1);
  expect(mic.stream.getAudioTracks().every(track => track.readyState === "ended")).toBe(true);
});

test("reconnect and its ready event restore consented capture automatically", async (ctx) => {
  const mic = controlledMicrophone(ctx, true);
  const s = await scene(ctx); await s.start();
  s.network.drop({ announce: true });
  await expect.poll(() => s.client.state.getState().micOn).toBe(false);
  s.network.recover(); s.ui.connection.reconnectNow();
  await expect.poll(() => s.network.socket() !== s.socket && s.ui.stores.connection.getState().wsStatus === "connected").toBe(true);
  const replacement = s.network.socket()!;
  await expect.poll(() => replacement.frames("conversation_start").length).toBe(1);
  replacement.deliver({ ...PROFILE, epoch: 2, requestId: replacement.frames("conversation_start").at(-1)?.requestId });
  replacement.deliver({ type: "conversation_event", conversationId: PROFILE.conversationId, epoch: 2, event: { kind: "ready", input: { encoding: "pcm16", channels: 1, sampleRate: 24000 }, output: { encoding: "pcm16", channels: 1, sampleRate: 24000 } } });
  await expect.poll(() => s.client.state.getState().micOn).toBe(true);
  expect(mic.opens()).toBe(2);
});

for (const reason of ["stopped", "replaced"] as const) test(`Resume before the old epoch's ${reason} receipt keeps the replacement opening and mic consent`, async (ctx) => {
  const mic = controlledMicrophone(ctx);
  const s = await scene(ctx); await s.start();
  const previousRequest = s.socket.frames("conversation_start")[0]?.requestId;
  s.client.mute(); s.deliver({ type: "conversation_closed", conversationId: PROFILE.conversationId, epoch: 1, reason: "stopped" }); s.client.resume();
  expect(s.socket.frames("conversation_start")).toHaveLength(2);
  s.deliver({ type: "conversation_closed", conversationId: PROFILE.conversationId, epoch: 1, requestId: String(previousRequest), reason });
  s.opened(2);
  expect(mic.opens()).toBe(2);
  await expect.poll(() => s.client.state.getState().micOn).toBe(true);
  expect(s.client.state.getState().profile?.epoch).toBe(2);
});

test("ordinary working, speaking and reply-drained state changes keep the microphone open", async (ctx) => {
  const mic = controlledMicrophone(ctx);
  const s = await scene(ctx); await s.start(); mic.quiet();
  await expect.poll(() => s.socket.frames("conversation_endpoint").length).toBe(1);
  s.deliver({ type: "status", sessionId: SESSION, status: "thinking", turnId: "ithaca-speaking-turn" });
  s.event({ kind: "output_transcript", outputId: "ithaca-drained", sequence: 0, text: "The departure note is ready." });
  s.event({ kind: "audio", outputId: "ithaca-drained", sequence: 0, pcm: outputPcm(0.2), format: { encoding: "pcm16", channels: 1, sampleRate: 24000 } });
  await expect.poll(() => s.client.state.getState().interaction).toBe("Speaking");
  expect(s.client.state.getState().micOn).toBe(true);
  s.deliver({ type: "result", sessionId: SESSION, turnId: "ithaca-speaking-turn", durationMs: 100, numTurns: 1, isError: false });
  await expect.poll(() => s.socket.frames("conversation_playback").at(-1)?.playback).toBe("played");
  expect(s.client.state.getState().micOn).toBe(true);
  expect(mic.opens()).toBe(1);
  expect(s.socket.frames("conversation_stop")).toHaveLength(0);
});


// Shared keyless adapter/host fixture from #3049; diagnostic changes stay there.
/** Feed real client microphone/endpoint/commit frames through a native host and
 * GPT-Live adapter. Only the provider connection is replaced, by loopback WS. */
async function adapterScene(ctx: TestContext, width = 390) {
  const mic = controlledMicrophone(ctx);
  const s = await scene(ctx, width, true);
  const fixture = await commands.conversationServer({ op: "start" }) as { id: string };
  ctx.onTestFinished(async () => { await commands.conversationServer({ op: "stop", id: fixture.id }); });
  let cursor = 0;
  const upstream: Record<string, unknown>[] = [];
  const downstream: ServerMessage[] = [];
  const pump = async (provider: unknown[] = []) => {
    const client = s.socket.sent.slice(cursor).map(bytes => JSON.parse(String(bytes.data)));
    cursor = s.socket.sent.length;
    const result = await commands.conversationServer({ op: "step", id: fixture.id, client, provider }) as { frames: ServerMessage[]; sent: Record<string, unknown>[] };
    upstream.push(...result.sent); downstream.push(...result.frames);
    for (const frame of result.frames) s.deliver(frame);
  };
  await pump(); s.client.enter(); s.client.start();
  await pump();
  await expect.poll(async () => { await pump(); return s.client.state.getState().profile; }).not.toBe(null);
  await expect.poll(() => s.client.state.getState().micOn).toBe(true);
  await expect.poll(() => s.socket.frames("conversation_audio").length).toBeGreaterThan(0);
  await pump();
  return { ...s, mic, pump, upstream, downstream };
}

for (const width of [390, 320]) test(`missing-ID conversation stays live and review never sends (${width})`, async ctx => {
  const s = await adapterScene(ctx, width);
  const draft = s.ui.stores.drafts.getState();
  const id = draft.idFor(SESSION);
  draft.edit(id, SESSION, { text: "Existing typed note." });
  s.ui.stores.voice.getState().setReviewText("Existing voice review.");
  const parts = ["Find", " the departure", " note."];
  for (let turn = 0; turn < 3; turn++) {
    if (turn) {
      const before = s.socket.frames("conversation_audio").length;
      s.mic.speak();
      await expect.poll(() => s.socket.frames("conversation_audio").length).toBeGreaterThan(before);
      await s.pump();
    }
    s.mic.quiet();
    await expect.poll(() => s.socket.frames("conversation_endpoint").length).toBe(turn + 1);
    await s.pump([{ type: "session.input_transcript.delta", event_id: `missing-${turn}`, delta: parts[turn], start_ms: [600, 10200, 19000][turn], end_ms: [1800, 10400, 19600][turn] },
      { type: "session.delegation.created", event_id: `native-${turn}`, offset_ms: turn * 10000, delegation: { id: `native-${turn}`, type: "delegation", target: "client" } }]);
    expect(s.client.state.getState().micOn, "missing IDs must not close capture").toBe(true);
    await expect.poll(() => s.client.state.getState().unassigned.length + (s.client.state.getState().text ? 1 : 0)).toBe(turn + 1);
    expect(s.socket.frames("conversation_commit")).toHaveLength(0);
    if (s.client.state.getState().unassigned.length) expect(s.client.commit(s.client.state.getState().token), "unassigned text cannot fabricate a correlated commit").toBe(false);
    await s.pump([{ type: "session.output_audio.delta", delta: outputPcm(0.15) }]);
    await expect.poll(() => s.client.state.getState().playing).toBe(true);
    await expect.poll(async () => { await s.pump(); return s.client.state.getState().playing; }).toBe(false);
    expect(s.client.state.getState().micOn).toBe(true);
  }
  expect(s.socket.frames("conversation_start")).toHaveLength(1);
  expect(s.downstream.some(f => f.type === "conversation_closed")).toBe(false);
  expect(s.upstream.some(f => f.type === "session.commentary.append" || f.type === "session.thinking.append")).toBe(false);
  expect(s.client.state.getState().text).toBe("");
  expect(s.client.state.getState().unassignedWork).toBe(3);
  const outputs = s.downstream.flatMap(f => f.type === "conversation_event" && f.event.kind === "audio" ? [f.event.outputId] : []);
  expect(new Set(outputs)).toEqual(new Set(["output-1"]));
  // The review is an inline notice and action now, visible without a toggle (#3253).
  expect(s.host.querySelector('[aria-label="Voice review controls"] summary')).toBeNull();
  expect(s.host.querySelector('[aria-label="Voice review controls"]')!.textContent).toContain("3 voice fragments weren't sent.");
  await expect.poll(() => [...s.host.querySelectorAll("[data-recognized-text]")].map(n => n.textContent).join("")).toBe(parts.join(""));
  expect(s.client.state.getState().unassigned.map(f => f.sessionInterval?.startMs)).toEqual([600, 10200, 19000]);
  await page.screenshot({ element: s.host, path: `../../.vitest-attachments/conversation/unassigned-${width}.png` });
  expect(s.host.scrollWidth).toBeLessThanOrEqual(width);
  expect(s.host.querySelector('[aria-label="Voice review controls"]')!.getBoundingClientRect().bottom).toBeLessThanOrEqual(s.host.getBoundingClientRect().bottom + 1);
  await userEvent.click(s.button("Review in composer"));
  expect(s.client.state.getState().active).toBe(false);
  expect(s.client.state.getState().micOn).toBe(false);
  expect(s.client.reviewUnassigned(), "the transfer cannot append twice").toBe(false);
  // Reviewed in the composer (#3694, D6): voice text joins the draft, after what was typed, once.
  await expect.poll(() => s.ui.stores.drafts.getState().drafts[id]?.text).toBe("Existing typed note. Existing voice review. Find the departure note.");
  expect(s.ui.stores.voice.getState().reviewText).toBe("");
  expect(s.socket.frames("conversation_commit")).toHaveLength(0);
  expect(s.socket.frames("chat_message")).toHaveLength(0);
  await expect.poll(() => s.button("Send")).not.toBeUndefined();
  await userEvent.click(s.button("Send"));
  const sent = s.socket.frames("chat_message");
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({ source: "voice-dictate", text: "Existing typed note. Existing voice review. Find the departure note." });
  expect(sent[0]).not.toHaveProperty("utteranceId");
});

test("unassigned recognition never denies, auto-commits, or migrates into a different chat", async ctx => {
  const s = await scene(ctx); await s.start(); approval(s, "unassigned-refusal");
  const fragment: ConversationWireEvent = { kind: "unassigned_input_fragment", sequence: 0, text: "brain, stop", sessionInterval: { startMs: 600, endMs: 1800 } };
  s.event(fragment); s.event(fragment);
  expect(s.client.state.getState().unassigned).toHaveLength(1);
  expect(s.socket.frames("tool_denial")).toHaveLength(0);
  expect(s.client.commit(s.client.state.getState().token)).toBe(false);
  s.event({ ...fragment, sequence: 1, text: " stale" }, 0);
  expect(s.client.state.getState().unassigned).toHaveLength(1);
  s.deliver({ type: "conversation_closed", conversationId: PROFILE.conversationId, epoch: 1, reason: "provider_closed", message: "The voice service closed." });
  expect(s.client.state.getState().unassigned).toHaveLength(1);
  s.client.resume(); s.opened(2);
  await expect.poll(() => s.client.state.getState().micOn).toBe(true);
  s.event({ ...fragment, sequence: 0, text: " later", sessionInterval: { startMs: 500, endMs: 700 } }, 2);
  expect(s.client.state.getState().unassigned.map(f => f.epoch)).toEqual([1, 2]);
  flushSync(() => s.ui.stores.chat.getState().setActiveSession("odysseus-harbour"));
  expect(s.client.reviewUnassigned()).toBe(false);
  expect(s.ui.stores.voice.getState().reviewText).toBe("");
  expect(s.client.state.getState().unassigned).toHaveLength(2);
});

test("unassigned review preserves captured and typed drafts exactly once", async ctx => {
  const s = await scene(ctx); await s.start();
  const drafts = s.ui.stores.drafts.getState(); const id = drafts.idFor(SESSION);
  drafts.edit(id, SESSION, { text: "Typed note." });
  s.input("Captured note.");
  s.event({ kind: "unassigned_input_fragment", sequence: 0, text: "Unassigned note.", sessionInterval: { startMs: 10200, endMs: 10400 } });
  expect(s.client.reviewUnassigned()).toBe(true);
  expect(s.ui.stores.drafts.getState().drafts[id]?.text).toBe("Typed note.\n\nCaptured note.");
  expect(s.ui.stores.voice.getState().reviewText).toBe("Unassigned note.");
  expect(s.client.reviewUnassigned()).toBe(false);
  expect(s.ui.stores.drafts.getState().drafts[id]?.text).toBe("Typed note.\n\nCaptured note.");
  expect(s.socket.frames("chat_message")).toHaveLength(0);
  expect(s.socket.frames("conversation_commit")).toHaveLength(0);
});

async function mixedReviewScene(ctx: TestContext) {
  controlledMicrophone(ctx);
  const s = await scene(ctx, 320, true);
  // Keep actual earlier contextual evidence, then negotiate reviewed mode in a
  // replacement entry. No state-only fragments or ownership are fabricated.
  s.opened(1, { ...CAPS, contextualTasks: "supported" });
  s.client.enter(); s.client.start();
  await expect.poll(() => s.client.state.getState().micOn).toBe(true);
  await expect.poll(() => s.socket.frames("conversation_audio").length).toBeGreaterThan(0);
  s.event({ kind: "unassigned_input_fragment", sequence: 0, text: "Odysseus discusses the harbour. ", timing: { kind: "unavailable" }, finalization: "final" });
  s.input("Keep the mast in sight.", "final");
  const context = s.client.state.getState().unassigned;
  const recognition = s.client.state.getState().recognition;
  expect(context).toHaveLength(2);
  expect(context.every(f => f.taskContext)).toBe(true);
  s.client.leave();
  s.opened(2); s.client.enter(); s.client.start();
  await expect.poll(() => s.client.state.getState().micOn).toBe(true);
  return { ...s, context, contextualRecognition: recognition };
}

for (const afterLeave of [false, true]) test(`mixed review transfers only genuine candidates once${afterLeave ? " after Leave" : ""} and keeps unknown-work reporting`, async ctx => {
  const s = await mixedReviewScene(ctx);
  const drafts = s.ui.stores.drafts.getState(), id = drafts.idFor(SESSION);
  drafts.edit(id, SESSION, { text: "Keep the typed raft draft." });
  s.ui.stores.voice.getState().setReviewText("Existing voice review.");
  s.event({ kind: "unassigned_input_fragment", sequence: 0, text: "Review the launch note.", timing: { kind: "unavailable" } });
  s.event({ kind: "unassigned_delegation", handle: "watch-unassociated-work", offsetMs: 500 });
  if (afterLeave) s.client.leave();
  await expect.poll(() => s.host.querySelector('[aria-label="Voice review controls"]')?.textContent).toContain("1 voice fragment wasn't sent.");
  expect(s.host.scrollWidth).toBeLessThanOrEqual(320);
  expect(s.client.reviewUnassigned(), "MIXED_REVIEW_TRANSFERS_REAL_CANDIDATES").toBe(true);
  await expect.poll(() => s.ui.stores.drafts.getState().drafts[id]?.text, { message: "CONTEXT_NEVER_ENTERS_MIXED_COMPOSER_REVIEW" }).toBe("Keep the typed raft draft. Existing voice review. Review the launch note.");
  expect(s.client.state.getState().unassigned).toEqual(s.context);
  expect(s.client.state.getState().recognition.filter(f => f.contextual), "contextual transcript is never marked moved").toEqual(s.contextualRecognition);
  expect(s.client.state.getState().recognition.filter(f => !f.contextual)).toMatchObject([{ text: "", moved: true }]);
  expect(s.client.state.getState().unassignedWork, "TEXT_REVIEW_DOES_NOT_RESOLVE_UNKNOWN_WORK").toBe(1);
  await expect.poll(() => s.host.querySelector('[aria-label="Voice review controls"]')?.textContent).toContain("Voice requested agent work without an input association.");
  expect(s.host.querySelector('[aria-label="Voice review controls"]')?.textContent).toContain("No request was submitted or linked to running work.");
  expect(s.host.querySelector('[aria-label="Voice review controls"]')?.textContent).not.toContain("fragment wasn't sent");
  expect(s.client.reviewUnassigned()).toBe(false);
  expect(s.ui.stores.drafts.getState().drafts[id]?.text).toBe("Keep the typed raft draft. Existing voice review. Review the launch note.");
  expect(s.client.state.getState().active).toBe(false);
  expect(s.socket.frames("conversation_commit")).toHaveLength(0);
  expect(s.socket.frames("chat_message")).toHaveLength(0);
  expect(s.socket.frames("tool_denial")).toHaveLength(0);
  expect(s.socket.frames("conversation_playback")).toHaveLength(0);
});

test("unknown work stays with its chat through review, a new voice entry and return", async ctx => {
  const s = await scene(ctx); await s.start();
  s.event({ kind: "unassigned_input_fragment", sequence: 0, text: "Review the mast note.", timing: { kind: "unavailable" } });
  s.event({ kind: "unassigned_delegation", handle: "mast-unassociated", offsetMs: 500 });
  expect(s.client.reviewUnassigned()).toBe(true);
  await expect.poll(() => s.host.querySelector('[aria-label="Voice review controls"]')?.textContent).toContain("Voice requested agent work without an input association.");
  flushSync(() => s.ui.stores.chat.getState().setActiveSession("odysseus-harbour"));
  expect(s.host.querySelector('[aria-label="Voice review controls"]'), "UNKNOWN_WORK_NOTICE_MUST_NOT_MIGRATE_TO_UNRELATED_CHAT").toBeNull();
  expect(s.client.state.getState().unassignedWork).toBe(0);
  s.opened(2); s.client.enter(); s.client.start();
  await expect.poll(() => s.client.state.getState().micOn).toBe(true);
  expect(s.host.querySelector('[aria-label="Voice review controls"]'), "NEW_VOICE_ENTRY_DOES_NOT_INHERIT_UNKNOWN_WORK").toBeNull();
  s.client.leave();
  flushSync(() => s.ui.stores.chat.getState().setActiveSession(SESSION));
  expect(s.client.state.getState().unassignedWork, "ORIGINAL_CHAT_RETAINS_ITS_UNKNOWN_WORK").toBe(1);
  await expect.poll(() => s.host.querySelector('[aria-label="Voice review controls"]')?.textContent).toContain("Voice requested agent work without an input association.");
  expect(s.client.reviewUnassigned()).toBe(false);
  expect(s.socket.frames("chat_message")).toHaveLength(0);
  expect(s.socket.frames("conversation_commit")).toHaveLength(0);
});

test("unknown work follows provisional dialogue ownership and its adopted session", async ctx => {
  const s = await scene(ctx);
  flushSync(() => s.ui.stores.chat.getState().setActiveSession(null));
  s.client.enter(); s.opened(1, CAPS, { sessionId: undefined, historyOwnerId: "odysseus-watch-owner" }); s.client.start();
  await expect.poll(() => s.client.state.getState().micOn).toBe(true);
  s.event({ kind: "unassigned_input_fragment", sequence: 0, text: "Review the watch note.", timing: { kind: "unavailable" } });
  s.event({ kind: "unassigned_delegation", handle: "watch-unassociated", offsetMs: 500 });
  expect(s.client.reviewUnassigned()).toBe(true);
  const key = "dialogue:odysseus-watch-owner";
  expect(s.ui.stores.chat.getState().activeSessionId).toBe(key);
  expect(s.client.state.getState().unassignedWork, "UNKNOWN_WORK_FOLLOWS_RETAINED_OWNER").toBe(1);
  const page = { type: "dialogue_history" as const, ownerId: "odysseus-watch-owner", generation: 1, through: 0, records: [], coverage: "complete" as const };
  s.deliver(page);
  s.deliver({ ...page, sessionId: "odysseus-watch-session" });
  expect(s.ui.stores.chat.getState().activeSessionId).toBe("odysseus-watch-session");
  expect(s.client.state.getState().unassignedWork, "UNKNOWN_WORK_FOLLOWS_DIALOGUE_ADOPTION").toBe(1);
  flushSync(() => s.ui.stores.chat.getState().setActiveSession("odysseus-harbour"));
  expect(s.client.state.getState().unassignedWork, "ADOPTED_NOTICE_CANNOT_APPEAR_IN_ANOTHER_CHAT").toBe(0);
  flushSync(() => s.ui.stores.chat.getState().setActiveSession("odysseus-watch-session"));
  expect(s.client.state.getState().unassignedWork).toBe(1);
  expect(s.socket.frames("chat_message")).toHaveLength(0);
  expect(s.socket.frames("conversation_commit")).toHaveLength(0);
});

test("unknown work follows a voice-first reviewed task into its session", async ctx => {
  const s = await scene(ctx);
  flushSync(() => s.ui.stores.chat.getState().setActiveSession(null));
  await s.start();
  s.event({ kind: "unassigned_delegation", handle: "raft-unassociated", offsetMs: 500 });
  s.input("Find the raft note.");
  expect(s.client.commit(s.client.state.getState().token)).toBe(true);
  const commit = s.socket.frames("conversation_commit")[0]!;
  s.deliver({ type: "session_info", sessionId: "odysseus-raft-session", requestId: String(commit.requestId), isNew: true, turnId: "raft-turn" });
  expect(s.client.state.getState().sessionId).toBe("odysseus-raft-session");
  await expect.poll(() => s.client.state.getState().unassignedWork, { message: "UNKNOWN_WORK_FOLLOWS_REVIEWED_SESSION_ADOPTION" }).toBe(1);
  s.client.leave();
  flushSync(() => s.ui.stores.chat.getState().setActiveSession(SESSION));
  expect(s.client.state.getState().unassignedWork, "REVIEWED_ADOPTION_DOES_NOT_MIGRATE_NOTICE").toBe(0);
  flushSync(() => s.ui.stores.chat.getState().setActiveSession("odysseus-raft-session"));
  expect(s.client.state.getState().unassignedWork).toBe(1);
  expect(s.socket.frames("conversation_commit")).toHaveLength(1);
  expect(s.socket.frames("chat_message")).toHaveLength(0);
});

test("unknown work follows an admitted contextual task from its provisional owner", async ctx => {
  const s = await scene(ctx);
  flushSync(() => s.ui.stores.chat.getState().setActiveSession(null));
  s.client.enter(); s.opened(1, CAPS, { sessionId: undefined, historyOwnerId: "odysseus-signal-owner" }); s.client.start();
  await expect.poll(() => s.client.state.getState().micOn).toBe(true);
  s.event({ kind: "unassigned_delegation", handle: "signal-unassociated", offsetMs: 500 });
  s.client.leave();
  expect(s.ui.stores.chat.getState().activeSessionId).toBe("dialogue:odysseus-signal-owner");
  s.opened(2, { ...CAPS, contextualTasks: "supported" }, { sessionId: undefined, historyOwnerId: "odysseus-signal-owner" });
  s.client.enter(); s.client.start();
  await expect.poll(() => s.client.state.getState().micOn).toBe(true);
  s.deliver({ type: "conversation_work", conversationId: PROFILE.conversationId, epoch: 2, provenance: "contextual", taskId: "signal-task", nativeHandle: "signal-native", requestId: "signal-request", turnId: "signal-turn", sessionId: "odysseus-signal-session", state: "running", delivery: "pending", recognized: "Find the departure signal.", submitted: "Find the departure signal." });
  expect(s.ui.stores.chat.getState().activeSessionId).toBe("odysseus-signal-session");
  expect(s.client.state.getState().unassignedWork, "UNKNOWN_WORK_FOLLOWS_CONTEXTUAL_ADOPTION").toBe(1);
  s.client.leave();
  flushSync(() => s.ui.stores.chat.getState().setActiveSession(SESSION));
  expect(s.client.state.getState().unassignedWork).toBe(0);
  flushSync(() => s.ui.stores.chat.getState().setActiveSession("odysseus-signal-session"));
  expect(s.client.state.getState().unassignedWork).toBe(1);
  expect(s.socket.frames("conversation_commit")).toHaveLength(0);
  expect(s.socket.frames("chat_message")).toHaveLength(0);
});

test("unknown work distinguishes fresh drafts and is cleared at the principal boundary", async ctx => {
  const s = await scene(ctx);
  flushSync(() => s.ui.stores.chat.getState().setActiveSession(null));
  const drafts = s.ui.stores.drafts.getState(), original = drafts.idFor(null);
  drafts.edit(original, null, { text: "Keep the original mast draft." });
  await s.start();
  s.event({ kind: "unassigned_input_fragment", sequence: 0, text: "Review the mast note.", timing: { kind: "unavailable" } });
  s.event({ kind: "unassigned_delegation", handle: "draft-unassociated", offsetMs: 500 });
  expect(s.client.reviewUnassigned()).toBe(true);
  expect(s.client.state.getState().unassignedWork).toBe(1);
  drafts.newChat();
  expect(s.client.state.getState().unassignedWork, "FRESH_DRAFT_DOES_NOT_INHERIT_UNKNOWN_WORK").toBe(0);
  drafts.openUnbound(original);
  expect(s.client.state.getState().unassignedWork, "ORIGINAL_DRAFT_RETAINS_UNKNOWN_WORK").toBe(1);
  s.deliver({ type: "server_hello", protocolRev: 5, principalKey: "penelope-principal", capabilities: { liveConversation: true, conversationPause: true } });
  expect(s.client.state.getState().unassignedWork).toBe(0);
  drafts.newChat(); drafts.openUnbound(original);
  expect(s.client.state.getState().unassignedWork, "PRINCIPAL_BOUNDARY_DROPS_UNKNOWN_WORK_OWNERS").toBe(0);
  expect(s.socket.frames("chat_message")).toHaveLength(0);
  expect(s.socket.frames("conversation_commit")).toHaveLength(0);
});

for (const limit of ["fragments", "characters"] as const) test(`mixed review bounds ${limit} independently of contextual discussion`, async ctx => {
  const s = await mixedReviewScene(ctx);
  const text = limit === "fragments" ? " mast" : " mast".repeat(CONVERSATION_LIMITS.maxFragmentChars / 5);
  const capacity = limit === "fragments" ? CONVERSATION_LIMITS.maxFragmentsPerUtterance : CONVERSATION_LIMITS.maxUtteranceChars / text.length;
  const count = capacity + 5;
  for (let sequence = 0; sequence < count; sequence++) s.event({ kind: "unassigned_input_fragment", sequence, text, timing: { kind: "unavailable" } });
  expect(s.client.state.getState().unassigned.filter(f => f.taskContext), "REVIEW_ROLLOVER_PRESERVES_CONTEXT").toEqual(s.context);
  const review = s.client.state.getState().unassigned.filter(f => !f.taskContext);
  expect(review).toHaveLength(capacity);
  expect(review.map(f => f.sequence)).toEqual(Array.from({ length: capacity }, (_, i) => i + 5));
  expect(s.client.state.getState().micOn).toBe(true);
  expect(s.client.state.getState().notice).toContain("Only recent recognition remains in the review buffer");
  expect(s.client.reviewUnassigned()).toBe(true);
  expect(s.ui.stores.voice.getState().reviewText).toBe(text.repeat(capacity));
  expect(s.client.reviewUnassigned()).toBe(false);
  expect(s.socket.frames("chat_message")).toHaveLength(0);
  expect(s.socket.frames("conversation_commit")).toHaveLength(0);
});

test("bounded unassigned review keeps capture continuous and transfers only the retained review", async ctx => {
  const s = await scene(ctx); await s.start();
  const count=CONVERSATION_LIMITS.maxFragmentsPerUtterance+5;
  const text=(sequence:number)=>` note ${sequence}`;
  for (let sequence=0;sequence<count;sequence++)s.event({kind:"unassigned_input_fragment",sequence,text:text(sequence),timing:{kind:"unavailable"}});
  expect(s.client.state.getState().micOn,"REVIEW_EVICTION_DOES_NOT_STOP_CAPTURE").toBe(true);
  expect(s.client.state.getState().notice).toContain("Only recent recognition remains in the review buffer");
  expect(s.client.state.getState().unassigned).toHaveLength(CONVERSATION_LIMITS.maxFragmentsPerUtterance);
  expect(s.client.state.getState().recognition).toHaveLength(CONVERSATION_LIMITS.maxFragmentsPerUtterance+1);
  expect(s.client.state.getState().unassigned.map(f=>f.sequence)).toEqual(Array.from({length:CONVERSATION_LIMITS.maxFragmentsPerUtterance},(_,i)=>i+5));
  expect(s.socket.frames("chat_message")).toHaveLength(0);expect(s.socket.frames("conversation_commit")).toHaveLength(0);
  expect(s.client.reviewUnassigned()).toBe(true);
  expect(s.ui.stores.voice.getState().reviewText).toBe(Array.from({length:CONVERSATION_LIMITS.maxFragmentsPerUtterance},(_,i)=>text(i+5)).join(""));
  expect(s.client.state.getState().micOn).toBe(false);
  expect(s.socket.frames("conversation_commit")).toHaveLength(0);
});

test("volatile unsaved evidence has its own finite budget after review eviction",async ctx=>{
 const s=await scene(ctx);await s.start();
 for(let sequence=0;sequence<CONVERSATION_LIMITS.maxFragmentsPerUtterance+5;sequence++)s.event({kind:"unassigned_input_fragment",sequence,text:" mast",timing:{kind:"unavailable"}});
 const start=CONVERSATION_LIMITS.maxFragmentsPerUtterance+5;
 for(let i=0;i<=CONVERSATION_LIMITS.maxPendingDialogueObservations;i++)s.deliver({type:"conversation_event",conversationId:PROFILE.conversationId,epoch:1,retention:"unsaved",event:{kind:"unassigned_input_fragment",sequence:start+i,text:" sail",timing:{kind:"unavailable"}}});
 expect(s.client.state.getState().recognition.filter(f=>f.unsaved),"UNSAVED_BUDGET_IS_SEPARATE_FROM_REVIEW").toHaveLength(CONVERSATION_LIMITS.maxPendingDialogueObservations);
 expect(s.client.state.getState().dialogueNotice,"FINITE_UNSAVED_OVERFLOW_IS_VISIBLE").toContain("exceeded this device's temporary buffer");
 expect(s.client.state.getState().micOn).toBe(false);expect(s.socket.frames("conversation_commit")).toHaveLength(0);expect(s.socket.frames("chat_message")).toHaveLength(0);
});


for (const terminal of ["leave", "provider_error", "backpressure"] as const) test(`fresh voice entry after ${terminal} requires Start and opens exactly one new microphone`, async ctx => {
  const mic = controlledMicrophone(ctx, true);
  const s = await scene(ctx); await s.start();
  const oldRequest = String(s.socket.frames("conversation_start")[0]?.requestId);
  const oldStream = mic.streams[0]!;
  if (terminal !== "leave") {
    s.deliver({ type: "conversation_closed", conversationId: PROFILE.conversationId, epoch: 1, requestId: oldRequest, reason: terminal });
    expect(s.client.state.getState().active).toBe(true);
    expect(s.client.state.getState().micOn).toBe(false);
    expect(oldStream.getTracks().every(track => track.readyState === "ended")).toBe(true);
  }
  // A closed epoch that withdrew capture is L9, whose Close leaves like End.
  await expect.poll(() => s.button(terminal === "leave" ? "End" : "Close")).toBeDefined();
  await userEvent.click(s.button(terminal === "leave" ? "End" : "Close"));
  expect(s.client.state.getState().active).toBe(false);
  expect(oldStream.getTracks().every(track => track.readyState === "ended")).toBe(true);
  // Re-enter the same service in the same root. A fresh conversation has its
  // own identity even when its epoch counter starts at one again.
  flushSync(() => s.client.enter());
  expect(s.socket.frames("conversation_start")).toHaveLength(1);
  expect(s.client.state.getState().disclosureOpen).toBe(true);
  expect(mic.opens()).toBe(1);
  await userEvent.click(s.button("Start"));
  const request = s.socket.frames("conversation_start").at(-1)!;
  expect(request.requestId).not.toBe(oldRequest);
  const conversationId = "ithaca-fresh-voice";
  s.deliver({ ...PROFILE, conversationId, requestId: String(request.requestId) });
  s.deliver({ type: "conversation_event", conversationId, epoch: 1, event: { kind: "ready", input: { encoding: "pcm16", channels: 1, sampleRate: 24000 }, output: { encoding: "pcm16", channels: 1, sampleRate: 24000 } } });
  expect(s.client.state.getState().disclosureOpen).toBe(false);
  await expect.poll(() => s.client.state.getState().micOn).toBe(true);
  expect(mic.opens()).toBe(2);
  expect(mic.streams.filter(stream => stream.getTracks().some(track => track.readyState === "live"))).toHaveLength(1);
  // Delayed frames from the previous conversation cannot close the fresh one.
  s.deliver({ type: "conversation_closed", conversationId: PROFILE.conversationId, epoch: 1, requestId: oldRequest, reason: "provider_error" });
  expect(s.client.state.getState().active).toBe(true);
  expect(s.client.state.getState().micOn).toBe(true);
  expect(s.client.state.getState().profile?.conversationId).toBe(conversationId);
  expect(s.ui.stores.voice.getState().mode).toBe("conversation");
});


test("root refresh: dispose releases physical capture and a fresh root requires Start", async ctx => {
  const mic = controlledMicrophone(ctx, true);
  const old = await scene(ctx); await old.start();
  old.dispose();
  expect(old.client.state.getState().active).toBe(false);
  expect(mic.streams[0]!.getTracks().every(track => track.readyState === "ended")).toBe(true);
  const fresh = await scene(ctx); await fresh.enter();
  expect(fresh.client.state.getState().disclosureOpen).toBe(true);
  expect(fresh.client.state.getState().micOn).toBe(false);
  expect(mic.opens()).toBe(1);
  old.client.enter(); old.client.resume();
  old.client.frame({ ...PROFILE, epoch: 2, requestId: String(old.socket.frames("conversation_start")[0]?.requestId) });
  expect(mic.opens()).toBe(1);
  await userEvent.click(fresh.button("Start"));
  await expect.poll(() => fresh.client.state.getState().micOn).toBe(true);
  expect(mic.opens()).toBe(2);
  expect(mic.streams.filter(stream => stream.getTracks().some(track => track.readyState === "live"))).toHaveLength(1);
});

test("reconnect: one live physical microphone recovers automatically after readiness", async ctx => {
  const mic = controlledMicrophone(ctx, true);
  const s = await scene(ctx); await s.start();
  s.network.drop({ announce: true });
  await expect.poll(() => s.client.state.getState().micOn).toBe(false);
  expect(mic.streams[0]!.getTracks().every(track => track.readyState === "ended")).toBe(true);
  s.network.recover(); s.ui.connection.reconnectNow();
  await expect.poll(() => s.network.socket() !== s.socket && s.ui.stores.connection.getState().wsStatus === "connected").toBe(true);
  const replacement = s.network.socket()!;
  await expect.poll(() => replacement.frames("conversation_start").length).toBe(1);
  replacement.deliver({ ...PROFILE, epoch: 2, requestId: replacement.frames("conversation_start")[0]?.requestId });
  replacement.deliver({ type: "conversation_event", conversationId: PROFILE.conversationId, epoch: 2, event: { kind: "ready", input: { encoding: "pcm16", channels: 1, sampleRate: 24000 }, output: { encoding: "pcm16", channels: 1, sampleRate: 24000 } } });
  await expect.poll(() => s.client.state.getState().micOn).toBe(true);
  expect(mic.opens()).toBe(2);
  expect(mic.streams.filter(stream => stream.getTracks().some(track => track.readyState === "live"))).toHaveLength(1);
});

// These are local labels for the existing wire reason classes. Free-form
// remote message text is deliberately never a retained client diagnostic.
const CLOSE_DIAGNOSTICS = {
  stopped: "The voice session stopped.",
  replaced: "The voice session was replaced.",
  disconnected: "The voice connection was lost.",
  provider_closed: "The voice service closed the connection.",
  provider_error: "The voice service failed.",
  backpressure: "The voice session reached a transport limit.",
  correlation: "The voice service could not match the conversation input.",
  refused: "The voice session was refused.",
} as const;
const REMOTE_CLOSE_TEXT = "fixture-private-marker: transcript, audio, credential must not be retained";

for (const reason of Object.keys(CLOSE_DIAGNOSTICS) as (keyof typeof CLOSE_DIAGNOSTICS)[]) test(`close diagnostic: failed opening retains only fixed ${reason} class`, async ctx => {
  const mic = controlledMicrophone(ctx, true);
  const s = await scene(ctx);
  s.client.enter(); s.client.start();
  const requestId = String(s.socket.frames("conversation_start").at(-1)!.requestId);
  s.deliver({ type: "conversation_closed", conversationId: PROFILE.conversationId, epoch: 1, requestId, reason, message: REMOTE_CLOSE_TEXT });
  expect(JSON.stringify(s.client.state.getState()), "REMOTE_CLOSE_TEXT_NOT_RETAINED").not.toContain(REMOTE_CLOSE_TEXT);
  expect(s.client.state.getState().notice, "OPENING_CLOSE_FIXED_DIAGNOSTIC").toContain(CLOSE_DIAGNOSTICS[reason]);
  expect(s.client.state.getState().connection).toBe("Speech lost");
  expect(s.client.state.getState().micOn).toBe(false);
  expect(mic.opens()).toBe(0);
  expect(s.socket.frames("conversation_commit")).toHaveLength(0);
  // A later generic loss cannot erase the reason, or request a microphone.
  s.network.drop({ announce: true });
  await expect.poll(() => s.ui.stores.connection.getState().wsStatus).not.toBe("connected");
  expect(s.client.state.getState().notice, "OPENING_CLOSE_SURVIVES_PAUSE").toContain(CLOSE_DIAGNOSTICS[reason]);
});

for (const reason of (Object.keys(CLOSE_DIAGNOSTICS) as (keyof typeof CLOSE_DIAGNOSTICS)[]).filter(reason => !["stopped", "disconnected", "provider_closed"].includes(reason))) test(`close diagnostic: active ${reason} survives pause with review intact`, async ctx => {
  const mic = controlledMicrophone(ctx, true);
  const s = await scene(ctx); await s.start();
  s.input("Ask Nestor about the ships");
  s.deliver({ type: "conversation_closed", conversationId: PROFILE.conversationId, epoch: 1, reason, message: REMOTE_CLOSE_TEXT });
  expect(JSON.stringify(s.client.state.getState()), "REMOTE_CLOSE_TEXT_NOT_RETAINED").not.toContain(REMOTE_CLOSE_TEXT);
  expect(s.client.state.getState().notice, "ACTIVE_CLOSE_FIXED_DIAGNOSTIC").toContain(CLOSE_DIAGNOSTICS[reason]);
  expect(mic.streams[0]!.getTracks().every(track => track.readyState === "ended")).toBe(true);
  expect(s.client.state.getState().micOn).toBe(false);
  expect(s.client.state.getState().text).toBe("Ask Nestor about the ships");
  expect(s.socket.frames("conversation_commit")).toHaveLength(0);
  await expect.poll(() => s.host.textContent, { timeout: 2000 }).toContain(CLOSE_DIAGNOSTICS[reason]);
  // Visibility loss uses the actual generic pause path. Register restoration
  // before assertions, so a failing/timeout assertion cannot leave globals changed.
  const visibility = Object.getOwnPropertyDescriptor(document, "visibilityState");
  const hiddenDescriptor = Object.getOwnPropertyDescriptor(document, "hidden");
  let restored = false;
  const hidden = { restore() {
    if (restored) return; restored = true;
    if (visibility) Object.defineProperty(document, "visibilityState", visibility); else Reflect.deleteProperty(document, "visibilityState");
    if (hiddenDescriptor) Object.defineProperty(document, "hidden", hiddenDescriptor); else Reflect.deleteProperty(document, "hidden");
    document.dispatchEvent(new Event("visibilitychange"));
  } };
  ctx.onTestFinished(() => hidden.restore());
  Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
  const endpointsBeforeHide = s.socket.frames("conversation_endpoint").length;
  document.dispatchEvent(new Event("visibilitychange"));
  expect(s.socket.frames("conversation_endpoint"), "hiding a failed epoch never sends a stale endpoint").toHaveLength(endpointsBeforeHide);
  expect(s.client.state.getState().notice, "ACTIVE_CLOSE_SURVIVES_PAUSE").toContain(CLOSE_DIAGNOSTICS[reason]);
  expect(mic.opens()).toBe(1);
  hidden.restore();
  s.client.resume();
  expect(s.client.state.getState().notice, "NEW_START_CLEARS_CLOSE_DIAGNOSTIC").not.toContain(CLOSE_DIAGNOSTICS[reason]);
  s.opened(2);
  expect(s.client.state.getState().notice).not.toContain(CLOSE_DIAGNOSTICS[reason]);
  expect(mic.opens()).toBe(2);
  s.deliver({ type: "conversation_closed", conversationId: PROFILE.conversationId, epoch: 1, reason: "refused", message: REMOTE_CLOSE_TEXT });
  expect(s.client.state.getState().notice, "STALE_EPOCH_CANNOT_RESTORE_DIAGNOSTIC").not.toContain(CLOSE_DIAGNOSTICS.refused);
});

for (const ending of ["leave", "logout", "dispose"] as const) test(`close diagnostic: ${ending} clears retained reason and rejects late frames`, async ctx => {
  const s = await scene(ctx); s.client.enter(); s.client.start();
  const requestId = String(s.socket.frames("conversation_start").at(-1)!.requestId);
  const closed: ServerMessage = { type: "conversation_closed", conversationId: PROFILE.conversationId, epoch: 1, requestId, reason: "provider_error" };
  s.deliver(closed);
  expect(s.client.state.getState().notice).toContain(CLOSE_DIAGNOSTICS.provider_error);
  if (ending === "leave") s.client.leave();
  else if (ending === "logout") await s.ui.authLock.expire("signed out", true);
  else s.dispose();
  expect(s.client.state.getState().notice, "LIFECYCLE_CLEARS_CLOSE_DIAGNOSTIC").not.toContain(CLOSE_DIAGNOSTICS.provider_error);
  s.client.frame(closed);
  expect(s.client.state.getState().notice, "LATE_CLOSE_CANNOT_RESTORE_DIAGNOSTIC").not.toContain(CLOSE_DIAGNOSTICS.provider_error);
  expect(s.client.state.getState().active).toBe(false);
});

test("close diagnostic: replacement opening rejects stale close and old conversation refusal", async ctx => {
  controlledMicrophone(ctx, true);
  const s = await scene(ctx); await s.enter();
  s.client.start();
  const oldRequest = String(s.socket.frames("conversation_start")[0]!.requestId);
  s.deliver({ type: "conversation_closed", conversationId: PROFILE.conversationId, epoch: 1, reason: "provider_error" });
  expect(s.client.state.getState().notice).toContain(CLOSE_DIAGNOSTICS.provider_error);
  s.client.resume();
  expect(s.client.state.getState().notice, "RESUME_CLEARS_CLOSE_DIAGNOSTIC").not.toContain(CLOSE_DIAGNOSTICS.provider_error);
  s.deliver({ type: "conversation_closed", conversationId: PROFILE.conversationId, epoch: 1, requestId: oldRequest, reason: "refused" });
  expect(s.client.state.getState().notice, "PENDING_REPLACEMENT_REJECTS_OLD_CLOSE").not.toContain(CLOSE_DIAGNOSTICS.refused);
  s.opened(2);
  s.deliver({ type: "conversation_closed", conversationId: "ithaca-obsolete", epoch: 2, reason: "refused" });
  expect(s.client.state.getState().notice, "OTHER_CONVERSATION_REJECTS_CLOSE").not.toContain(CLOSE_DIAGNOSTICS.refused);
});


test("close diagnostic: abandoned opening refusal cannot contaminate fresh entry", async ctx => {
  const mic = controlledMicrophone(ctx, true);
  const s = await scene(ctx);
  s.client.enter(); s.client.start();
  const requestId = String(s.socket.frames("conversation_start")[0]!.requestId);
  s.client.leave(); s.client.enter(); s.client.start(); s.client.mute();
  s.deliver({ type: "conversation_closed", conversationId: "ithaca-abandoned", epoch: 1, requestId, reason: "refused", message: REMOTE_CLOSE_TEXT });
  expect(s.client.state.getState().notice, "ABANDONED_OPENING_REJECTS_DIAGNOSTIC").not.toContain(CLOSE_DIAGNOSTICS.refused);
  await expect.poll(() => s.socket.frames("conversation_start").length).toBe(2);
  s.opened();
  expect(s.client.state.getState().profile?.conversationId).toBe(PROFILE.conversationId);
  expect(JSON.stringify(s.client.state.getState())).not.toContain(REMOTE_CLOSE_TEXT);
  expect(mic.opens()).toBe(0);
});

for (const muted of [false, true]) test(`visibility recovery retains ${muted ? "manual Mute" : "consent"} and the same healthy epoch without replay`, async ctx => {
  const mic = controlledMicrophone(ctx, true);
  const s = await scene(ctx); await s.start();
  if (muted) s.client.mute();
  const hidden = hidePage(); ctx.onTestFinished(() => hidden.show());
  expect(s.client.state.getState().micOn).toBe(false);
  const frames = s.socket.frames("conversation_audio").length;
  s.event({ kind: "audio", outputId: "hidden-reply", sequence: 0, pcm: outputPcm(0.2), format: { encoding: "pcm16", channels: 1, sampleRate: 24000 } });
  expect(s.client.state.getState().playing).toBe(false);
  hidden.show();
  if (!muted) await expect.poll(() => s.client.state.getState().micOn).toBe(true);
  else expect(s.client.state.getState().micOn).toBe(false);
  expect(mic.opens()).toBe(muted ? 1 : 2);
  expect(s.socket.frames("conversation_start")).toHaveLength(1);
  expect(s.socket.frames("conversation_stop")).toHaveLength(0);
  expect(s.client.state.getState().profile?.epoch).toBe(1);
  expect(s.socket.frames("conversation_commit")).toHaveLength(0);
  if (muted) expect(s.socket.frames("conversation_audio")).toHaveLength(frames);
});

for (const reason of ["disconnected", "provider_closed"] as const) test(`recoverable active ${reason} never publishes remote diagnostics, including blocked restart`, async ctx => {
  const mic = controlledMicrophone(ctx, true);
  const s = await scene(ctx); await s.start();
  s.input("Ask Nestor about the ships");
  const published: string[] = [];
  const unsubscribe = s.client.state.subscribe(next => published.push(JSON.stringify(next)));
  ctx.onTestFinished(unsubscribe);
  const assertPrivate = () => expect(published.join("\n"), "R7PROBE_REMOTE_NEVER_PUBLISHED").not.toContain(REMOTE_CLOSE_TEXT);

  s.deliver({ type: "conversation_closed", conversationId: PROFILE.conversationId, epoch: 1, reason, message: REMOTE_CLOSE_TEXT });
  // suspend publishes before startEpoch clears its notice. Inspect every
  // notification, not only the final state after automatic recovery starts.
  assertPrivate();
  expect(published.some(snapshot => snapshot.includes(CLOSE_DIAGNOSTICS[reason])), "RECOVERABLE_CLOSE_PUBLISHED_FIXED_REASON").toBe(true);
  expect(s.socket.frames("conversation_start")).toHaveLength(2);
  expect(s.client.state.getState().micOn).toBe(false);
  expect(mic.streams[0]!.getTracks().every(track => track.readyState === "ended")).toBe(true);
  expect(s.client.state.getState().text).toBe("Ask Nestor about the ships");
  // Withhold the replacement receipt: consent alone cannot reopen capture.
  // The closure was handled as it was delivered, and a capture opens the
  // microphone synchronously, so no window is needed to see that none started.
  assertPrivate();
  expect(mic.opens()).toBe(1);
  s.opened(2);
  await expect.poll(() => s.client.state.getState().micOn).toBe(true);
  expect(mic.opens()).toBe(2);
  expect(s.client.state.getState().text).toBe("");

  const hidden = hidePage(); ctx.onTestFinished(() => hidden.show());
  s.deliver({ type: "conversation_closed", conversationId: PROFILE.conversationId, epoch: 2, reason, message: REMOTE_CLOSE_TEXT });
  assertPrivate();
  expect(s.client.state.getState().notice).toContain(CLOSE_DIAGNOSTICS[reason]);
  expect(s.socket.frames("conversation_start")).toHaveLength(2);
  expect(s.client.state.getState().micOn).toBe(false);
  expect(mic.opens()).toBe(2);
  hidden.show();
  await expect.poll(() => s.socket.frames("conversation_start").length).toBe(3);
  s.opened(3);
  await expect.poll(() => s.client.state.getState().micOn).toBe(true);
  assertPrivate();
  expect(mic.opens()).toBe(3);
  expect(s.socket.frames("conversation_commit")).toHaveLength(0);
  expect(s.socket.frames("chat_message")).toHaveLength(0);
});

for (const muted of [false, true]) test(`recoverable provider closure preserves ${muted ? "manual mute" : "consent"} and never retains remote content`, async ctx => {
  const mic = controlledMicrophone(ctx, true);
  const s = await scene(ctx); await s.start();
  if (muted) s.client.mute();
  s.deliver({ type: "conversation_closed", conversationId: PROFILE.conversationId, epoch: 1, reason: "provider_closed", message: REMOTE_CLOSE_TEXT });
  expect(s.client.state.getState().micOn).toBe(false);
  expect(JSON.stringify(s.client.state.getState())).not.toContain(REMOTE_CLOSE_TEXT);
  expect(s.socket.frames("conversation_start")).toHaveLength(2);
  s.opened(2);
  if (!muted) await expect.poll(() => s.client.state.getState().micOn).toBe(true);
  else expect(s.client.state.getState().micOn).toBe(false);
  expect(mic.opens()).toBe(muted ? 1 : 2);
});

test("output recovery timeout never mutes capture; manual output recovery and Leave are separate", async ctx => {
  const mic = controlledMicrophone(ctx);
  const s = await scene(ctx, 320, true); await s.start(); mic.quiet();
  await expect.poll(() => s.socket.frames("conversation_endpoint").length).toBe(1);
  s.event({ kind: "interrupted", outputId: "output-1" });
  const timer = setInterval(() => s.event({ kind: "audio", outputId: "output-1", sequence: 0, pcm: outputPcm(0.1), format: { encoding: "pcm16", channels: 1, sampleRate: 24000 } }), 100);
  ctx.onTestFinished(() => clearInterval(timer));
  await expect.poll(() => s.client.state.getState().outputRecovery, { timeout: 4500 }).toBe("muted");
  clearInterval(timer);
  expect(s.client.state.getState().micOn).toBe(true);
  expect(s.client.state.getState().playing).toBe(false);
  const f = field(s);
  expect(s.host.querySelector("[data-conversation-field] .bk-voice-label-meta")?.textContent).toBe("Reply audio off");
  expect(s.host.querySelector("[data-conversation-field] [data-voice-text]")?.textContent).toBe("Brain’s voice was paused after a dropout. Replies still arrive as text.");
  expect(f.controls(), "recovery stays manual and in the row").toEqual(["Mute", "Recover reply audio", "End"]);
  await page.screenshot({ element: s.host, path: "../../.vitest-attachments/conversation/output-recovery-320.png" });
  await userEvent.click(s.button("Recover reply audio"));
  s.event({ kind: "audio", outputId: "output-1", sequence: 1, pcm: outputPcm(0.2), format: { encoding: "pcm16", channels: 1, sampleRate: 24000 } });
  await expect.poll(() => s.client.state.getState().playing).toBe(true);
  expect(mic.opens()).toBe(1);
  s.event({ kind: "interrupted", outputId: "output-1" });
  s.client.leave();
  expect(s.client.state.getState().micOn).toBe(false);
  // A real audio clock boundary lets an erroneously retained recovery timer fire.
  const clock = new AudioContext(); ctx.onTestFinished(() => { void clock.close(); });
  const source = clock.createBufferSource(); source.buffer = clock.createBuffer(1, 12000, 24000); source.connect(clock.destination);
  await clock.resume(); await new Promise<void>(resolve => { source.onended = () => resolve(); source.start(); });
  expect(s.client.state.getState().active).toBe(false);
  expect(s.client.state.getState().playing).toBe(false);
  expect(mic.opens()).toBe(1);
});

test("send-before-disconnect race preserves consent and discards unavailable-period PCM", async ctx => {
  const mic = controlledMicrophone(ctx, true);
  const s = await scene(ctx); await s.start();
  // Native sockets can stop accepting sends before the queued close callback.
  s.socket.readyState = 2;
  await expect.poll(() => s.client.state.getState().micOn).toBe(false);
  expect(s.ui.stores.connection.getState().wsStatus).toBe("connected");
  const sent = s.socket.frames("conversation_audio").length;
  s.socket.readyState = 1; s.network.drop({ announce: true });
  s.network.recover(); s.ui.connection.reconnectNow();
  await expect.poll(() => s.network.socket() !== s.socket && s.ui.stores.connection.getState().wsStatus === "connected").toBe(true);
  const replacement = s.network.socket()!;
  await expect.poll(() => replacement.frames("conversation_start").length).toBe(1);
  replacement.deliver({ ...PROFILE, epoch: 2, requestId: replacement.frames("conversation_start")[0]?.requestId, resync: { work: 0, outputs: 1 } });
  replacement.deliver({ type: "conversation_event", conversationId: PROFILE.conversationId, epoch: 2, event: { kind: "ready", input: { encoding: "pcm16", channels: 1, sampleRate: 24000 }, output: { encoding: "pcm16", channels: 1, sampleRate: 24000 } } });
  expect(s.client.state.getState().micOn).toBe(false);
  expect(replacement.frames("conversation_audio")).toHaveLength(0);
  replacement.deliver({ type: "conversation_output", conversationId: PROFILE.conversationId, epoch: 1, outputId: "previous-reply", generated: "Earlier voyage context", playback: "unknown" });
  await expect.poll(() => s.client.state.getState().micOn).toBe(true);
  await expect.poll(() => replacement.frames("conversation_audio").length).toBeGreaterThan(0);
  expect(replacement.frames("conversation_audio")[0]?.sequence).toBe(0);
  expect(s.socket.frames("conversation_audio")).toHaveLength(sent);
  expect(mic.opens()).toBe(2);
  expect(replacement.frames("conversation_commit")).toHaveLength(0);
});


test("same-commit control remount retains capture; a true last-owner unmount leaves voice", async ctx => {
  const mic = controlledMicrophone(ctx, true);
  const s = await scene(ctx); await s.start();
  s.remountControls();
  await Promise.resolve();
  expect(s.client.state.getState().active).toBe(true);
  expect(s.client.state.getState().micOn).toBe(true);
  expect(mic.opens()).toBe(1);
  expect(s.socket.frames("conversation_stop")).toHaveLength(0);
  s.unmountControls();
  await expect.poll(() => s.client.state.getState().active).toBe(false);
  expect(s.client.state.getState().micOn).toBe(false);
  expect(mic.streams[0]!.getTracks().every(track => track.readyState === "ended")).toBe(true);
});


for(const [code,copy] of [
 ["DIALOGUE_UNAVAILABLE","Conversation history unavailable. Try opening this chat again."],
 ["DIALOGUE_STORAGE","Conversation history writes failed. Restore storage before restarting voice."],
 ["DIALOGUE_PENDING_PRESSURE","Conversation text is arriving faster than it can be saved. Voice capture stopped at the pending-write limit. Any unsaved text is unavailable after reload. Let pending writes finish and check storage before restarting voice."],
] as const)test(`dialogue diagnostic: ${code} retains only fixed local cause`,async ctx=>{
 const s=await scene(ctx);await s.start();s.input("The mast is ready.");
 s.deliver({type:"error",sessionId:SESSION,code,message:REMOTE_CLOSE_TEXT});
 expect(JSON.stringify(s.client.state.getState()),"REMOTE_DIALOGUE_ERROR_NOT_RETAINED").not.toContain(REMOTE_CLOSE_TEXT);
 expect(s.client.state.getState().dialogueNotice,"LOCAL_DIALOGUE_CAUSE_COPY").toBe(copy);
 expect(s.client.state.getState().text).toBe("The mast is ready.");
 expect(s.socket.frames("conversation_commit")).toHaveLength(0);expect(s.socket.frames("chat_message")).toHaveLength(0);
 await expect.poll(()=>s.host.textContent).toContain(copy);
 expect(s.host.textContent).not.toContain(REMOTE_CLOSE_TEXT);
 await page.screenshot({element:s.host,path:`../../.vitest-attachments/durable-dialogue/r11-${code.toLowerCase()}.png`});
 if(code!=="DIALOGUE_UNAVAILABLE"){
  expect(s.client.state.getState().micOn).toBe(false);
  s.deliver({type:"conversation_closed",conversationId:PROFILE.conversationId,epoch:1,reason:"provider_error",message:REMOTE_CLOSE_TEXT});
  expect(s.client.state.getState().notice,"SCOPED_STORAGE_CAUSE_SURVIVES_CLOSE").toBe(copy);
  expect(JSON.stringify(s.client.state.getState())).not.toContain(REMOTE_CLOSE_TEXT);
 }else expect(s.client.state.getState().micOn).toBe(true);
});

test("late reviewed session identity preserves its original unknown-work notice", async ctx => {
  const s = await scene(ctx);
  flushSync(() => s.ui.stores.chat.getState().setActiveSession(null));
  await s.start();
  s.event({ kind: "unassigned_delegation", handle: "mast-unassociated", offsetMs: 500 });
  s.input("Find the mast note.");
  expect(s.client.commit(s.client.state.getState().token)).toBe(true);
  const commit=s.socket.frames("conversation_commit")[0]!;
  s.client.leave();
  flushSync(() => s.ui.stores.chat.getState().setActiveSession(SESSION));
  expect(s.client.state.getState().unassignedWork).toBe(0);
  s.deliver({type:"session_info",sessionId:"odysseus-late-mast",requestId:String(commit.requestId),turnId:"mast-turn",isNew:true});
  flushSync(() => s.ui.stores.chat.getState().setActiveSession("odysseus-late-mast"));
  expect(s.client.state.getState().unassignedWork,"LATE_REVIEWED_ADOPTION_PRESERVES_UNKNOWN_WORK").toBe(1);
  expect(s.socket.frames("conversation_commit")).toHaveLength(1);
});
test("late contextual session identity preserves its original unknown-work notice", async ctx => {
  const s = await scene(ctx);
  flushSync(() => s.ui.stores.chat.getState().setActiveSession(null));
  s.client.enter(); s.opened(1,CAPS,{sessionId:undefined,historyOwnerId:"odysseus-late-owner"}); s.client.start();
  await expect.poll(() => s.client.state.getState().micOn).toBe(true);
  s.event({kind:"unassigned_delegation",handle:"watch-unassociated",offsetMs:500});
  s.client.leave();
  s.opened(2,{...CAPS,contextualTasks:"supported"},{sessionId:undefined,historyOwnerId:"odysseus-late-owner"});
  s.client.enter();s.client.start();
  await expect.poll(() => s.client.state.getState().micOn).toBe(true);
  s.deliver({type:"conversation_work",conversationId:PROFILE.conversationId,epoch:2,provenance:"contextual",taskId:"late-task",nativeHandle:"late-native",requestId:"late-request",turnId:"late-turn",state:"running",delivery:"pending",recognized:"Find the watch note.",submitted:"Find the watch note."});
  s.client.leave();
  flushSync(() => s.ui.stores.chat.getState().setActiveSession(SESSION));
  expect(s.client.state.getState().unassignedWork).toBe(0);
  s.deliver({type:"session_info",sessionId:"odysseus-late-watch",requestId:"late-request",turnId:"late-turn",isNew:true});
  flushSync(() => s.ui.stores.chat.getState().setActiveSession("odysseus-late-watch"));
  expect(s.client.state.getState().unassignedWork,"LATE_CONTEXTUAL_ADOPTION_PRESERVES_UNKNOWN_WORK").toBe(1);
  expect(s.socket.frames("conversation_commit")).toHaveLength(0);
});

for (const navigate of [false,true]) test(`ordinary composer send preserves fresh-draft unknown work, away=${navigate}`, async ctx => {
 const s=await scene(ctx);
 flushSync(()=>s.ui.stores.chat.getState().setActiveSession(null));
 const d=s.ui.stores.drafts.getState(), origin=d.idFor(null);
 d.edit(origin,null,{text:"Keep the mast note."});
 await s.start();
 s.event({kind:"unassigned_input_fragment",sequence:0,text:"Find the departure note.",timing:{kind:"unavailable"}});
 s.event({kind:"unassigned_delegation",handle:"odysseus-unbound",offsetMs:1});
 expect(s.client.reviewUnassigned()).toBe(true);
 expect(s.client.state.getState().unassignedWork).toBe(1);
 await expect.poll(()=>s.button("Send")).not.toBeUndefined();
 await userEvent.click(s.button("Send"));
 const sent=s.socket.frames("chat_message");
 expect(sent).toHaveLength(1);
 expect(sent[0]?.source).toBe("voice-dictate");
 if(navigate) flushSync(()=>s.ui.stores.chat.getState().setActiveSession(SESSION));
 s.deliver({type:"session_info",sessionId:"odysseus-manual-mast",requestId:String(sent[0]!.requestId),draftId:String(sent[0]!.draftId),turnId:"odysseus-manual-turn",isNew:true});
 if(navigate) expect(s.ui.stores.chat.getState().activeSessionId).toBe(SESSION);
 flushSync(()=>s.ui.stores.chat.getState().setActiveSession("odysseus-manual-mast"));
 expect.soft(s.client.state.getState().unassignedWork,"COMPOSER_ADOPTION_PRESERVES_UNKNOWN_WORK").toBe(1);
 expect(s.socket.frames("chat_message")).toHaveLength(1);
 expect(s.socket.frames("conversation_commit")).toHaveLength(0);
});

test("navigating retained device draft versions cannot change unknown-work ownership",async ctx=>{
 const s=await scene(ctx);
 flushSync(()=>s.ui.stores.chat.getState().setActiveSession(null));
 const d=s.ui.stores.drafts.getState(), origin=d.idFor(null);
 d.edit(origin,null,{text:"Odysseus local mast draft."});
 await s.start();
 s.event({kind:"unassigned_delegation",handle:"odysseus-device-branch",offsetMs:1});
 s.client.leave();
 const local=s.ui.stores.drafts.getState().drafts[origin]!;
 const incoming={draftId:origin,sessionId:null,text:"Penelope other mast revision.",attachments:[],editedAt:local.editedAt+1,host:null};
 d.keepDeviceBranch(origin,"odysseus-local-branch",incoming,null);
 expect(s.ui.stores.drafts.getState().fresh).toBe("odysseus-local-branch");
 expect(d.resolveId(origin)).toBe("odysseus-local-branch");
 expect(s.client.state.getState().unassignedWork,"BRANCH_RETAINS_ORIGINAL_NOTICE").toBe(1);
 d.openUnbound(origin);
 expect(s.ui.stores.drafts.getState().fresh).toBe(origin);
 expect.soft(s.client.state.getState().unassignedWork,"OTHER_DEVICE_VERSION_CANNOT_INHERIT_NOTICE").toBe(0);
 d.openUnbound("odysseus-local-branch");
 expect.soft(s.client.state.getState().unassignedWork,"ORIGINAL_BRANCH_RETAINS_NOTICE_AFTER_NAVIGATION").toBe(1);
 expect(s.socket.frames("chat_message")).toHaveLength(0);
 expect(s.socket.frames("conversation_commit")).toHaveLength(0);
});

const canonicalPage = {"ownerId": "odysseus-canonical-owner", "sessionId": "odysseus-native-session", "generation": 1, "through": 0, "records": [], "coverage": "partial" as const};

for(const route of ["provisional-same-owner","provisional-canonical-owner","native-same-owner"] as const) test(`correlated history adoption retains unknown work via ${route}`,async ctx=>{
 const s=await scene(ctx);
 flushSync(()=>s.ui.stores.chat.getState().setActiveSession(null));
 s.client.enter();s.opened(1,CAPS,{sessionId:undefined,historyOwnerId:"odysseus-provisional-owner"});s.client.start();
 await expect.poll(()=>s.client.state.getState().micOn).toBe(true);
 s.event({kind:"unassigned_delegation",handle:"odysseus-history-notice",offsetMs:1});
 s.client.leave();
 const provisional="dialogue:odysseus-provisional-owner";
 expect(s.ui.stores.chat.getState().activeSessionId).toBe(provisional);
 expect(s.client.state.getState().unassignedWork).toBe(1);
 const originalPage={type:"dialogue_history" as const,ownerId:"odysseus-provisional-owner",generation:1,through:0,records:[],coverage:"complete" as const};
 s.deliver(originalPage);
 const key=route==="native-same-owner" ? canonicalPage.sessionId! : provisional;
 s.client.loadDialogue(key);
 let read=s.socket.frames("dialogue_read").findLast(frame=>frame.ownerId==="odysseus-provisional-owner" && key===provisional || frame.sessionId===key)!;
 expect(read,"READ_WAS_ACTUALLY_REQUESTED").toBeDefined();
 const reply=route==="provisional-canonical-owner" ? canonicalPage : {...originalPage,sessionId:canonicalPage.sessionId};
 if (route === "native-same-owner") {
   s.deliver({...reply,type:"dialogue_history",sessionId:"odysseus-unrelated-history",requestId:String(read.requestId)});
   expect(s.ui.stores.chat.getState().activeSessionId,"NATIVE_READ_CANNOT_RETARGET_SELECTION").toBe(provisional);
   expect(s.client.state.getState().unassignedWork,"NATIVE_READ_CANNOT_RETARGET_NOTICE").toBe(1);
   s.client.loadDialogue(key);
   read=s.socket.frames("dialogue_read").findLast(frame=>frame.sessionId===key)!;
 }
 s.deliver({...reply,type:"dialogue_history",requestId:String(read.requestId)});
 expect(s.ui.stores.chat.getState().activeSessionId).toBe(canonicalPage.sessionId);
 expect(s.client.state.getState().dialogue[canonicalPage.sessionId!]?.ownerId).toBe(reply.ownerId);
 expect.soft(s.client.state.getState().unassignedWork,`CORRELATED_HISTORY_ADOPTION_PRESERVES_NOTICE:${route}`).toBe(1);
 expect(s.socket.frames("chat_message")).toHaveLength(0);
 expect(s.socket.frames("conversation_commit")).toHaveLength(0);
});

for (const navigate of [false, true]) test(`stale and unknown history replies cannot retarget the retained notice, away=${navigate}`,async ctx=>{
 const s=await scene(ctx);flushSync(()=>s.ui.stores.chat.getState().setActiveSession(null));
 s.client.enter();s.opened(1,CAPS,{sessionId:undefined,historyOwnerId:"odysseus-provisional-owner"});s.client.start();
 await expect.poll(()=>s.client.state.getState().micOn).toBe(true);
 s.event({kind:"unassigned_delegation",handle:"odysseus-stale-notice",offsetMs:1});s.client.leave();
 const key="dialogue:odysseus-provisional-owner";
 const page={type:"dialogue_history" as const,ownerId:"odysseus-provisional-owner",generation:2,through:0,records:[],coverage:"complete" as const};
 s.deliver(page);
 if (navigate) flushSync(()=>s.ui.stores.chat.getState().setActiveSession(SESSION));
 s.deliver({...page,sessionId:"odysseus-stale-session",requestId:"odysseus-unknown-read"});
 s.deliver({...page,sessionId:"odysseus-stale-session",generation:1});
 expect(s.ui.stores.chat.getState().activeSessionId,"STALE_HISTORY_CANNOT_CHANGE_SELECTION").toBe(navigate ? SESSION : key);
 flushSync(()=>s.ui.stores.chat.getState().setActiveSession("odysseus-stale-session"));
 expect(s.client.state.getState().unassignedWork).toBe(0);
 flushSync(()=>s.ui.stores.chat.getState().setActiveSession(key));
 expect(s.client.state.getState().unassignedWork).toBe(1);
});

test("pending composer acceptance follows the retained local draft after opening its other version", async ctx => {
  const s = await scene(ctx);
  flushSync(() => s.ui.stores.chat.getState().setActiveSession(null));
  const drafts = s.ui.stores.drafts.getState(), origin = drafts.idFor(null);
  drafts.edit(origin, null, { text: "Keep the local mast note." });
  await s.start();
  s.event({ kind: "unassigned_delegation", handle: "odysseus-pending-branch", offsetMs: 1 });
  s.client.leave();
  await expect.poll(() => s.button("Send")).not.toBeUndefined();
  await userEvent.click(s.button("Send"));
  const sent = s.socket.frames("chat_message").at(-1)!;
  const local = s.ui.stores.drafts.getState().drafts[origin]!;
  drafts.keepDeviceBranch(origin, "odysseus-pending-local", {
    draftId: origin, sessionId: null, text: "Penelope's other revision.", attachments: [], editedAt: local.editedAt + 1, host: null,
  }, null);
  drafts.openUnbound(origin);
  expect(s.client.state.getState().unassignedWork, "OTHER_VERSION_HAS_NO_PENDING_NOTICE").toBe(0);
  s.deliver({ type: "session_info", sessionId: "odysseus-pending-native", requestId: String(sent.requestId), draftId: String(sent.draftId), isNew: true });
  flushSync(() => s.ui.stores.chat.getState().setActiveSession("odysseus-pending-native"));
  expect(s.client.state.getState().unassignedWork, "ACCEPTED_SEND_USES_STABLE_LOCAL_ORIGIN").toBe(1);
  flushSync(() => s.ui.stores.chat.getState().setActiveSession(null));
  drafts.openUnbound(origin);
  expect(s.client.state.getState().unassignedWork).toBe(0);
  expect(s.socket.frames("chat_message")).toHaveLength(1);
  expect(s.socket.frames("conversation_commit")).toHaveLength(0);
});

for (const from of ["fresh", "provisional"] as const) for (const history of ["same-owner", "canonical-owner", "unavailable"] as const) test(`late reviewed acceptance after durable Leave preserves notice, ${from}, ${history}`, async ctx => {
  const s=await scene(ctx);
  flushSync(()=>s.ui.stores.chat.getState().setActiveSession(null));
  s.client.enter();s.opened(1,CAPS,{sessionId:undefined,historyOwnerId:"odysseus-late-provisional"});s.client.start();
  await expect.poll(()=>s.client.state.getState().micOn).toBe(true);
  await expect.poll(()=>s.socket.frames("conversation_audio").length).toBeGreaterThan(0);
  s.event({kind:"unassigned_delegation",handle:"odysseus-late-unbound",offsetMs:1});
  if(from==="provisional") {
    s.client.leave();
    const beforeAudio=s.socket.frames("conversation_audio").length;
    s.opened(2,CAPS,{sessionId:undefined,historyOwnerId:"odysseus-late-provisional"});s.client.enter();s.client.start();
    await expect.poll(()=>s.client.state.getState().micOn).toBe(true);
    await expect.poll(()=>s.socket.frames("conversation_audio").length).toBeGreaterThan(beforeAudio);
  }
  s.input("Find the mast note.");
  expect(s.client.commit(s.client.state.getState().token)).toBe(true);
  const commit=s.socket.frames("conversation_commit").at(-1)!;
  s.client.leave();
  const source="dialogue:odysseus-late-provisional", target="odysseus-late-native";
  expect(s.ui.stores.chat.getState().activeSessionId).toBe(source);
  expect(s.client.state.getState().unassignedWork).toBe(1);
  s.deliver({type:"dialogue_history",ownerId:"odysseus-late-provisional",generation:1,through:0,records:[],coverage:"complete"});
  flushSync(()=>s.ui.stores.chat.getState().setActiveSession(SESSION));
  s.deliver({type:"session_info",sessionId:target,requestId:String(commit.requestId),turnId:"odysseus-late-turn",isNew:true});
  expect(s.ui.stores.chat.getState().activeSessionId).toBe(SESSION);
  const read=s.socket.frames("dialogue_read").findLast(f=>f.sessionId===target)!;
  expect(read).toBeDefined();
  if(history==="unavailable") s.deliver({type:"error",code:"DIALOGUE_UNAVAILABLE",requestId:String(read.requestId),sessionId:target,message:"Fixture history temporarily unavailable."});
  else s.deliver({type:"dialogue_history",requestId:String(read.requestId),sessionId:target,ownerId:history==="same-owner"?"odysseus-late-provisional":"odysseus-canonical-owner",generation:1,through:0,records:[],coverage:"partial"});
  flushSync(()=>s.ui.stores.chat.getState().setActiveSession(target));
  expect.soft(s.client.state.getState().unassignedWork,`LATE_REVIEWED_DURABLE_ADOPTION:${history}`).toBe(1);
  flushSync(()=>s.ui.stores.chat.getState().setActiveSession(source));
  expect.soft(s.client.state.getState().unassignedWork,`RETIRED_PROVISIONAL_NOTICE_MOVED:${history}`).toBe(0);
  expect(s.socket.frames("conversation_commit")).toHaveLength(1);
  expect(s.socket.frames("chat_message")).toHaveLength(0);
});

for (const acceptance of ["session_info", "queued", "queue_report", "refusal"] as const) test(`ordinary provisional composer ${acceptance} follows exact acceptance`,async ctx=>{
  const s=await scene(ctx);flushSync(()=>s.ui.stores.chat.getState().setActiveSession(null));
  s.client.enter();s.opened(1,CAPS,{sessionId:undefined,historyOwnerId:"odysseus-composer-provisional"});s.client.start();
  await expect.poll(()=>s.client.state.getState().micOn).toBe(true);
  s.event({kind:"unassigned_delegation",handle:"odysseus-composer-work",offsetMs:1});s.client.leave();
  const source="dialogue:odysseus-composer-provisional",target="odysseus-composer-native";
  // Complete the real owner read before using its ordinary composer.
  s.client.loadDialogue(source);
  const read=s.socket.frames("dialogue_read").findLast(f=>f.ownerId==="odysseus-composer-provisional")!;
  expect(read).toBeDefined();
  s.deliver({type:"dialogue_history",requestId:String(read.requestId),ownerId:"odysseus-composer-provisional",generation:1,through:0,records:[],coverage:"complete"});
  const d=s.ui.stores.drafts.getState(); d.edit(d.idFor(source),source,{text:"Find the mast decision."});
  await expect.poll(()=>s.button("Send")?.hasAttribute("disabled")).toBe(false);
  await userEvent.click(s.button("Send"));
  const sent=s.socket.frames("chat_message").at(-1)!;expect(sent).toBeDefined();
  flushSync(()=>s.ui.stores.chat.getState().setActiveSession(SESSION));
  s.deliver({type:"session_info",sessionId:"odysseus-foreign",requestId:"odysseus-foreign-request",isNew:false});
  flushSync(()=>s.ui.stores.chat.getState().setActiveSession("odysseus-foreign"));
  expect(s.client.state.getState().unassignedWork).toBe(0);
  flushSync(()=>s.ui.stores.chat.getState().setActiveSession(SESSION));
  if(acceptance==="session_info")s.deliver({type:"session_info",sessionId:target,requestId:String(sent.requestId),isNew:true});
  else if(acceptance==="queued")s.deliver({type:"status",sessionId:target,requestId:String(sent.requestId),status:"queued"});
  else if(acceptance==="queue_report")s.deliver({type:"session_queue",sessionId:target,followUps:[{id:"odysseus-queued-entry",requestId:String(sent.requestId),text:"Find the mast decision.",source:"typed",queuedAt:1}]});
  else s.deliver({type:"error",sessionId:source,requestId:String(sent.requestId),code:"CHAT_REFUSED",message:"Fixture refusal."});
  flushSync(()=>s.ui.stores.chat.getState().setActiveSession(target));
  expect(s.client.state.getState().unassignedWork).toBe(acceptance==="refusal"?0:1);
  flushSync(()=>s.ui.stores.chat.getState().setActiveSession(source));
  expect(s.client.state.getState().unassignedWork).toBe(acceptance==="refusal"?1:0);
  expect(s.socket.frames("chat_message")).toHaveLength(1);expect(s.socket.frames("conversation_commit")).toHaveLength(0);
});

for(const rotate of [false,true])test(`composer consumption preserves origin before retirement, rotate=${rotate}`,async ctx=>{
 const s=await scene(ctx);flushSync(()=>s.ui.stores.chat.getState().setActiveSession(null));
 const d=s.ui.stores.drafts.getState(), origin=d.idFor(null);
 d.edit(origin,null,{text:"Find the mast decision."});d.setSupport(true);
 const before=s.ui.stores.drafts.getState().drafts[origin]!;
 d.saved(origin,{revision:1,edit:before.edit,sessionId:null,attachmentIds:[],updatedAt:1},new Map());
 await s.start();s.event({kind:"unassigned_delegation",handle:"odysseus-consume",offsetMs:1});s.client.leave();d.setSupport(true);
 await expect.poll(()=>s.button("Send")?.hasAttribute("disabled")).toBe(false);await userEvent.click(s.button("Send"));
 const sent=s.socket.frames("chat_message").at(-1)!;expect(sent.draftRef).toBeDefined();
 if(rotate)d.edit(origin,null,{text:"Keep the next watch note."});
 flushSync(()=>s.ui.stores.chat.getState().setActiveSession(SESSION));
 s.deliver({type:"session_info",sessionId:"odysseus-consumed",requestId:String(sent.requestId),draftId:String(sent.draftId),isNew:true});
 expect(s.ui.stores.drafts.getState().drafts[origin]).toBeUndefined();
 flushSync(()=>s.ui.stores.chat.getState().setActiveSession("odysseus-consumed"));
 expect(s.client.state.getState().unassignedWork).toBe(1);
 s.deliver({type:"session_info",sessionId:"odysseus-duplicate-foreign",requestId:String(sent.requestId),isNew:true});
 flushSync(()=>s.ui.stores.chat.getState().setActiveSession("odysseus-duplicate-foreign"));expect(s.client.state.getState().unassignedWork).toBe(0);
 flushSync(()=>s.ui.stores.chat.getState().setActiveSession("odysseus-consumed"));expect(s.client.state.getState().unassignedWork).toBe(1);
 expect(s.socket.frames("chat_message")).toHaveLength(1);expect(s.socket.frames("conversation_commit")).toHaveLength(0);
});

for(const [knownTurn,reenter] of [[true,false],[false,false],[true,true]] as const)test(`contextual task identity arriving after Leave preserves known queued ownership, turn known=${knownTurn}, reenter=${reenter}`,async ctx=>{
 const s=await scene(ctx);flushSync(()=>s.ui.stores.chat.getState().setActiveSession(null));
 await s.start();s.event({kind:"unassigned_delegation",handle:"odysseus-queued-notice",offsetMs:1});
 s.opened(2,{...CAPS,contextualTasks:"supported"},{sessionId:undefined});s.client.start();
 await expect.poll(()=>s.client.state.getState().micOn).toBe(true);
 const task={type:"conversation_work" as const,conversationId:PROFILE.conversationId,epoch:2,provenance:"contextual" as const,taskId:"odysseus-late-task",nativeHandle:"odysseus-late-handle",requestId:"odysseus-late-request",delivery:"pending" as const,recognized:"Find the mast note.",submitted:"Find the mast note."};
 s.deliver({...task,...(knownTurn?{state:"running" as const,turnId:"odysseus-late-turn"}:{state:"queued" as const})});
 expect(s.client.state.getState().work[task.requestId]?.taskId).toBe(task.taskId);
 expect(s.client.state.getState().unassignedWork).toBe(1);
 s.client.leave();flushSync(()=>s.ui.stores.chat.getState().setActiveSession(SESSION));
 if(reenter) { s.client.enter(); expect(s.client.state.getState().active).toBe(true); }
 // The server sent these in order; they arrive after the client pressed Leave.
 s.deliver({...task,state:"running",turnId:"odysseus-late-turn"});
 s.deliver({type:"session_info",sessionId:"odysseus-context-native",requestId:task.requestId,turnId:"odysseus-late-turn",isNew:true});
 expect(s.ui.stores.chat.getState().activeSessionId).toBe(SESSION);
 flushSync(()=>s.ui.stores.chat.getState().setActiveSession("odysseus-context-native"));
 expect.soft(s.client.state.getState().unassignedWork,"LATE_RUNNING_RECEIPT_BINDS_ALREADY_KNOWN_TASK").toBe(1);
 expect(s.socket.frames("conversation_commit")).toHaveLength(0);expect(s.socket.frames("chat_message")).toHaveLength(0);
});

// Known host work outlives the voice entry, but never introduces new inactive
// identities or lets an evicted, foreign, replayed or prior-principal frame bind.
test("late contextual correlation is bounded, exact and cleared with its principal", async ctx => {
  const s = await scene(ctx);
  flushSync(() => s.ui.stores.chat.getState().setActiveSession(null));
  await s.start();
  s.event({ kind: "unassigned_delegation", handle: "odysseus-bounded-notice", offsetMs: 1 });
  s.opened(2, { ...CAPS, contextualTasks: "supported" }, { sessionId: undefined });
  s.client.start();
  await expect.poll(() => s.client.state.getState().micOn).toBe(true);
  const task = (i: number) => ({ type: "conversation_work" as const, conversationId: PROFILE.conversationId, epoch: 2,
    provenance: "contextual" as const, taskId: `odysseus-task-${i}`, nativeHandle: `odysseus-handle-${i}`, requestId: `odysseus-request-${i}`,
    delivery: "pending" as const, recognized: "Find the mast note.", submitted: "Find the mast note." });
  for (let i = 0; i < 130; i++) s.deliver({ ...task(i), state: "queued" });
  s.client.leave();
  flushSync(() => s.ui.stores.chat.getState().setActiveSession(SESSION));
  const identity = (requestId: string, turnId: string, sessionId: string) => s.deliver({ type: "session_info", requestId, turnId, sessionId, isNew: true });
  for (const i of [0, 1, 130]) {
    s.deliver({ ...task(i), state: "running", turnId: `odysseus-turn-${i}` });
    identity(task(i).requestId, `odysseus-turn-${i}`, "odysseus-unproven-native");
  }
  const retained = task(2); // Exactly the oldest of the 128 retained identities.
  for (const changed of [{ conversationId: "odysseus-foreign-conversation" }, { epoch: 1 }, { taskId: "odysseus-foreign-task" }, { nativeHandle: "odysseus-foreign-handle" }]) {
    s.deliver({ ...retained, ...changed, state: "running", turnId: "odysseus-foreign-turn" });
    identity(retained.requestId, "odysseus-foreign-turn", "odysseus-unproven-native");
  }
  expect(s.ui.stores.chat.getState().activeSessionId).toBe(SESSION);
  flushSync(() => s.ui.stores.chat.getState().setActiveSession("odysseus-unproven-native"));
  expect(s.client.state.getState().unassignedWork, "UNKNOWN_EVICTED_AND_FOREIGN_WORK_CANNOT_BIND").toBe(0);
  flushSync(() => s.ui.stores.chat.getState().setActiveSession(SESSION));
  s.deliver({ ...retained, state: "running", turnId: "odysseus-retained-turn" });
  s.deliver({ ...retained, state: "running", turnId: "odysseus-foreign-turn" });
  identity(retained.requestId, "odysseus-foreign-turn", "odysseus-unproven-native");
  flushSync(() => s.ui.stores.chat.getState().setActiveSession("odysseus-unproven-native"));
  expect(s.client.state.getState().unassignedWork, "KNOWN_TURN_CANNOT_BE_REPLACED").toBe(0);
  flushSync(() => s.ui.stores.chat.getState().setActiveSession(SESSION));
  identity(retained.requestId, "odysseus-retained-turn", "odysseus-bounded-native");
  expect(s.ui.stores.chat.getState().activeSessionId).toBe(SESSION);
  expect(s.client.state.getState().micOn).toBe(false);
  flushSync(() => s.ui.stores.chat.getState().setActiveSession("odysseus-bounded-native"));
  expect(s.client.state.getState().unassignedWork, "OLDEST_RETAINED_CONTEXTUAL_IDENTITY_STILL_BINDS").toBe(1);
  identity(retained.requestId, "odysseus-retained-turn", "odysseus-replayed-native");
  flushSync(() => s.ui.stores.chat.getState().setActiveSession("odysseus-replayed-native"));
  expect(s.client.state.getState().unassignedWork, "BOUND_CONTEXTUAL_NOTICE_CANNOT_RETARGET").toBe(0);
  flushSync(() => s.ui.stores.chat.getState().setActiveSession("odysseus-bounded-native"));
  await s.ui.authLock.expire("signed out", true);
  s.client.frame({ ...retained, state: "running", turnId: "odysseus-retained-turn" });
  s.client.frame({ type: "session_info", sessionId: "odysseus-bounded-native", requestId: retained.requestId, turnId: "odysseus-retained-turn", isNew: true } as ServerMessage & { turnId: string });
  expect(s.client.state.getState().unassignedWork, "LATE_CONTEXTUAL_IDENTITY_CANNOT_SURVIVE_AUTH_CLEAR").toBe(0);
  expect(s.socket.frames("conversation_commit")).toHaveLength(0);
  expect(s.socket.frames("chat_message")).toHaveLength(0);
});

/* ── The tall voice field (#3699): each live state from the client's own evidence ── */

function field(s: Awaited<ReturnType<typeof scene>>) {
  const root = () => s.host.querySelector<HTMLElement>("[data-conversation-field]");
  return {
    state: () => root()?.dataset.liveState,
    word: () => root()?.querySelector("[data-voice-word]")?.textContent,
    control: (name: string) => root()?.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`) ?? null,
    controls: () => [...root()?.querySelectorAll(".bk-voice-field button") ?? []].map(node => node.getAttribute("aria-label")),
    text: () => root()?.querySelector(".bk-voice-field")?.textContent ?? "",
  };
}
/** Interrupt is live only while brain's reply plays (L4), in every state. */
function interruptOnlyInL4(f: ReturnType<typeof field>) {
  const interrupt = f.control("Interrupt");
  if (interrupt) expect(interrupt.disabled, `INTERRUPT_ONLY_IN_L4 (${f.state()})`).toBe(f.state() !== "L4");
}
const PCM24 = { encoding: "pcm16", channels: 1, sampleRate: 24000 } as const;

/** Three seconds of brain's voice, in the one-second chunks the wire carries. */
function speech(s: Awaited<ReturnType<typeof scene>>, outputId: string) {
  for (let sequence = 0; sequence < 3; sequence++) s.event({ kind: "audio", outputId, sequence, pcm: outputPcm(1), format: PCM24 });
}

test("live field: Listening, Speaking, Talked over, Muted and End follow real capture and playback", async (ctx) => {
  const mic = controlledMicrophone(ctx, true);
  const s = await scene(ctx); const f = field(s);
  await s.enter();
  expect(s.host.querySelector("[data-conversation-field]")!.getAttribute("data-live-state"), "no live field before Start").toBe(null);
  expect([...s.host.querySelectorAll(".bk-voice-field")].every(node => node.closest("[data-start-card]")), "the Start card is the only surface before Start").toBe(true);
  await userEvent.click(s.button("Start"));
  await expect.poll(f.state).toBe("L1");
  expect(f.word()).toBe("Listening");
  expect(f.controls()).toEqual(["Mute", "Interrupt", "End"]);
  expect(f.text(), "the field names the service and the connected time, nothing more").toMatch(/^Listening\s*GPT-Live · \d+:\d\d$/);
  interruptOnlyInL4(f);
  await expect.poll(() => s.client.levels().input, { message: "the meter reads the real microphone level" }).toBeGreaterThan(0);
  await userEvent.click(f.control("Mute")!);
  await expect.poll(f.state).toBe("L7");
  expect(f.control("Unmute")!.getAttribute("aria-pressed")).toBe("true");
  interruptOnlyInL4(f);
  // V5: Mute stops your microphone only; brain may finish its sentence.
  speech(s, "ithaca-reply");
  await expect.poll(f.state).toBe("L4");
  expect(f.control("Unmute")!.getAttribute("aria-pressed"), "muted while brain speaks").toBe("true");
  expect(s.client.state.getState().micOn).toBe(false);
  interruptOnlyInL4(f);
  await expect.poll(() => s.client.levels().output, { message: "the meter reads what plays" }).toBeGreaterThan(0);
  await userEvent.click(f.control("Interrupt")!);
  await expect.poll(f.state).toBe("L7");
  interruptOnlyInL4(f);
  // Talking over brain cuts it and gives you the floor (L5), then Listening again.
  await expect.poll(() => s.client.state.getState().outputRecovery, { message: "the local quiet check ends" }).toBe("audible");
  speech(s, "ithaca-tail");
  await expect.poll(f.state).toBe("L4");
  await userEvent.click(f.control("Unmute")!);
  await expect.poll(f.state).toBe("L5");
  expect(f.word()).toBe("Listening");
  interruptOnlyInL4(f);
  mic.quiet();
  await expect.poll(f.state, { timeout: 5000 }).toBe("L1");
  await userEvent.click(f.control("End")!);
  expect(s.client.state.getState().active).toBe(false);
  await expect.poll(() => s.host.querySelector("textarea[data-composer]"), { message: "End returns the composer (L10)" }).not.toBe(null);
  expect(s.host.querySelector("[data-conversation-field]")).toBe(null);
});

test("live field: Connecting, Working and Needs your tap; an approval stays tap-only", async (ctx) => {
  controlledMicrophone(ctx);
  const s = await scene(ctx); const f = field(s);
  s.client.enter(); s.client.start();
  await expect.poll(f.state).toBe("S5");
  expect(f.word()).toBe("Connecting");
  expect(f.control("Mute")!.disabled, "nothing to mute while connecting").toBe(true);
  interruptOnlyInL4(f);
  s.opened();
  await expect.poll(f.state).toBe("L1");
  await expect.poll(() => s.socket.frames("conversation_audio").length).toBeGreaterThan(0);
  s.deliver({ type: "text_delta", sessionId: SESSION, turnId: "ithaca-permission", text: "Checking the raft plan" });
  await expect.poll(f.state, { message: "host work is Working" }).toBe("L3");
  interruptOnlyInL4(f);
  approval(s, "ithaca-tap");
  await expect.poll(f.state).toBe("L6");
  expect(f.word()).toBe("Needs your tap");
  expect(f.controls(), "L6_NO_VOICE_GRANT: the field offers no way to approve").toEqual(["Mute", "Interrupt", "End"]);
  expect(f.text(), "L6_NO_VOICE_GRANT: the body directs to the card and offers nothing to say").toMatch(/^Needs your tapGPT-Live · \d+:\d\dTap Allow or Deny on the card\. Voice can’t approve or refuse with this service\.$/);
  interruptOnlyInL4(f);
  recognition(s, "yes, allow it");
  expect(s.socket.frames("tool_approval"), "speech never approves").toHaveLength(0);
  await userEvent.click(page.getByRole("button", { name: /^Allow/ }));
  expect(s.socket.frames("tool_approval")).toHaveLength(1);
  expect(s.socket.frames("tool_approval")[0]?.channel ?? "card").toBe("card");
  await expect.poll(f.state, { message: "the tap answers it; the field leaves L6" }).not.toBe("L6");
});

test("live field: a held draft takes the body and Interrupt's place unless brain speaks (R1)", async (ctx) => {
  const mic = controlledMicrophone(ctx, true);
  const s = await scene(ctx, 320); const f = field(s);
  await s.start();
  const meta = () => s.host.querySelector("[data-conversation-field] .bk-voice-label-meta")?.textContent;
  const body = () => s.host.querySelector("[data-conversation-field] [data-voice-text]")?.textContent;
  const audio = s.socket.frames("conversation_audio").at(-1)!;
  // A calibrated low score holds the words for review; they are the draft.
  s.event({ kind: "input_fragment", utteranceId: String(audio.utteranceId), sequence: 0, text: "Ask Calypso when the axe is back", finalization: "final", certainty: "known", origin: "user", confidence: 0.5 });
  await expect.poll(body).toBe("Ask Calypso when the axe is back");
  expect(meta()).toBe("Draft · not sent yet");
  expect(f.state()).toBe("L1");
  expect(f.controls(), "DRAFT_HIDES_INTERRUPT").toEqual(["Mute", "Discard draft", "Send now", "End"]);
  // V5: muted, brain may still finish its sentence.
  await userEvent.click(f.control("Mute")!);
  speech(s, "ithaca-axe");
  await expect.poll(f.state).toBe("L4");
  expect(f.controls(), "L4 with a draft carries five controls").toEqual(["Unmute", "Interrupt", "Discard draft", "Send now", "End"]);
  interruptOnlyInL4(f);
  const frame = s.host.querySelector<HTMLElement>(".bk-voice-field")!.getBoundingClientRect();
  for (const name of f.controls()) {
    const box = f.control(name!)!.getBoundingClientRect();
    expect(box.width, `${name} keeps a 44px target`).toBeGreaterThanOrEqual(44);
    expect(box.right, `${name} fits the 320px row`).toBeLessThanOrEqual(frame.right + 0.5);
  }
  expect(body(), "brain speaking does not hide the draft").toBe("Ask Calypso when the axe is back");
  await page.screenshot({ element: s.host, path: "../../.vitest-attachments/conversation/draft-speaking-320.png" });
  await userEvent.click(f.control("Interrupt")!);
  await expect.poll(f.state).toBe("L7");
  expect(f.controls(), "DRAFT_HIDES_INTERRUPT").toEqual(["Unmute", "Discard draft", "Send now", "End"]);
  await userEvent.click(f.control("Unmute")!);
  await expect.poll(() => s.client.state.getState().micOn).toBe(true);
  await userEvent.click(f.control("Discard draft")!);
  expect(s.client.state.getState().text).toBe("");
  expect(s.socket.frames("conversation_commit"), "Discard sends nothing").toHaveLength(0);
  await expect.poll(f.controls).toEqual(["Mute", "Interrupt", "End"]);
  expect(meta()).toMatch(/^GPT-Live · \d+:\d\d$/);
  // Unproven origin: the draft's body says it was unclear, and Send now stays explicit.
  await expect.poll(() => s.socket.frames("conversation_audio").length).toBeGreaterThan(0);
  mic.quiet();
  await expect.poll(() => s.client.state.getState().outputRecovery, { message: "the local quiet check ends", timeout: 6000 }).toBe("audible");
  s.input("Tally the cask");
  await expect.poll(body).toBe("I couldn't hear that clearly. Review before sending.");
  expect(meta()).toBe("Draft · not sent yet");
  await userEvent.click(f.control("Send now")!);
  await expect.poll(() => s.socket.frames("conversation_commit").length).toBe(1);
  expect(s.socket.frames("conversation_commit")[0]?.text).toBe("Tally the cask");
});

for (const [count, copy] of [[12, "Started with the last 12 messages"], [1, "Started with the last 1 message"]] as const) test(`coverage (R2): the host's count of ${count} sent messages opens the live section in the chat`, async (ctx) => {
  controlledMicrophone(ctx);
  const s = await scene(ctx, 320, true);
  s.client.enter(); s.client.start();
  s.opened(1, CAPS, { historyCoverage: { state: "complete", tailOmitted: false, includedMessages: count } });
  await expect.poll(() => s.client.state.getState().profile?.historyCoverage?.includedMessages, { message: "the wire field survives validation" }).toBe(count);
  const notice = () => s.host.querySelector<HTMLElement>("[data-voice-coverage]");
  await expect.poll(() => notice()?.textContent, { message: "VOICE_COVERAGE_COUNT_COPY" }).toBe(`${copy} · Details`);
  expect(notice()!.closest("[data-conversation-field]"), "a chat notice, not a row above the field").toBe(null);
  expect(notice()!.closest("[data-arrival-key]")).not.toBe(null);
  await userEvent.click(s.button("Prior context details"));
  await expect.poll(() => s.client.state.getState().disclosureOpen, { message: "Details opens the existing sheet" }).toBe(true);
});

test("live field: Reconnecting while recovery runs, Stopped only when it fails, Start again reopens Start", async (ctx) => {
  controlledMicrophone(ctx, true);
  const s = await scene(ctx); const f = field(s);
  await s.start();
  s.network.drop({ announce: true });
  await expect.poll(f.state).toBe("L8");
  expect(f.word()).toBe("Reconnecting…");
  expect(s.client.state.getState().capture, "recovery keeps consent").toBe("listening");
  interruptOnlyInL4(f);
  s.network.recover(); s.ui.connection.reconnectNow();
  await expect.poll(() => s.network.socket() !== s.socket && s.ui.stores.connection.getState().wsStatus === "connected").toBe(true);
  const replacement = s.network.socket()!;
  await expect.poll(() => replacement.frames("conversation_start").length).toBe(1);
  replacement.deliver({ ...PROFILE, epoch: 2, requestId: replacement.frames("conversation_start").at(-1)?.requestId });
  replacement.deliver({ type: "conversation_event", conversationId: PROFILE.conversationId, epoch: 2, event: { kind: "ready", input: PCM24, output: PCM24 } });
  await expect.poll(f.state, { message: "recovery returns to Listening" }).toBe("L1");
  replacement.deliver({ type: "error", code: "CONVERSATION_UNKNOWN", message: "Voice scope is unavailable." });
  await expect.poll(f.state).toBe("L9");
  const stopped = s.host.querySelector<HTMLElement>("[data-conversation-field]")!;
  expect(stopped.textContent).toContain("Live conversation stopped");
  expect(stopped.textContent, "the client's own reason, no more").toContain("Voice scope is unavailable.");
  expect(s.client.state.getState().micOn).toBe(false);
  await userEvent.click(s.button("Start again"));
  await expect.poll(() => s.client.state.getState().disclosureOpen, { message: "Start again leads to the Start card" }).toBe(true);
  expect([...s.host.querySelectorAll(".bk-voice-field")].map(node => !!node.closest("[data-start-card]")), "only the Start card draws").toEqual([true]);
  expect(s.client.state.getState().micOn).toBe(false);
  await userEvent.click(s.button("Cancel"));
  expect(s.client.state.getState().active).toBe(false);
});
