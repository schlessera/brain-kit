/// <reference types="@vitest/browser-playwright" />
/**
 * Gemini 3.5 Transcribe Live dictation in real Chromium (#3708).
 *
 * The real ChatPage dictates through the shipped GeminiAsrClient: the real
 * AudioWorklet captures an oscillator "microphone" from an AudioContext
 * forced to a 44.1 or 48 kHz hardware rate, and #1016's fault network stands
 * in for both the host and Google's Live socket. Nothing leaves the page.
 * This proves framing, resampling, event mapping and teardown against the
 * documented protocol; it is not evidence that Google accepts it (#3710).
 */
import { afterAll, beforeAll, expect, test, type TestContext } from "vitest";
import { commands, userEvent } from "vitest/browser";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import type { VoiceSessionResponse } from "@schlessera/brain-ui-sdk/client";
import { BrainUiProvider } from "../../src/root-context.js";
import { createBrainUiRoot, type BrainUiRoot } from "../../src/root.js";
import { ChatPage } from "../../src/components/chat/chat-page.js";
import { createPcmResampler } from "../../src/voice/pcm-capture.js";
import { installFaultNetwork, type FaultNetwork, type FaultSocket } from "./offline/fault-network.ts";

const ITHACA = "odysseus-ithaca";
const SPEECH = "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained";
const TOKEN = "auth_tokens/ithaca-fixture-ephemeral";
const TONE_HZ = 440;

const HELLO = [
  { type: "server_hello", protocolRev: 5, capabilities: { chatRequestAck: true } },
  { type: "session_info", sessionId: ITHACA, isNew: false },
  { type: "session_history", sessionId: ITHACA, messages: [] },
  { type: "status", sessionId: ITHACA, status: "idle" },
];

const SESSION: VoiceSessionResponse = {
  providerId: "gemini", url: SPEECH, token: TOKEN, expiresAt: Date.now() + 60 * 60_000,
  params: { model: "models/gemini-3.5-transcribe-live", mode: "SMART", sampleRate: "16000", vocabulary: JSON.stringify(["Ithaca", "Penelope"]) },
  capabilities: { streaming: true, interimResults: true, keyterms: true, endpointing: false, smartTranscription: true, savedAudio: false },
};

let styles: HTMLStyleElement | undefined;
beforeAll(async () => {
  styles = document.createElement("style");
  styles.textContent = await commands.formConsumerStyles();
  document.head.append(styles);
});
afterAll(() => styles?.remove());

type Scene = { ui: BrainUiRoot; host: HTMLDivElement; net: FaultNetwork; unmount: () => void };

async function mount(ctx: TestContext): Promise<Scene> {
  const net = installFaultNetwork({
    routes: (url) => {
      if (url.pathname.endsWith("/voice/session")) return Response.json(SESSION);
      if (url.pathname.endsWith("/voice/overrides")) return Response.json({ overrides: [] });
      if (url.pathname.endsWith("/sessions")) return Response.json({ sessions: [] });
      return undefined;
    },
    // Google's socket stays silent until the test answers the setup.
    onOpen: (socket) => { if (!socket.url.startsWith(SPEECH)) for (const frame of HELLO) socket.deliver(frame); },
  });
  ctx.onTestFinished(() => net.restore());
  const host = document.createElement("div");
  host.style.cssText = "position:fixed;inset:0;width:390px;height:780px";
  document.body.append(host);
  const ui = createBrainUiRoot({ storage: null, request: net.request });
  const renderer = createRoot(host);
  let mounted = true;
  const unmount = () => { if (mounted) { mounted = false; flushSync(() => renderer.unmount()); } };
  ctx.onTestFinished(() => { unmount(); ui.dispose(); host.remove(); });
  ui.stores.chat.getState().setActiveSession(ITHACA);
  flushSync(() => renderer.render(<BrainUiProvider root={ui}><ChatPage /></BrainUiProvider>));
  ui.connection.connect();
  await expect.poll(() => ui.stores.connection.getState().wsStatus, { message: "the app reached the host" }).toBe("connected");
  return { ui, host, net, unmount };
}

/**
 * The client's AudioContext runs at `rate`, as on hardware that is not
 * 16 kHz; the microphone is a steady tone from a context at the same rate.
 * Every context the client creates is recorded, so teardown is observable.
 */
