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
    ctx.onTestFinished(async () => { await page.viewport(viewport.width, viewport.height); await commands.formViewport(outer.width, outer.height); });
  }
  const network = installFaultNetwork({ routes: (url) => url.pathname.endsWith("/sessions") ? Response.json({ sessions: [] }) : undefined,
    onOpen(socket) { socket.deliver({ type: "server_hello", protocolRev: 5, principalKey: "odysseus-principal", capabilities: { askReceipts: true, liveConversation: true, conversationPause: true, toolResolution: true, chatRequestAck: true } }); socket.deliver({ type: "session_info", sessionId: SESSION, isNew: false }); socket.deliver({ type: "session_history", sessionId: SESSION, messages: [] }); socket.deliver({ type: "status", sessionId: SESSION, status: "idle" }); } });
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
  const opened = (epoch = 1, caps = CAPS) => { socket.deliver({ ...PROFILE, epoch, capabilities: caps, requestId: socket.frames("conversation_start").at(-1)?.requestId }); event({ kind: "ready", input: { encoding: "pcm16", channels: 1, sampleRate: 24000 }, output: { encoding: "pcm16", channels: 1, sampleRate: 24000 } }, epoch); };
  const enter = async () => { flushSync(() => client.enter()); opened(); await expect.poll(() => button("Start")).not.toBeUndefined(); };
  const start = async () => { await enter(); await userEvent.click(button("Start")); await expect.poll(() => client.state.getState().micOn).toBe(true); await expect.poll(() => socket.frames("conversation_audio").length, { timeout: 5000 }).toBeGreaterThan(0); };
  const input = (text: string, finalization: "final" | "unknown" | "interim" = "unknown", epoch?: number) => {
    const audio = socket.frames("conversation_audio").at(-1)!;
    event({ kind: "input_fragment", utteranceId: String(audio.utteranceId), sequence: 0, text, finalization, certainty: "unknown", origin: "unknown" }, epoch);
  };
  return { ui, client, host, socket, deliver, network, button, event, opened, enter, start, input };
}

test("capture truth and disclosure: a ready speech session cannot mark an unopened microphone on", async (ctx) => {
  const s = await scene(ctx);
  await s.enter();
  expect(s.client.state.getState().micOn).toBe(false);
  expect(s.socket.frames("conversation_audio")).toHaveLength(0);
  expect(document.body.textContent).toContain("Host relay:");
  expect(document.body.textContent).toContain("Independently selected agent backend:");
  await userEvent.click(s.button("Start"));
  await expect.poll(() => s.client.state.getState().micOn).toBe(true);
  await expect.poll(() => s.socket.frames("conversation_audio").length, { timeout: 5000 }).toBeGreaterThan(0);
  expect(document.activeElement?.getAttribute("aria-label")).toBe("Mute mic");
});

