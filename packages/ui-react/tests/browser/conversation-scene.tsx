/**
 * The live-conversation scene the conversation*.offline.tsx specs share (#4849):
 * the session, capabilities and profile they open, the consumer styles, a
 * mounted ChatPage connected through the fault network, and a controlled
 * microphone. A spec calls `installConsumerStyles()` at its top level, so
 * the hooks belong to that file rather than to whichever file first imported
 * this module. Where the specs' copies differed, the difference is an option.
 */
import { afterAll, beforeAll, expect, type TestContext } from "vitest";
import { commands, userEvent, page } from "vitest/browser";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { CONVERSATION_LIMITS, type ConversationCapabilities, type ConversationWireEvent, type ServerConversationOpened, type ServerMessage } from "@schlessera/brain-ui-sdk/protocol";
import { createBrainUiRoot } from "../../src/root.js";
import { BrainUiProvider } from "../../src/root-context.js";
import { AppShell } from "../../src/components/layout/app-shell.js";
import { ChatPage } from "../../src/components/chat/chat-page.js";
import { installFaultNetwork } from "./offline/fault-network.js";

export const SESSION = "odysseus-ithaca";
export const CAPS: ConversationCapabilities = { nonblockingWork: "supported", manualEndpoint: "supported", finalTranscript: "unproven", remoteOutputCancelAck: "unproven", exactPermissionSpeech: "unproven", echoIsolatedInput: "unproven", outputWordAlignment: "unproven" };
export const PROFILE: ServerConversationOpened = { type: "conversation_opened", conversationId: "ithaca-voice", epoch: 1, sessionId: SESSION, providerId: "gpt-live", capabilities: CAPS, disclosure: { voiceService: "Odysseus voice fixture", destinations: ["Audio and transcripts: fixture voice API. Retention: unknown."] }, limits: { ...CONVERSATION_LIMITS }, resync: { work: 0, outputs: 0 } };

/** Installs the consumer styles for the calling spec file and removes them after it. */
export function installConsumerStyles() {
  let styles: HTMLStyleElement;
  beforeAll(async () => { styles = document.createElement("style"); styles.textContent = await commands.formConsumerStyles(); document.head.append(styles); });
  afterAll(() => styles.remove());
}

export interface SceneOptions {
  /** Answer `/render` with a refusal and record each request body (the export specs). */
  exportStops?: boolean;
  /** Restore the session from a retained chat id in `localStorage` instead of selecting it. */
  retained?: boolean;
}

export async function scene(ctx: TestContext, width = 390, shell = false, theme: "light" | "dark" = "dark", options: SceneOptions = {}) {
  if (shell) {
    const viewport = { width: innerWidth, height: innerHeight };
    const outer = await commands.formViewport(width, 568);
    await page.viewport(width, 568);
    ctx.onTestFinished(async () => { await page.viewport(viewport.width, viewport.height); await commands.formViewport(outer.width - 100, outer.height - 120); });
  }
  const renderRequests: Array<{ content: string; contentType: string; format: string }> = [];
  const network = installFaultNetwork({ routes: (url, init) => {
    if (options.exportStops && url.pathname.endsWith("/render")) {
      renderRequests.push(JSON.parse(String(init.body)));
      // Serialization proof stops at the real request boundary, with no server
      // renderer, download or device share sheet involved.
      return Response.json({ error: "Odysseus export fixture stops after serialization" }, { status: 503 });
    }
    return url.pathname.endsWith("/sessions") ? Response.json({ sessions: [] }) : undefined;
  },
    onOpen(socket) { socket.deliver({ type: "server_hello", conversationProfile: {providerId:PROFILE.providerId,capabilities:PROFILE.capabilities,disclosure:PROFILE.disclosure}, protocolRev: 5, principalKey: "odysseus-principal", capabilities: { askReceipts: true, liveConversation: true, conversationPause: true, toolResolution: true, chatRequestAck: true } }); socket.deliver({ type: "session_info", sessionId: SESSION, isNew: false }); socket.deliver({ type: "session_history", sessionId: SESSION, messages: [] }); socket.deliver({ type: "status", sessionId: SESSION, status: "idle" }); } });
  const prefix = `odysseus-stale-${crypto.randomUUID()}`;
  if (options.retained) localStorage.setItem(`${prefix}:brain-sessionId`, SESSION);
  const ui = createBrainUiRoot({ ...(options.retained ? { storage: localStorage, storagePrefix: prefix } : { storage: null }), request: network.request });
  if (options.retained) expect(ui.stores.chat.getState().activeSessionId, "BROWSER_RESTORES_ITS_RETAINED_CHAT_ID").toBe(SESSION);
  else ui.stores.chat.getState().setActiveSession(SESSION);
  const host = document.createElement("div"); host.style.cssText = `position:fixed;inset:0;width:${width}px;height:568px`; document.body.append(host);
  const renderer = createRoot(host);
  ui.stores.ui.getState().setTheme(theme);
  flushSync(() => renderer.render(<BrainUiProvider root={ui}>{shell ? <AppShell><ChatPage /></AppShell> : <ChatPage />}</BrainUiProvider>));
  const release = ui.connection.connect();
  let disposed = false;
  const dispose = () => { if (disposed) return; disposed = true; flushSync(() => renderer.unmount()); release(); ui.dispose(); network.restore(); host.remove(); if (options.retained) for (const key of Object.keys(localStorage)) if (key.startsWith(prefix + ":")) localStorage.removeItem(key); };
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
  return { ui, client, host, socket, deliver, network, renderRequests, button, event, opened, enter, start, input, dispose,
    remountControls() { flushSync(() => renderer.render(<BrainUiProvider root={ui}><ChatPage key="odysseus-remount" /></BrainUiProvider>)); },
    unmountControls() { flushSync(() => renderer.render(null)); },
  };
}