function hardware(ctx: TestContext, rate: number) {
  const Original = window.AudioContext;
  const descriptor = Object.getOwnPropertyDescriptor(window, "AudioContext");
  const source = new Original({ sampleRate: rate });
  const oscillator = source.createOscillator();
  oscillator.frequency.value = TONE_HZ;
  const gain = source.createGain(); gain.gain.value = 0.3;
  const destination = source.createMediaStreamDestination();
  oscillator.connect(gain); gain.connect(destination); oscillator.start(); void source.resume();
  const contexts: AudioContext[] = [];
  class HardwareContext extends Original {
    constructor(options?: AudioContextOptions) { super({ ...options, sampleRate: options?.sampleRate ?? rate }); contexts.push(this); }
  }
  Object.defineProperty(window, "AudioContext", { configurable: true, writable: true, value: HardwareContext });
  // Every message the capture worklet posts, as the client's handler sees it.
  const OriginalNode = window.AudioWorkletNode;
  const nodeDescriptor = Object.getOwnPropertyDescriptor(window, "AudioWorkletNode");
  const worklet: { blocks: Float32Array[]; flushed: Float32Array[] } = { blocks: [], flushed: [] };
  class RecordingNode extends OriginalNode {
    constructor(...args: ConstructorParameters<typeof AudioWorkletNode>) {
      super(...args);
      this.port.addEventListener("message", ({ data }) => {
        if (data instanceof Float32Array) worklet.blocks.push(data);
        else if (data?.flushed instanceof Float32Array) worklet.flushed.push(data.flushed);
      });
    }
  }
  Object.defineProperty(window, "AudioWorkletNode", { configurable: true, writable: true, value: RecordingNode });
  const media = navigator.mediaDevices;
  const gum = Object.getOwnPropertyDescriptor(media, "getUserMedia");
  const streams: MediaStream[] = [];
  Object.defineProperty(media, "getUserMedia", { configurable: true, writable: true, value: async () => { const stream = destination.stream.clone(); streams.push(stream); return stream; } });
  ctx.onTestFinished(() => {
    if (descriptor) Object.defineProperty(window, "AudioContext", descriptor); else Reflect.deleteProperty(window, "AudioContext");
    if (nodeDescriptor) Object.defineProperty(window, "AudioWorkletNode", nodeDescriptor); else Reflect.deleteProperty(window, "AudioWorkletNode");
    if (gum) Object.defineProperty(media, "getUserMedia", gum); else Reflect.deleteProperty(media, "getUserMedia");
    oscillator.stop();
    streams.forEach((stream) => stream.getTracks().forEach((track) => track.stop()));
    destination.stream.getTracks().forEach((track) => track.stop());
    void source.close();
  });
  return { contexts, streams, worklet };
}

const dictate = (s: Scene) => s.host.querySelector<HTMLElement>('[data-composer] [role="button"][aria-label="Dictate"]');

async function startDictating(s: Scene): Promise<FaultSocket> {
  await expect.poll(() => dictate(s), { message: "the composer has a mic" }).not.toBe(null);
  await userEvent.click(dictate(s)!);
  await expect.poll(() => s.ui.stores.voice.getState().connecting, { message: "the microphone is live", timeout: 5_000 }).toBe(false);
  await expect.poll(() => s.net.socket(SPEECH)?.readyState, { message: "Google's socket is open", timeout: 5_000 }).toBe(1);
  return s.net.socket(SPEECH)!;
}

function json(socket: FaultSocket): Array<Record<string, any>> {
  return socket.sent.filter((frame) => typeof frame.data === "string").map((frame) => JSON.parse(frame.data as string));
}
const audioFrames = (socket: FaultSocket) => json(socket).filter((frame) => frame.realtimeInput?.audio).map((frame) => frame.realtimeInput.audio as { data: string; mimeType: string });

function pcm16(frames: Array<{ data: string }>): Int16Array {
  const bytes = Uint8Array.from(frames.map((frame) => atob(frame.data)).join(""), (char) => char.charCodeAt(0));
  const view = new DataView(bytes.buffer);
  return Int16Array.from({ length: bytes.length / 2 }, (_, i) => view.getInt16(i * 2, true));
}

function decode(frames: Array<{ data: string }>): Float32Array {
  const bytes = Uint8Array.from(frames.map((frame) => atob(frame.data)).join(""), (char) => char.charCodeAt(0));
  const view = new DataView(bytes.buffer);
  return Float32Array.from({ length: bytes.length / 2 }, (_, i) => view.getInt16(i * 2, true) / 32768);
}