test("commit only: GPT-Live fragments remain NOT SENT while ordinary progress and tools keep streaming", async (ctx) => {
  const s = await scene(ctx);
  await s.start();
  s.input("Find the departure note");
  expect(s.socket.frames("conversation_commit"), "unknown fragments cannot commit themselves").toHaveLength(0);
  await expect.poll(() => s.host.textContent).toContain("NOT SENT");
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

function controlledMicrophone(ctx: TestContext) {
  const context = new AudioContext();
  const oscillator = context.createOscillator();
  const gain = context.createGain(); gain.gain.value = 0.15;
  const destination = context.createMediaStreamDestination();
  oscillator.connect(gain); gain.connect(destination); oscillator.start(); void context.resume();
  const media = navigator.mediaDevices;
  const descriptor = Object.getOwnPropertyDescriptor(media, "getUserMedia");
  let opens = 0;
  Object.defineProperty(media, "getUserMedia", { configurable: true, writable: true, value: async () => { opens++; return destination.stream; } });
  ctx.onTestFinished(() => { if (descriptor) Object.defineProperty(media, "getUserMedia", descriptor); else Reflect.deleteProperty(media, "getUserMedia"); oscillator.stop(); void context.close(); });
  return { opens: () => opens, quiet: () => { gain.gain.value = 0; }, speak: () => { gain.gain.value = 0.15; }, stream: destination.stream };
}

for (const ending of ["leave", "hide", "disconnect"] as const) test(`${ending}: capture closes synchronously, finalized text stays with its original draft, and reconnect never opens it`, async (ctx) => {
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
  s.client.state.setState({ profile: { ...PROFILE, capabilities: { ...CAPS, finalTranscript: "supported" } } });
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

test("barge-in flush: Stop reply discards every queued PCM chunk and blocks replacement input until resync", async (ctx) => {
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
  await userEvent.click(s.button("Stop reply"));
  expect(s.client.state.getState().playing).toBe(false);
  expect(ended).toHaveLength(3);
  await expect.poll(() => ended.every(Boolean), { timeout: 500, message: "every real scheduled audio source ended at the cut, including future chunks" }).toBe(true);
  expect(s.client.state.getState().micOn).toBe(false);
  expect(s.client.state.getState().interaction).toBe("Checking whether the reply stopped");
  expect(s.socket.frames("conversation_playback").at(-1)?.playback).toBe("unknown");
  expect(s.client.state.getState().outputs[0]?.playback).toBe("unknown");
  s.event({ kind: "audio", outputId: "late-reply", sequence: 0, format: { encoding: "pcm16", sampleRate: 24000, channels: 1 }, pcm: btoa(binary) });
  expect(s.client.state.getState().playing).toBe(false);
  expect(s.client.commit(s.client.state.getState().token)).toBe(false);
  await expect.poll(() => s.host.textContent).toContain("spoken portion unknown");
});

test("terminal: an unanswered card becomes inert without tool_result", async (ctx) => {
  const s = await scene(ctx); await s.start(); s.client.mute();
  s.deliver({ type: "text_delta", sessionId: SESSION, turnId: "ithaca-turn", text: "Checking the route" });
  s.deliver({ type: "ask_user_request", sessionId: SESSION, turnId: "ithaca-turn", requestId: "ithaca-question", questions: [{ question: "Which day?", header: "Day", multiSelect: false, options: [{ label: "Tomorrow", description: "Before departure" }] }] });
  await expect.poll(() => s.host.querySelector('[data-ask-waiting]')).not.toBe(null);
  s.deliver({ type: "result", sessionId: SESSION, turnId: "ithaca-turn", isError: false, durationMs: 100, numTurns: 1 });
  await expect.poll(() => s.host.querySelector('[data-ask-waiting]')).toBe(null);
  await expect.poll(() => s.host.textContent).toContain("no longer waiting");
  expect(s.ui.stores.chat.getState().buffers[SESSION]?.askUser?.terminal).toBe(true);
});

test("epoch guard: stale transcript and an old Send callback cannot consume a new epoch's review candidate", async (ctx) => {
  const s = await scene(ctx); await s.start(); s.input("Old departure note");
  const oldToken = s.client.state.getState().token;
  const oldId = String(s.socket.frames("conversation_audio").at(-1)!.utteranceId);
  s.client.stopReply();
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
  const strip = s.host.querySelector<HTMLElement>('[data-conversation-strip]')!;
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
  s.client.state.setState({ profile: { ...PROFILE, capabilities: { ...CAPS, finalTranscript: "supported" } } });
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
  s.socket.deliver({ ...PROFILE, resync: { work: receipt === "work" ? 1 : 0, outputs: receipt === "output" ? 1 : 0 }, requestId: s.socket.frames("conversation_start").at(-1)?.requestId });
  await expect.poll(() => s.button("Start")).not.toBeUndefined();
  await userEvent.click(s.button("Start"));
  expect(s.client.state.getState().micOn).toBe(false);
  expect(s.client.state.getState().notice).toContain("Waiting for voice readiness");
  s.event({ kind: "ready", input: { encoding: "pcm16", channels: 1, sampleRate: 24000 }, output: { encoding: "pcm16", channels: 1, sampleRate: 24000 } });
  expect(s.client.state.getState().notice).toContain("Synchronizing voice");
  if (receipt === "output") s.deliver({ type: "conversation_output", conversationId: PROFILE.conversationId, epoch: 1, outputId: "ithaca-old", generated: "Earlier reply", playback: "unknown" });
  else s.deliver({ type: "conversation_work", conversationId: PROFILE.conversationId, epoch: 1, utteranceId: "ithaca-old-input", requestId: "ithaca-old-work", state: "completed", delivery: "returned", recognized: "Find the departure note", submitted: "Find the departure note" });
  await expect.poll(() => s.client.state.getState().micOn).toBe(true);
  expect(s.client.state.getState().notice).toBe("");
});

test("barge-in from actual PCM speech cuts output and leaves capture off until host resync", async (ctx) => {
  const mic = controlledMicrophone(ctx);
  const s = await scene(ctx); await s.start(); mic.quiet();
  await expect.poll(() => s.socket.frames("conversation_endpoint").length).toBe(1);
  s.event({ kind: "audio", outputId: "ithaca-barge", sequence: 0, pcm: outputPcm(), format: { encoding: "pcm16", channels: 1, sampleRate: 24000 } });
  await expect.poll(() => s.client.state.getState().playing).toBe(true);
  mic.speak();
  await expect.poll(() => s.client.state.getState().playing).toBe(false);
  expect(s.client.state.getState().micOn).toBe(false);
  expect(s.client.state.getState().interaction).toBe("Checking whether the reply stopped");
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
  s.client.enter();
  const old = String(s.socket.frames("conversation_start")[0]?.requestId);
  s.client.leave(); s.client.enter();
  expect(s.socket.frames("conversation_start")).toHaveLength(1);
  s.socket.deliver({ ...PROFILE, requestId: old });
  await expect.poll(() => s.socket.frames("conversation_start").length).toBe(2);
  expect(s.client.state.getState().micOn).toBe(false);
  expect(s.socket.frames("conversation_stop").at(-1)?.conversationId).toBe(PROFILE.conversationId);
  s.opened();
  expect(s.client.state.getState().disclosureOpen).toBe(true);
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
  s.client.enter();
  s.socket.deliver({ ...PROFILE, conversationId: "ithaca-replacement", requestId: s.socket.frames("conversation_start").at(-1)?.requestId });
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
  const strip = s.host.querySelector<HTMLElement>('[data-conversation-strip]')!;
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
  s.client.stopReply(); s.client.resume(); s.opened(2);
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
  await expect.poll(() => s.client.state.getState().notice).toContain("Microphone permission denied");
  expect(s.client.state.getState().micOn).toBe(false);
  await expect.poll(() => s.host.textContent).toContain("Microphone permission denied");
  s.client.mute();
  s.event({ kind: "ready", input: { encoding: "pcm16", channels: 1, sampleRate: 24000 }, output: { encoding: "pcm16", channels: 1, sampleRate: 24000 } });
  expect(calls).toBe(1);
  expect(s.client.state.getState().notice).toContain("Microphone muted");
});

test("mute while awaiting readiness withdraws Start consent", async (ctx) => {
  const s = await scene(ctx); s.client.enter();
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
  s.client.stopReply();
  s.client.resume();
  s.socket.deliver({ ...PROFILE, epoch: 2, disclosure: { voiceService: "Changed Odysseus voice fixture", destinations: ["Changed fixture destination. Retention: unknown."] }, requestId: s.socket.frames("conversation_start").at(-1)?.requestId });
  s.event({ kind: "ready", input: { encoding: "pcm16", channels: 1, sampleRate: 24000 }, output: { encoding: "pcm16", channels: 1, sampleRate: 24000 } }, 2);
  expect(s.client.state.getState().disclosureOpen).toBe(true);
  expect(s.client.state.getState().micOn).toBe(false);
  expect(mic.opens()).toBe(1);
  expect(s.client.state.getState().notice).toContain("Review the voice service disclosure");
});

test("reconnect and its ready event keep capture closed until explicit Resume", async (ctx) => {
  const mic = controlledMicrophone(ctx);
  const s = await scene(ctx); await s.start();
  s.network.drop({ announce: true });
  await expect.poll(() => s.client.state.getState().micOn).toBe(false);
  s.network.recover(); s.ui.connection.reconnectNow();
  await expect.poll(() => s.network.socket() !== s.socket && s.ui.stores.connection.getState().wsStatus === "connected").toBe(true);
  const replacement = s.network.socket()!;
  await expect.poll(() => replacement.frames("conversation_start").length).toBe(1);
  replacement.deliver({ ...PROFILE, epoch: 2, requestId: replacement.frames("conversation_start").at(-1)?.requestId });
  replacement.deliver({ type: "conversation_event", conversationId: PROFILE.conversationId, epoch: 2, event: { kind: "ready", input: { encoding: "pcm16", channels: 1, sampleRate: 24000 }, output: { encoding: "pcm16", channels: 1, sampleRate: 24000 } } });
  expect(s.client.state.getState().micOn).toBe(false);
  expect(mic.opens()).toBe(1);
  s.client.resume();
  expect(mic.opens()).toBe(2);
});

for (const reason of ["stopped", "replaced"] as const) test(`Resume before the old epoch's ${reason} receipt keeps the replacement opening and mic consent`, async (ctx) => {
  const mic = controlledMicrophone(ctx);
  const s = await scene(ctx); await s.start();
  const previousRequest = s.socket.frames("conversation_start")[0]?.requestId;
  s.client.stopReply(); s.client.resume();
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
