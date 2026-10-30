/// <reference types="@vitest/browser-playwright" />
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
  const network = installFaultNetwork({ routes: (url) => url.pathname.endsWith("/sessions") ? Response.json({ sessions: [] }) : undefined,
    onOpen(socket) { socket.deliver({ type: "server_hello", protocolRev: 5, principalKey: "odysseus-principal", capabilities: { askReceipts: true, liveConversation: true, conversationPause: true, toolResolution: true, chatRequestAck: true } }); socket.deliver({ type: "session_info", sessionId: SESSION, isNew: false }); socket.deliver({ type: "session_history", sessionId: SESSION, messages: [] }); socket.deliver({ type: "status", sessionId: SESSION, status: "idle" }); } });
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
  const opened = (epoch = 1, caps = CAPS) => { socket.deliver({ ...PROFILE, epoch, capabilities: caps, requestId: socket.frames("conversation_start").at(-1)?.requestId }); event({ kind: "ready", input: { encoding: "pcm16", channels: 1, sampleRate: 24000 }, output: { encoding: "pcm16", channels: 1, sampleRate: 24000 } }, epoch); };
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



// Real AudioWorklet capture and playback exercise the interval before the
// natural 700 ms endpoint. Provider frames remain entirely offline.
for (const action of ["send", "discard", "answer", "mute"] as const) for (const noisy of [false, true]) test(`manual ${action}: ${noisy ? "bounded noisy deadline" : "quiet recovery"} after interrupted speech`, async ctx => {
  const mic = controlledMicrophone(ctx, true);
  const s = await scene(ctx); await s.start(); mic.quiet();
  await expect.poll(() => s.socket.frames("conversation_endpoint").length).toBe(1);
  const bytes = new Uint8Array(48000), view = new DataView(bytes.buffer);
  for (let i = 0; i < bytes.length / 2; i++) view.setInt16(i * 2, Math.sin(i * 2 * Math.PI * 440 / 24000) * 6000, true);
  const pcm = btoa(String.fromCharCode(...bytes));
  let sequence = 0;
  const audio = () => s.event({ kind: "audio", outputId: "ithaca-manual-interruption", sequence: sequence++, pcm, format: { encoding: "pcm16", channels: 1, sampleRate: 24000 } });
  audio();
  await expect.poll(() => s.client.state.getState().playing).toBe(true);
  mic.speak();
  await expect.poll(() => s.client.state.getState().outputRecovery).toBe("speaking");
  mic.quiet();
  // Drain queued real microphone blocks, still before the 700 ms endpoint.
  await new Promise(resolve => setTimeout(resolve, 200));
  if (action === "answer") {
    s.deliver({ type: "text_delta", sessionId: SESSION, turnId: "ithaca-turn", text: "Which departure works?" });
    s.deliver({ type: "ask_user_request", sessionId: SESSION, turnId: "ithaca-turn", requestId: "ithaca-question", questions: [{ question: "Which day?", header: "Day", multiSelect: false, options: [{ label: "Tomorrow", description: "Before departure" }] }] });
  }
  s.input("Tomorrow before departure");
  await expect.poll(() => s.button(action === "discard" ? "Discard" : action === "mute" ? "Mute mic" : "Send now")).not.toBeUndefined();
  expect(s.socket.frames("conversation_endpoint")).toHaveLength(1);
  expect(s.client.state.getState().outputRecovery).toBe("speaking");
  let noise: ReturnType<typeof setInterval> | undefined;
  if (noisy) { audio(); noise = setInterval(audio, 60); ctx.onTestFinished(() => clearInterval(noise)); }
  await userEvent.click(s.button(action === "discard" ? "Discard" : action === "mute" ? "Mute mic" : "Send now"));
  expect(s.client.state.getState().outputRecovery, "MANUAL_ENDPOINT_STARTS_RECOVERY").toBe("checking");
  expect(s.socket.frames("conversation_endpoint")).toHaveLength(2);
  expect(s.socket.frames("conversation_commit")).toHaveLength(action === "send" ? 1 : 0);
  expect(s.socket.frames("ask_user_response")).toHaveLength(action === "answer" ? 1 : 0);
  if (action === "answer") expect(s.socket.frames("ask_user_response")[0]?.answers).toEqual({ "Which day?": "Tomorrow before departure" });
  if (action === "discard") {
    // A discarded final cannot return later and arrange an automatic send.
    s.input("Tomorrow before departure", "final");
    expect(s.client.state.getState().text).toBe("");
  }
  await expect.poll(() => s.client.state.getState().outputRecovery, { timeout: 4200, message: "MANUAL_ENDPOINT_HAS_BOUNDED_RECOVERY" }).toBe(noisy ? "muted" : "audible");
  clearInterval(noise);
  expect(s.client.state.getState().micOn).toBe(action !== "mute");
  expect(s.socket.frames("conversation_stop")).toHaveLength(0);
  if (noisy) { await userEvent.click(s.button("Recover reply audio")); expect(s.client.state.getState().outputRecovery).toBe("audible"); }
  audio(); await expect.poll(() => s.client.state.getState().playing).toBe(true);
  if (action !== "mute") { mic.speak(); await expect.poll(() => s.socket.frames("conversation_audio").at(-1)?.utteranceId).not.toBe(s.socket.frames("conversation_endpoint").at(-1)?.utteranceId); }
  else { expect(mic.opens()).toBe(1); expect(s.socket.frames("conversation_commit")).toHaveLength(0); }
});