/** Strongest frequency between 100 Hz and 4 kHz (Goertzel, 10 Hz steps). */
function dominant(samples: Float32Array, rate: number): number {
  let best = 0, bestPower = -1;
  for (let hz = 100; hz <= 4000; hz += 10) {
    const coefficient = 2 * Math.cos((2 * Math.PI * hz) / rate);
    let s1 = 0, s2 = 0;
    for (const sample of samples) { const s0 = sample + coefficient * s1 - s2; s2 = s1; s1 = s0; }
    const power = s1 * s1 + s2 * s2 - coefficient * s1 * s2;
    if (power > bestPower) { bestPower = power; best = hz; }
  }
  return best;
}

for (const rate of [44_100, 48_000]) {
  test(`a ${rate} Hz context streams 100 ms PCM16 at 16 kHz, maps interim and final text, and Done drains into review`, { timeout: 30_000 }, async (ctx) => {
    const audio = hardware(ctx, rate);
    const s = await mount(ctx);
    const speech = await startDictating(s);
    const url = new URL(speech.url);
    expect(url.searchParams.get("access_token"), "the ephemeral token is the only credential").toBe(TOKEN);
    expect(json(speech)[0], "the setup the token locks").toEqual({ setup: {
      model: "models/gemini-3.5-transcribe-live",
      generationConfig: { responseModalities: ["TEXT"] },
      inputAudioTranscription: { mode: "SMART", customVocabulary: ["Ithaca", "Penelope"] },
    } });
    expect(audio.contexts[0]?.sampleRate, "the client's context runs at the hardware rate").toBe(rate);
    speech.deliver({ setupComplete: {} });
    await expect.poll(() => audioFrames(speech).length, { message: "two seconds of audio reached the socket", timeout: 10_000 }).toBeGreaterThanOrEqual(20);
    const frames = audioFrames(speech).slice(0, 20);
    for (const frame of frames) {
      expect(frame.mimeType).toBe("audio/pcm;rate=16000");
      expect(atob(frame.data).length, "100 ms of 16 kHz PCM16").toBe(3200);
    }
    // Two seconds at 16 kHz carry the tone at its own pitch. Hardware-rate
    // samples labelled 16 kHz would put it at 440 × rate / 16 000.
    expect(Math.abs(dominant(decode(frames).subarray(1600), 16_000) - TONE_HZ), "GEMINI_BROWSER_RESAMPLED_16K").toBeLessThanOrEqual(10);
    expect(json(speech).some((frame) => frame.realtimeInput?.mediaChunks || frame.realtimeInput?.audio?.mimeType !== undefined && !frame.realtimeInput.audio.mimeType.startsWith("audio/pcm")), "no encoded container is labelled PCM").toBe(false);

    speech.deliver({ serverContent: { interimInputTranscription: { text: "Ask Nes" } } });
    await expect.poll(() => s.ui.stores.voice.getState().partial).toBe("Ask Nes");
    speech.deliver({ serverContent: { interimInputTranscription: { text: "Ask Nestor about" } } });
    await expect.poll(() => s.ui.stores.voice.getState().partial, { message: "interim text replaces, never appends" }).toBe("Ask Nestor about");
    speech.deliver({ serverContent: { inputTranscription: { text: "Ask Nestor about the ships.", finished: true } } });
    await expect.poll(() => s.ui.stores.voice.getState().finalText).toBe("Ask Nestor about the ships.");
    expect(s.ui.stores.voice.getState().partial, "a final clears the partial").toBe("");

    await userEvent.click([...s.host.querySelectorAll<HTMLElement>("button")].find((el) => el.textContent?.trim() === "Done")!);
    await expect.poll(() => json(speech).some((frame) => frame.realtimeInput?.audioStreamEnd === true), { message: "Done ends the input stream" }).toBe(true);
    expect(audio.streams[0]!.getTracks().map((track) => track.readyState), "Done closes the microphone first").toEqual(["ended"]);
    expect(s.ui.stores.voice.getState().mode, "Done waits for the last final").toBe("dictate");
    speech.deliver({ serverContent: { inputTranscription: { text: "And the harbor.", finished: true } } });
    await expect.poll(() => s.ui.stores.voice.getState().mode, { message: "the drain ended the dictation" }).toBe("idle");
    expect(s.ui.stores.voice.getState().reviewText, "each final commits exactly once").toBe("Ask Nestor about the ships. And the harbor.");
    await expect.poll(() => audio.contexts[0]!.state, { message: "GEMINI_BROWSER_TEARDOWN_CONTEXT_CLOSED" }).toBe("closed");
    expect(speech.readyState).toBe(3);
  });
}