export function controlledMicrophone(ctx: TestContext, freshStreams = false, options: { capture?: boolean } = {}) {
  const context = new AudioContext();
  const oscillator = context.createOscillator();
  const gain = context.createGain(); gain.gain.value = 0.15;
  const destination = context.createMediaStreamDestination();
  oscillator.connect(gain); gain.connect(destination); oscillator.start(); void context.resume();
  const media = navigator.mediaDevices;
  const descriptor = Object.getOwnPropertyDescriptor(media, "getUserMedia");
  const NativeWorklet = AudioWorkletNode;
  const workletDescriptor = Object.getOwnPropertyDescriptor(globalThis, "AudioWorkletNode")!;
  const captured: { pcm: string; speaking: boolean }[] = [];
  const targetRate = { value: 24000 };
  // Capture: the PCM the page's worklet resamples, as the conversation would send it.
  if (options.capture) Object.defineProperty(globalThis, "AudioWorkletNode", { ...workletDescriptor, value: class extends NativeWorklet {
    constructor(context: BaseAudioContext, name: string, options?: AudioWorkletNodeOptions) {
      super(context, name, options);
      let cursor = 0;
      this.port.addEventListener("message", ({ data }: MessageEvent<Float32Array>) => {
        const values: number[] = [];
        let energy = 0;
        for (const value of data) energy += value * value;
        for (; cursor < data.length; cursor += context.sampleRate / targetRate.value) {
          const at = Math.floor(cursor);
          const value = data[at]! + ((data[Math.min(at + 1, data.length - 1)] ?? 0) - data[at]!) * (cursor - at);
          values.push(Math.round(Math.max(-1, Math.min(1, value)) * (value < 0 ? 32768 : 32767)));
        }
        cursor -= data.length;
        const bytes = new Uint8Array(values.length * 2); const view = new DataView(bytes.buffer);
        values.forEach((value, index) => view.setInt16(index * 2, value, true));
        captured.push({ pcm: btoa(String.fromCharCode(...bytes)), speaking: Math.sqrt(energy / data.length) > 0.015 });
      });
      this.port.start();
    }
  } });
  let opens = 0;
  const streams: MediaStream[] = [];
  Object.defineProperty(media, "getUserMedia", { configurable: true, writable: true, value: async () => { opens++; const stream = freshStreams ? destination.stream.clone() : destination.stream; streams.push(stream); return stream; } });
  ctx.onTestFinished(() => { if (options.capture) Object.defineProperty(globalThis, "AudioWorkletNode", workletDescriptor); if (descriptor) Object.defineProperty(media, "getUserMedia", descriptor); else Reflect.deleteProperty(media, "getUserMedia"); oscillator.stop(); streams.forEach(stream => stream.getTracks().forEach(track => track.stop())); destination.stream.getTracks().forEach(track => track.stop()); void context.close(); });
  return { streams, captured, targetRate, opens: () => opens, quiet: () => { gain.gain.value = 0; }, speak: () => { gain.gain.value = 0.15; }, stream: destination.stream };
}
