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
  Object.defineProperty(media, "getUserMedia", { configurable: true, writable: true, value: async () => destination.stream });
  ctx.onTestFinished(() => { if (descriptor) Object.defineProperty(media, "getUserMedia", descriptor); else Reflect.deleteProperty(media, "getUserMedia"); oscillator.stop(); void context.close(); });
  return { quiet: () => { gain.gain.value = 0; }, speak: () => { gain.gain.value = 0.15; }, stream: destination.stream };
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
  const audio: ConversationWireEvent = { kind: "audio", outputId: "ithaca-quiet", sequence: 0, pcm: btoa(String.fromCharCode(...new Uint8Array(24_000))), format: { encoding: "pcm16", channels: 1, sampleRate: 24000 } };
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

test("barge-in from actual PCM speech cuts output and leaves capture off until host resync", async (ctx) => {
  const mic = controlledMicrophone(ctx);
  const s = await scene(ctx); await s.start(); mic.quiet();
  await expect.poll(() => s.socket.frames("conversation_endpoint").length).toBe(1);
  s.event({ kind: "audio", outputId: "ithaca-barge", sequence: 0, pcm: btoa(String.fromCharCode(...new Uint8Array(48_000))), format: { encoding: "pcm16", channels: 1, sampleRate: 24000 } });
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