test("audio waits for setupComplete, then flows in order", { timeout: 30_000 }, async (ctx) => {
  hardware(ctx, 48_000);
  const s = await mount(ctx);
  const speech = await startDictating(s);
  await new Promise((resolve) => setTimeout(resolve, 1_200));
  expect(audioFrames(speech), "nothing is sent before setup completes").toHaveLength(0);
  expect(s.ui.stores.voice.getState().mode).toBe("dictate");
  speech.deliver({ setupComplete: {} });
  await expect.poll(() => audioFrames(speech).length, { message: "the buffered head of the take is delivered" }).toBeGreaterThanOrEqual(10);
});

test("a stalled upload fails the take with a connection notice and keeps the words heard", { timeout: 30_000 }, async (ctx) => {
  const audio = hardware(ctx, 48_000);
  const s = await mount(ctx);
  const speech = await startDictating(s);
  speech.deliver({ setupComplete: {} });
  speech.deliver({ serverContent: { inputTranscription: { text: "Ask Nestor about the ships.", finished: true } } });
  await expect.poll(() => s.ui.stores.voice.getState().finalText).toBe("Ask Nestor about the ships.");
  Object.defineProperty(speech, "bufferedAmount", { configurable: true, value: 256 * 1024 + 1 });
  await expect.poll(() => s.ui.stores.voice.getState().mode, { message: "the backlog ended the take", timeout: 5_000 }).toBe("idle");
  expect(s.ui.stores.voice.getState().reviewText).toBe("Ask Nestor about the ships.");
  expect(s.ui.stores.voice.getState().dictationNotice).toEqual({ reason: "network", phase: "ended", retained: true });
  await expect.poll(() => audio.contexts[0]!.state).toBe("closed");
  expect(audio.streams[0]!.getTracks().map((track) => track.readyState)).toEqual(["ended"]);
});

test("Google ending the session hands what was heard to review once", { timeout: 30_000 }, async (ctx) => {
  const audio = hardware(ctx, 44_100);
  const s = await mount(ctx);
  const speech = await startDictating(s);
  speech.deliver({ setupComplete: {} });
  speech.deliver({ serverContent: { inputTranscription: { text: "Ask Nestor", finished: false } } });
  speech.deliver({ serverContent: { interimInputTranscription: { text: "about the ships" } } });
  await expect.poll(() => s.ui.stores.voice.getState().partial).toBe("about the ships");
  speech.finish(1000, "", true);
  await expect.poll(() => s.ui.stores.voice.getState().mode, { message: "the provider ended the dictation" }).toBe("idle");
  expect(s.ui.stores.voice.getState().reviewText).toBe("Ask Nestor about the ships");
  expect(s.ui.stores.voice.getState().finalText).toBe("");
  await expect.poll(() => audio.contexts[0]!.state).toBe("closed");
});

test("unmount hard-stops capture: tracks, AudioContext and socket are released and nothing more is sent", { timeout: 30_000 }, async (ctx) => {
  const audio = hardware(ctx, 48_000);
  const s = await mount(ctx);
  const speech = await startDictating(s);
  speech.deliver({ setupComplete: {} });
  await expect.poll(() => audioFrames(speech).length, { timeout: 10_000 }).toBeGreaterThanOrEqual(3);
  s.unmount();
  expect(audio.streams[0]!.getTracks().map((track) => track.readyState)).toEqual(["ended"]);
  await expect.poll(() => audio.contexts[0]!.state, { message: "GEMINI_BROWSER_TEARDOWN_CONTEXT_CLOSED" }).toBe("closed");
  expect(speech.readyState).toBeGreaterThanOrEqual(2);
  const sent = speech.sent.length;
  await new Promise((resolve) => setTimeout(resolve, 500));
  expect(speech.sent.length, "no audio after teardown").toBe(sent);
  expect(json(speech).some((frame) => frame.realtimeInput?.audioStreamEnd), "a hard stop sends no graceful end").toBe(false);
});

test("Done keeps the worklet's partial block: every captured sample reaches Google before audioStreamEnd", { timeout: 30_000 }, async (ctx) => {
  const rate = 48_000;
  const audio = hardware(ctx, rate);
  const s = await mount(ctx);
  const speech = await startDictating(s);
  speech.deliver({ setupComplete: {} });
  await expect.poll(() => audio.worklet.blocks.length, { message: "the worklet posts whole blocks", timeout: 10_000 }).toBeGreaterThanOrEqual(3);
  // Stop the audio clock part-way into a block (one is ~85 ms at 48 kHz), so
  // the worklet holds a tail short of a block when Done is pressed.
  const posted = audio.worklet.blocks.length;
  await expect.poll(() => audio.worklet.blocks.length, { timeout: 5_000 }).toBeGreaterThan(posted);
  await new Promise((resolve) => setTimeout(resolve, 40));
  await audio.contexts[0]!.suspend();
  await userEvent.click([...s.host.querySelectorAll<HTMLElement>("button")].find((el) => el.textContent?.trim() === "Done")!);
  await expect.poll(() => json(speech).some((frame) => frame.realtimeInput?.audioStreamEnd === true), { message: "Done ends the input stream" }).toBe(true);
  expect(audio.worklet.flushed, "GEMINI_BROWSER_DONE_KEEPS_TAIL: the worklet handed over its partial block").toHaveLength(1);
  expect(audio.worklet.flushed[0]!.length, "GEMINI_BROWSER_DONE_KEEPS_TAIL: the tail is short of a block and not empty").toBeGreaterThan(0);
  expect(audio.worklet.flushed[0]!.length).toBeLessThan(4096);
  const sent = json(speech);
  const end = sent.findIndex((frame) => frame.realtimeInput?.audioStreamEnd === true);
  expect(sent.slice(end + 1).some((frame) => frame.realtimeInput?.audio), "no audio after audioStreamEnd").toBe(false);
  const resample = createPcmResampler(rate, 16_000);
  const expected = [...audio.worklet.blocks, ...audio.worklet.flushed].flatMap((block) => [...resample(block)]);
  const received = pcm16(sent.slice(0, end).filter((frame) => frame.realtimeInput?.audio).map((frame) => frame.realtimeInput.audio));
  expect(received.length, "GEMINI_BROWSER_DONE_KEEPS_TAIL sample count").toBe(expected.length);
  expect([...received], "GEMINI_BROWSER_DONE_KEEPS_TAIL samples").toEqual(expected);
  expect(audio.streams[0]!.getTracks().map((track) => track.readyState), "the microphone closes once the tail is in").toEqual(["ended"]);
  speech.deliver({ serverContent: { turnComplete: true } });
  await expect.poll(() => s.ui.stores.voice.getState().mode, { message: "the drain ended the dictation" }).toBe("idle");
});

test("Google closing with 1011 while Done drains keeps the words and explains the failure", { timeout: 30_000 }, async (ctx) => {
  const audio = hardware(ctx, 48_000);
  const s = await mount(ctx);
  const speech = await startDictating(s);
  speech.deliver({ setupComplete: {} });
  speech.deliver({ serverContent: { inputTranscription: { text: "Ask Nestor about the ships.", finished: true } } });
  await expect.poll(() => s.ui.stores.voice.getState().finalText).toBe("Ask Nestor about the ships.");
  await userEvent.click([...s.host.querySelectorAll<HTMLElement>("button")].find((el) => el.textContent?.trim() === "Done")!);
  await expect.poll(() => json(speech).some((frame) => frame.realtimeInput?.audioStreamEnd === true), { message: "Done ends the input stream" }).toBe(true);
  expect(s.ui.stores.voice.getState().mode, "Done waits for the last final").toBe("dictate");
  // Google's own close frame with an internal-error code: a completed close
  // handshake (no error event), so only the code says the take failed.
  speech.finish(1011, "", true);
  await expect.poll(() => s.ui.stores.voice.getState().mode, { message: "the close settled the drain" }).toBe("idle");
  expect(s.ui.stores.voice.getState().reviewText).toBe("Ask Nestor about the ships.");
  expect(s.ui.stores.voice.getState().dictationNotice, "GEMINI_BROWSER_DRAIN_CLOSE_NOTICE").toEqual({ reason: "network", phase: "ended", retained: true });
  await expect.poll(() => audio.contexts[0]!.state).toBe("closed");
});
