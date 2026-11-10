import { afterEach, describe, expect, test } from "bun:test";
import { runAsrClientContract } from "@schlessera/brain-ui-sdk/testing";
import type { AsrEvent, VoiceSessionResponse } from "@schlessera/brain-ui-sdk/client";
import {
  GEMINI_DRAIN_MS, GEMINI_DRAIN_QUIET_MS, GEMINI_DRAIN_TAIL_MS, GEMINI_FRAME_SAMPLES, GEMINI_HANDSHAKE_MS, GEMINI_MAX_BUFFERED_BYTES, GEMINI_PRESETUP_FRAMES, GeminiAsrClient,
} from "../src/voice/asr-gemini";
import { createPcmResampler, PCM_CAPTURE_BLOCK } from "../src/voice/pcm-capture";

/**
 * GeminiAsrClient against a scripted microphone, AudioContext/worklet and
 * socket. Wire shapes follow the Live Transcribe guide. Real-Chrome capture
 * (actual worklet, 44.1/48 kHz contexts, mounted ChatPage) is
 * tests/browser/dictation-gemini.offline.tsx.
 */

const URL_ = "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained";
const TOKEN = "auth_tokens/ithaca-fixture";
const PARAMS = { model: "models/gemini-3.5-transcribe-live", mode: "SMART", sampleRate: "16000", vocabulary: JSON.stringify(["Ithaca", "Penelope"]), languageCodes: JSON.stringify(["en-US"]) };
const SESSION: VoiceSessionResponse = { providerId: "gemini", url: URL_, token: TOKEN, params: PARAMS, expiresAt: 1000,
  capabilities: { streaming: true, interimResults: true, keyterms: true, endpointing: false, smartTranscription: true, savedAudio: false } };

function replaceGlobals(values: Record<string, unknown>): () => void {
  const originals = Object.keys(values).map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  for (const [name, value] of Object.entries(values)) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  return () => { for (const [name, original] of originals) { if (original) Object.defineProperty(globalThis, name, original); else Reflect.deleteProperty(globalThis, name); } };
}

interface Timer { id: number; at: number; run: () => void }

type Port = { onmessage: ((event: { data: any }) => void) | null; postMessage(data: unknown): void };
/** Two ends of a MessageChannel: each message arrives asynchronously, in order. */
function channel(): [Port, Port] {
  const a: Port = { onmessage: null, postMessage: (data) => queueMicrotask(() => b.onmessage?.({ data })) };
  const b: Port = { onmessage: null, postMessage: (data) => queueMicrotask(() => a.onmessage?.({ data })) };
  return [a, b];
}
interface Processor { port: Port; process(inputs: Float32Array[][]): boolean }

/**
 * A scripted browser: microphone, AudioContext, WebSocket and (optionally)
 * timers. The worklet is the real one: `addModule` evaluates the source the
 * client put in its Blob URL, and each AudioWorkletNode runs that processor
 * behind an asynchronous port.
 */
function scriptedBrowser({ rate = 48_000, timers = false, answerSetup = true } = {}) {
  const tracks: Array<{ readyState: string; stop(): void; ended?: () => void }> = [];
  const contexts: FakeContext[] = [];
  const nodes: FakeNode[] = [];
  const sockets: FakeSocket[] = [];
  const blobs = new Map<string, Blob>();
  const processors = new Map<string, new () => Processor>();
  let nextPort: Port | null = null;
  class WorkletProcessor { port: Port; constructor() { this.port = nextPort!; nextPort = null; } }
  class FakeNode {
    port: Port;
    processor: Processor;
    connected = true;
    constructor(_context: unknown, name: string) {
      const [node, worklet] = channel();
      this.port = node;
      nextPort = worklet;
      this.processor = new (processors.get(name)!)();
      nodes.push(this);
    }
    disconnect() { this.connected = false; }
  }
  class FakeContext {
    sampleRate = rate;
    state = "running";
    closes = 0;
    audioWorklet = { addModule: async (url: string) => {
      const source = await blobs.get(url)!.text();
      new Function("AudioWorkletProcessor", "registerProcessor", source)(WorkletProcessor, (name: string, processor: new () => Processor) => processors.set(name, processor));
    } };
    constructor() { contexts.push(this); }
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    async resume() {}
    async close() { this.closes++; this.state = "closed"; }
  }
  class FakeSocket {
    static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
    readyState = 0;
    bufferedAmount = 0;
    binaryType = "blob";
    closeCode: number | undefined;
    sent: string[] = [];
    onopen: (() => void) | null = null;
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onerror: (() => void) | null = null;
    onclose: ((event: { code: number }) => void) | null = null;
    constructor(readonly url: string) {
      sockets.push(this);
      queueMicrotask(() => { if (this.readyState !== 0) return; this.readyState = 1; this.onopen?.(); });
    }
    send(data: string) {
      if (this.readyState !== 1) throw new Error("not open");
      this.sent.push(data);
      if (answerSetup && JSON.parse(data).setup) queueMicrotask(() => this.server({ setupComplete: {} }));
    }
    close(code = 1000) { this.closeCode = code; this.readyState = 3; }
    /** Google speaks. */
    server(message: unknown) { this.onmessage?.({ data: JSON.stringify(message) }); }
    /** Google or the network ends the socket. */
    end(code: number) { this.readyState = 3; this.onclose?.({ code }); }
    audio() { return this.sent.map((frame) => JSON.parse(frame)).filter((frame) => frame.realtimeInput?.audio).map((frame) => frame.realtimeInput.audio); }
  }
  const pending: Timer[] = [];
  let now = 0, nextId = 1;
  const timerGlobals = timers ? {
    setTimeout: (run: () => void, delay = 0) => { const timer = { id: nextId++, at: now + delay, run }; pending.push(timer); return timer.id; },
    clearTimeout: (id: number) => { const index = pending.findIndex((timer) => timer.id === id); if (index >= 0) pending.splice(index, 1); },
  } : {};
  const objectUrls = { create: Object.getOwnPropertyDescriptor(URL, "createObjectURL"), revoke: Object.getOwnPropertyDescriptor(URL, "revokeObjectURL") };
  Object.defineProperty(URL, "createObjectURL", { configurable: true, writable: true, value: (blob: Blob) => { const url = `blob:fixture/${blobs.size}`; blobs.set(url, blob); return url; } });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, writable: true, value: () => {} });
  const restoreUrls = () => {
    for (const [name, descriptor] of [["createObjectURL", objectUrls.create], ["revokeObjectURL", objectUrls.revoke]] as const) {
      if (descriptor) Object.defineProperty(URL, name, descriptor); else Reflect.deleteProperty(URL, name);
    }
  };
  const restoreGlobals = replaceGlobals({
    WebSocket: FakeSocket, AudioContext: FakeContext, AudioWorkletNode: FakeNode, ...timerGlobals,
    navigator: { mediaDevices: { async getUserMedia() {
      const track = { readyState: "live", stop() { this.readyState = "ended"; }, addEventListener(_: string, listener: () => void) { this.ended = listener; } } as (typeof tracks)[number] & { addEventListener(type: string, listener: () => void): void };
      tracks.push(track);
      return { getTracks: () => [track], getAudioTracks: () => [track] };
    } } },
  });
  const restore = () => { restoreGlobals(); restoreUrls(); };
  return {
    tracks, contexts, nodes, sockets, restore, pending,
    /** Advance scripted time, running due timers in order. */
    advance(ms: number) { now += ms; for (const timer of [...pending].sort((a, b) => a.at - b.at)) if (timer.at <= now && pending.includes(timer)) { pending.splice(pending.indexOf(timer), 1); timer.run(); } },
    /** One block of hardware-rate microphone audio, as the worklet posts it. */
    speak(samples: number, frequency = 440, amplitude = 0.3) {
      const block = new Float32Array(samples);
      for (let i = 0; i < samples; i++) block[i] = Math.sin((2 * Math.PI * frequency * i) / rate) * amplitude;
      nodes.at(-1)!.port.onmessage?.({ data: block });
    },
    /** Hardware-rate samples through the real worklet, in 128-sample render quanta. */
    render(samples: Float32Array) {
      const processor = nodes.at(-1)!.processor;
      for (let at = 0; at < samples.length; at += 128) processor.process([[samples.subarray(at, Math.min(at + 128, samples.length))]]);
    },
  };
}

// Captured before any test scripts timers, so a tick is always real.
const realSetTimeout = globalThis.setTimeout;
const tick = () => new Promise<void>((resolve) => realSetTimeout(resolve, 0));
let cleanup: Array<() => void> = [];
afterEach(() => { for (const restore of cleanup.splice(0).reverse()) restore(); });

function harness({ params = PARAMS, ...options }: Parameters<typeof scriptedBrowser>[0] & { params?: Record<string, string> } = {}) {
  const browser = scriptedBrowser(options);
  cleanup.push(browser.restore);
  const events: AsrEvent[] = [], errors: Error[] = [];
  let closes = 0;
  const client = new GeminiAsrClient({ url: URL_, token: TOKEN, params, onEvent: (event) => events.push(event), onError: (error) => errors.push(error), onClose: () => { closes++; } });
  cleanup.push(() => client.stop());
  return { ...browser, client, events, errors, closes: () => closes, socket: () => browser.sockets[0]! };
}

runAsrClientContract({
  name: "GeminiAsrClient with scripted microphone, worklet and Live socket",
  session: SESSION,
  create(options) {
    const browser = scriptedBrowser();
    const client = new GeminiAsrClient({ url: options.session.url, token: options.session.token!, params: options.session.params!, onEvent: options.onEvent, onError: options.onError });
    const socket = () => browser.sockets[0]!;
    const deliver = async (event: AsrEvent) => {
      await tick();
      socket().server(event.type === "partial" ? { serverContent: { interimInputTranscription: { text: event.text } } }
        : { serverContent: { inputTranscription: { text: event.text, finished: event.endsTurn } } });
      await tick();
    };
    return {
      client,
      captureActive: () => browser.tracks.some((track) => track.readyState === "live"),
      connectionActive: () => browser.sockets.some((s) => s.readyState < 2),
      deliver,
      async fail() { await tick(); socket().onerror?.(); },
      async finishDrain(event) {
        expect(JSON.parse(socket().sent.at(-1)!)).toEqual({ realtimeInput: { audioStreamEnd: true } });
        await deliver(event);
        socket().server({ serverContent: { turnComplete: true } });
        await tick();
      },
      dispose: browser.restore,
    };
  },
}, { describe, test, expect });

/** Dominant frequency of PCM16 by zero crossings. */
function frequency(samples: Int16Array, rate: number): number {
  let crossings = 0;
  for (let i = 1; i < samples.length; i++) if ((samples[i - 1]! < 0) !== (samples[i]! < 0)) crossings++;
  return (crossings / 2) * (rate / samples.length);
}

function decode(frames: Array<{ data: string }>): Int16Array {
  const bytes = frames.flatMap((frame) => [...Uint8Array.from(atob(frame.data), (char) => char.charCodeAt(0))]);
  const view = new DataView(new Uint8Array(bytes).buffer);
  return Int16Array.from({ length: bytes.length / 2 }, (_, i) => view.getInt16(i * 2, true));
}

describe("PCM resampling", () => {
  for (const rate of [44_100, 48_000, 16_000]) test(`a ${rate} Hz hardware context becomes 16 kHz PCM16 with the same pitch`, () => {
    const resample = createPcmResampler(rate, 16_000);
    const out: number[] = [];
    // Two seconds in uneven worklet-sized blocks: boundaries must not drift.
    let produced = 0;
    for (const size of [4096, 4096, 1000, 4096, 333]) {
      for (let k = 0; k < Math.ceil((rate * 2) / 13_621); k++) {
        const block = Float32Array.from({ length: size }, (_, i) => Math.sin((2 * Math.PI * 440 * (produced + i)) / rate) * 0.5);
        produced += size;
        out.push(...resample(block));
      }
    }
    const samples = Int16Array.from(out);
    expect(Math.abs(samples.length - produced * (16_000 / rate)), "GEMINI_RESAMPLED_16K sample count").toBeLessThanOrEqual(2);
    expect(Math.abs(frequency(samples, 16_000) - 440), "GEMINI_RESAMPLED_16K pitch").toBeLessThan(5);
  });
});

describe("GeminiAsrClient wire behaviour", () => {
  test("connects with the token as access_token and sends the locked setup first", async () => {
    const h = harness();
    await h.client.start();
    await tick();
    const url = new URL(h.socket().url);
    expect(url.origin + url.pathname).toBe(URL_);
    expect(url.searchParams.get("access_token")).toBe(TOKEN);
    expect(h.socket().binaryType).toBe("arraybuffer");
    expect(JSON.parse(h.socket().sent[0]!), "GEMINI_SETUP_REPEATS_LANGUAGE").toEqual({ setup: {
      model: "models/gemini-3.5-transcribe-live",
      generationConfig: { responseModalities: ["TEXT"] },
      inputAudioTranscription: { mode: "SMART", languageCodes: ["en-US"], customVocabulary: ["Ithaca", "Penelope"] },
    } });
  });

  for (const [name, languageCodes] of [
    ["missing", undefined], ["not JSON", "en-US"], ["empty", "[]"], ["not a language tag", JSON.stringify(["en US"])], ["too many", JSON.stringify(["en-US", "en-GB", "de-DE", "fr-FR", "es-ES"])],
  ] as const) test(`a ${name} languageCodes param omits the hint; the token still locks it server side`, async () => {
    const { languageCodes: _, ...rest } = PARAMS;
    const h = harness({ params: languageCodes === undefined ? rest : { ...rest, languageCodes } });
    await h.client.start();
    await tick();
    expect(JSON.parse(h.socket().sent[0]!).setup.inputAudioTranscription, "GEMINI_LANGUAGE_PARAM_VALIDATED").toEqual({ mode: "SMART", customVocabulary: ["Ithaca", "Penelope"] });
  });

  test("a verbatim session without vocabulary sets up verbatim with no customVocabulary", async () => {
    const browser = scriptedBrowser();
    cleanup.push(browser.restore);
    const client = new GeminiAsrClient({ url: URL_, token: TOKEN, params: { ...PARAMS, mode: "VERBATIM", vocabulary: "[]" }, onEvent() {} });
    cleanup.push(() => client.stop());
    await client.start();
    await tick();
    expect(JSON.parse(browser.sockets[0]!.sent[0]!).setup.inputAudioTranscription).toEqual({ mode: "VERBATIM", languageCodes: ["en-US"] });
  });

  test("streams 100 ms base64 PCM16 frames at 16 kHz from a 48 kHz context", async () => {
    const h = harness();
    await h.client.start();
    await tick(); await tick();
    for (let i = 0; i < 10; i++) h.speak(4096);
    const frames = h.socket().audio();
    // Hardware-rate samples labelled 16 kHz would carry the tone at 1,320 Hz.
    expect(Math.abs(frequency(decode(frames.slice(0, 8)), 16_000) - 440), "GEMINI_RESAMPLED_16K").toBeLessThan(10);
    expect(frames.length, "GEMINI_RESAMPLED_16K frame count").toBe(Math.floor(Math.floor((10 * 4096) / 3) / GEMINI_FRAME_SAMPLES));
    for (const frame of frames) {
      expect(frame.mimeType).toBe("audio/pcm;rate=16000");
      expect(atob(frame.data).length).toBe(3200);
    }
  });

  test("audio before setupComplete waits, in order, up to 5 s; then it is sent", async () => {
    const h = harness({ answerSetup: false });
    await h.client.start();
    await tick();
    for (let i = 0; i < GEMINI_PRESETUP_FRAMES; i++) h.speak(GEMINI_FRAME_SAMPLES * 3);
    expect(h.socket().audio()).toHaveLength(0);
    expect(h.errors).toHaveLength(0);
    h.socket().server({ setupComplete: {} });
    await tick();
    expect(h.socket().audio()).toHaveLength(GEMINI_PRESETUP_FRAMES);
  });

  test("more than 5 s before setupComplete fails the take with a network error instead of dropping audio", async () => {
    const h = harness({ answerSetup: false });
    await h.client.start();
    await tick();
    for (let i = 0; i <= GEMINI_PRESETUP_FRAMES; i++) h.speak(GEMINI_FRAME_SAMPLES * 3);
    expect(h.errors.map((error) => (error as Error & { code?: string }).code)).toEqual(["network"]);
    expect(h.closes()).toBe(1);
    expect(h.tracks.every((track) => track.readyState === "ended")).toBe(true);
    expect(h.socket().readyState).toBe(3);
  });

  test("the handshake is bounded at 10 s", async () => {
    const h = harness({ answerSetup: false, timers: true });
    await h.client.start();
    h.advance(GEMINI_HANDSHAKE_MS - 1);
    expect(h.errors).toHaveLength(0);
    h.advance(1);
    expect(h.errors.map((error) => (error as Error & { code?: string }).code)).toEqual(["network"]);
    expect(h.closes()).toBe(1);
    expect(h.contexts[0]!.state).toBe("closed");
  });

  test("an upload backlog over 256 KiB fails the take with a network error", async () => {
    const h = harness();
    await h.client.start();
    await tick(); await tick();
    h.speak(GEMINI_FRAME_SAMPLES * 3);
    expect(h.socket().audio()).toHaveLength(1);
    h.socket().bufferedAmount = GEMINI_MAX_BUFFERED_BYTES + 1;
    h.speak(GEMINI_FRAME_SAMPLES * 3);
    expect(h.socket().audio()).toHaveLength(1);
    expect(h.errors.map((error) => (error as Error & { code?: string }).code)).toEqual(["network"]);
    expect(h.closes()).toBe(1);
    expect(h.tracks[0]!.readyState).toBe("ended");
  });

  test("interim text replaces the partial and each finalized segment commits exactly once", async () => {
    const h = harness();
    await h.client.start();
    await tick(); await tick();
    const s = h.socket();
    s.server({ serverContent: { interimInputTranscription: { text: "Ask Nes" } } });
    s.server({ serverContent: { interimInputTranscription: { text: "Ask Nestor about" } } });
    s.server({ serverContent: { inputTranscription: { text: "Ask Nestor about the ships.", finished: true } } });
    s.server({ serverContent: { interimInputTranscription: { text: "and the" } } });
    s.server({ serverContent: { inputTranscription: { text: "And the harbor.", finished: false } } });
    s.server({ serverContent: { turnComplete: true } });
    await tick();
    expect(h.events, "GEMINI_FINAL_COMMITS_ONCE").toEqual([
      { type: "partial", text: "Ask Nes" },
      { type: "partial", text: "Ask Nestor about" },
      { type: "final", text: "Ask Nestor about the ships.", endsTurn: true },
      { type: "partial", text: "and the" },
      { type: "final", text: "And the harbor.", endsTurn: false },
    ]);
  });

  test("a final without finished ends the turn", async () => {
    const h = harness();
    await h.client.start();
    await tick(); await tick();
    h.socket().server({ serverContent: { inputTranscription: { text: "Ithaca at dawn." } } });
    await tick();
    expect(h.events).toEqual([{ type: "final", text: "Ithaca at dawn.", endsTurn: true }]);
  });

  test("Done flushes the partial frame, sends audioStreamEnd and waits for the final", async () => {
    const h = harness();
    await h.client.start();
    await tick(); await tick();
    h.speak(GEMINI_FRAME_SAMPLES * 3 + 300);
    let settled = false;
    const draining = h.client.drainAndStop().then(() => { settled = true; });
    await tick();
    const audio = h.socket().audio();
    expect(audio.map((frame) => atob(frame.data).length)).toEqual([3200, 200]);
    expect(JSON.parse(h.socket().sent.at(-1)!)).toEqual({ realtimeInput: { audioStreamEnd: true } });
    expect(h.tracks[0]!.readyState, "the microphone closes at Done").toBe("ended");
    await tick();
    expect(settled).toBe(false);
    h.socket().server({ serverContent: { inputTranscription: { text: "Departure tomorrow.", finished: true } } });
    await draining;
    expect(h.events).toEqual([{ type: "final", text: "Departure tomorrow.", endsTurn: true }]);
    expect(h.socket().readyState).toBe(3);
    expect(h.closes(), "Done is not a provider end").toBe(0);
  });

  test("Done flushes the worklet's partial block: its samples reach the socket before audioStreamEnd", async () => {
    // A 16 kHz context, so the resampler passes samples through one to one.
    const h = harness({ rate: 16_000 });
    await h.client.start();
    await tick(); await tick();
    // One full worklet block, then 3,968 samples the worklet holds short of
    // the next one: about 250 ms of the last words at 16 kHz.
    const tail = PCM_CAPTURE_BLOCK - 128;
    const spoken = Float32Array.from({ length: PCM_CAPTURE_BLOCK + tail }, (_, i) => Math.sin((2 * Math.PI * 440 * i) / 16_000) * 0.3);
    h.render(spoken);
    await tick();
    const beforeDone = decode(h.socket().audio()).length;
    expect(beforeDone, "only whole worklet blocks flow while live").toBe(Math.floor(PCM_CAPTURE_BLOCK / GEMINI_FRAME_SAMPLES) * GEMINI_FRAME_SAMPLES);
    const draining = h.client.drainAndStop();
    await tick(); await tick();
    const sent = h.socket().sent.map((frame) => JSON.parse(frame));
    const end = sent.findIndex((frame) => frame.realtimeInput?.audioStreamEnd === true);
    expect(end, "audioStreamEnd is sent").toBeGreaterThan(0);
    expect(sent.slice(end + 1).some((frame) => frame.realtimeInput?.audio), "no audio after audioStreamEnd").toBe(false);
    const received = decode(sent.slice(0, end).filter((frame) => frame.realtimeInput?.audio).map((frame) => frame.realtimeInput.audio));
    const expected = createPcmResampler(16_000, 16_000)(spoken);
    expect(received.length, "GEMINI_DONE_KEEPS_WORKLET_TAIL").toBe(spoken.length);
    expect([...received], "GEMINI_DONE_KEEPS_WORKLET_TAIL samples").toEqual([...expected]);
    expect(h.tracks[0]!.readyState, "the microphone closes once the tail is in").toBe("ended");
    h.socket().server({ serverContent: { turnComplete: true } });
    await draining;
  });

  test("hard stop does not wait for the worklet's tail", async () => {
    const h = harness({ rate: 16_000 });
    await h.client.start();
    await tick(); await tick();
    h.render(new Float32Array(1_000).fill(0.2));
    h.client.stop();
    expect(h.tracks[0]!.readyState).toBe("ended");
    expect(h.socket().readyState).toBe(3);
    await tick(); await tick();
    expect(h.socket().audio(), "nothing of the tail is sent").toHaveLength(0);
    expect(h.socket().sent.some((frame) => JSON.parse(frame).realtimeInput?.audioStreamEnd), "no graceful end").toBe(false);
  });

  for (const [name, end, code] of [
    ["an abnormal close", (s: ReturnType<typeof harness>) => s.socket().end(1011), "network"],
    ["a socket error", (s: ReturnType<typeof harness>) => s.socket().onerror?.(), "network"],
    ["a model error", (s: ReturnType<typeof harness>) => s.socket().server({ error: { message: `Token ${TOKEN} rejected` } }), "unknown"],
    ["Google's clean close", (s: ReturnType<typeof harness>) => s.socket().end(1000), null],
  ] as const) test(`${name} during Done settles the drain${code ? " and reports a failure" : " as a clean end"}`, async () => {
    const h = harness();
    await h.client.start();
    await tick(); await tick();
    h.socket().server({ serverContent: { inputTranscription: { text: "Ask Nestor", finished: false } } });
    await tick();
    let settled = false;
    const draining = h.client.drainAndStop().then(() => { settled = true; });
    await tick();
    expect(settled).toBe(false);
    end(h);
    await draining;
    expect(h.errors.map((error) => (error as Error & { code?: string }).code), "GEMINI_DRAIN_CLOSE_CLASSIFIED").toEqual(code ? [code] : []);
    for (const error of h.errors) expect(error.message).not.toContain(TOKEN);
    expect(h.events).toEqual([{ type: "final", text: "Ask Nestor", endsTurn: false }]);
    expect(h.closes(), "Done is not a provider end").toBe(0);
    expect(h.contexts[0]!.state).toBe("closed");
  });

  test("Done is bounded at 3 s when speech is pending and no final arrives", async () => {
    const h = harness({ timers: true });
    await h.client.start();
    await tick(); await tick();
    h.socket().server({ serverContent: { interimInputTranscription: { text: "Ask Nes" } } });
    await tick();
    let settled = false;
    const draining = h.client.drainAndStop().then(() => { settled = true; });
    await tick(); await tick();
    h.advance(GEMINI_DRAIN_MS - 1);
    await tick();
    expect(settled).toBe(false);
    h.advance(1);
    await draining;
    expect(h.socket().readyState).toBe(3);
    expect(h.contexts[0]!.state).toBe("closed");
  });

  // Measured against Google in #3710: after audioStreamEnd the pending final
  // arrives with generationComplete, and nothing at all arrives when no speech
  // is pending; finished and turnComplete never came.
  test("with speech pending, Done resolves on the generationComplete that follows audioStreamEnd", async () => {
    const h = harness({ timers: true });
    await h.client.start();
    await tick(); await tick();
    const s = h.socket();
    s.server({ serverContent: { speechState: "SPEECH" } });
    s.server({ serverContent: { interimInputTranscription: { text: "Odysseus leaves the island at" } } });
    await tick();
    let settled = false;
    const draining = h.client.drainAndStop().then(() => { settled = true; });
    await tick(); await tick();
    expect(JSON.parse(s.sent.at(-1)!)).toEqual({ realtimeInput: { audioStreamEnd: true } });
    h.advance(GEMINI_DRAIN_QUIET_MS * 2);
    await tick();
    expect(settled, "pending speech is not cut off by the quiet window").toBe(false);
    s.server({ serverContent: { inputTranscription: { text: "Odysseus leaves the island at dawn." } } });
    s.server({ serverContent: { generationComplete: true } });
    await tick();
    expect(settled, "GEMINI_DRAIN_ON_GENERATION_COMPLETE").toBe(true);
    await draining;
    expect(h.events.at(-1)).toEqual({ type: "final", text: "Odysseus leaves the island at dawn.", endsTurn: true });
    expect(h.socket().readyState).toBe(3);
    expect(h.contexts[0]!.state).toBe("closed");
  });

  test("a generationComplete before audioStreamEnd is sent does not end the drain", async () => {
    // Without setupComplete the stream end waits, so audioStreamEnd is
    // deterministically unsent while Google's message is handled.
    const h = harness({ timers: true, answerSetup: false });
    await h.client.start();
    await tick();
    const s = h.socket();
    h.speak(GEMINI_FRAME_SAMPLES * 3);
    let settled = false;
    const draining = h.client.drainAndStop().then(() => { settled = true; });
    await tick(); await tick();
    s.server({ serverContent: { generationComplete: true } });
    await tick(); await tick();
    expect(s.sent.some((frame) => JSON.parse(frame).realtimeInput?.audioStreamEnd), "audioStreamEnd not yet sent").toBe(false);
    expect(settled, "GEMINI_DRAIN_WAITS_FOR_STREAM_END").toBe(false);
    s.server({ setupComplete: {} });
    await tick();
    expect(JSON.parse(s.sent.at(-1)!)).toEqual({ realtimeInput: { audioStreamEnd: true } });
    // The voiced audio was never placed in a segment, so the tail window applies.
    h.advance(GEMINI_DRAIN_TAIL_MS);
    await draining;
  });

  test("with nothing pending, Done resolves after the quiet window instead of the 3 s cap", async () => {
    const h = harness({ timers: true });
    await h.client.start();
    await tick(); await tick();
    h.socket().server({ serverContent: { inputTranscription: { text: "Ask Nestor about the ships." } } });
    h.socket().server({ serverContent: { generationComplete: true } });
    await tick();
    let settled = false;
    const draining = h.client.drainAndStop().then(() => { settled = true; });
    await tick(); await tick();
    expect(JSON.parse(h.socket().sent.at(-1)!)).toEqual({ realtimeInput: { audioStreamEnd: true } });
    h.advance(GEMINI_DRAIN_QUIET_MS - 1);
    await tick();
    expect(settled).toBe(false);
    h.advance(1);
    await tick();
    expect(settled, "GEMINI_DRAIN_QUIET_WITHOUT_PENDING").toBe(true);
    await draining;
    expect(h.socket().readyState).toBe(3);
  });

  for (const [name, message] of [
    ["speech", { serverContent: { speechState: "SPEECH" } }],
    ["an interim", { serverContent: { interimInputTranscription: { text: "and the" } } }],
  ] as const) test(`${name} inside the quiet window extends the drain to generationComplete`, async () => {
    const h = harness({ timers: true });
    await h.client.start();
    await tick(); await tick();
    let settled = false;
    const draining = h.client.drainAndStop().then(() => { settled = true; });
    await tick(); await tick();
    h.advance(GEMINI_DRAIN_QUIET_MS - 100);
    h.socket().server(message);
    await tick();
    h.advance(GEMINI_DRAIN_QUIET_MS * 3);
    await tick();
    expect(settled, "GEMINI_DRAIN_QUIET_EXTENDED").toBe(false);
    h.socket().server({ serverContent: { inputTranscription: { text: "And the harbor." } } });
    h.socket().server({ serverContent: { generationComplete: true } });
    await draining;
    expect(h.events.at(-1)).toEqual({ type: "final", text: "And the harbor.", endsTurn: true });
  });

  // Offsets below are in 16 kHz samples: a 16 kHz context passes them through.
  const offset = (samples: number) => `${(samples / 16_000).toFixed(3)}s`;

  test("voice the microphone heard but Google has not yet signalled keeps Done open past the short quiet", async () => {
    const h = harness({ rate: 16_000, timers: true });
    await h.client.start();
    await tick(); await tick();
    const s = h.socket();
    // The last word, right before Done: Google has not answered it yet.
    h.speak(GEMINI_FRAME_SAMPLES * 2);
    let settled = false;
    const draining = h.client.drainAndStop().then(() => { settled = true; });
    await tick(); await tick();
    expect(JSON.parse(s.sent.at(-1)!)).toEqual({ realtimeInput: { audioStreamEnd: true } });
    h.advance(GEMINI_DRAIN_QUIET_MS * 2);
    await tick();
    expect(settled, "GEMINI_DRAIN_WAITS_FOR_UNSIGNALLED_VOICE").toBe(false);
    s.server({ serverContent: { speechState: "SPEECH" }, voiceActivity: { type: "ACTIVITY_START", audioOffset: offset(0) } });
    await tick();
    h.advance(GEMINI_DRAIN_TAIL_MS);
    await tick();
    expect(settled, "an open segment waits for its completion").toBe(false);
    s.server({ serverContent: { inputTranscription: { text: "Ithaca." } } });
    s.server({ serverContent: { generationComplete: true } });
    s.server({ serverContent: { speechState: "NON_SPEECH" }, voiceActivity: { type: "ACTIVITY_END", audioOffset: offset(GEMINI_FRAME_SAMPLES * 2) } });
    await tick();
    expect(settled, "GEMINI_DRAIN_ENDS_ON_ACTIVITY_END").toBe(true);
    await draining;
    expect(h.events, "GEMINI_DRAIN_WAITS_FOR_UNSIGNALLED_VOICE").toEqual([{ type: "final", text: "Ithaca.", endsTurn: true }]);
  });

  test("an earlier segment's completion arriving after audioStreamEnd does not end Done before the new speech", async () => {
    const h = harness({ rate: 16_000, timers: true });
    await h.client.start();
    await tick(); await tick();
    const s = h.socket();
    const first = GEMINI_FRAME_SAMPLES * 4;
    h.speak(first);
    h.speak(GEMINI_FRAME_SAMPLES * 3, 440, 0);
    s.server({ serverContent: { speechState: "SPEECH" }, voiceActivity: { type: "ACTIVITY_START", audioOffset: offset(0) } });
    await tick();
    // The second sentence starts; Google is still finishing the first.
    h.speak(GEMINI_FRAME_SAMPLES * 2);
    let settled = false;
    const draining = h.client.drainAndStop().then(() => { settled = true; });
    await tick(); await tick();
    // The first segment's answer was already in flight.
    s.server({ serverContent: { inputTranscription: { text: "Ask Nestor." } } });
    s.server({ serverContent: { generationComplete: true } });
    s.server({ serverContent: { speechState: "NON_SPEECH" }, voiceActivity: { type: "ACTIVITY_END", audioOffset: offset(first + GEMINI_FRAME_SAMPLES) } });
    await tick();
    h.advance(GEMINI_DRAIN_QUIET_MS * 2);
    await tick();
    expect(settled, "GEMINI_DRAIN_IGNORES_EARLIER_COMPLETION").toBe(false);
    s.server({ serverContent: { speechState: "SPEECH" }, voiceActivity: { type: "ACTIVITY_START", audioOffset: offset(first + GEMINI_FRAME_SAMPLES * 3) } });
    s.server({ serverContent: { inputTranscription: { text: "Then the ships." } } });
    s.server({ serverContent: { generationComplete: true } });
    s.server({ serverContent: { speechState: "NON_SPEECH" }, voiceActivity: { type: "ACTIVITY_END", audioOffset: offset(first + GEMINI_FRAME_SAMPLES * 5) } });
    await tick();
    expect(settled, "GEMINI_DRAIN_ENDS_ON_ACTIVITY_END").toBe(true);
    await draining;
    expect(h.events.map((event) => event.text), "GEMINI_DRAIN_IGNORES_EARLIER_COMPLETION").toEqual(["Ask Nestor.", "Then the ships."]);
  });

  test("silence after the last segment Google closed ends Done after the short quiet", async () => {
    const h = harness({ rate: 16_000, timers: true });
    await h.client.start();
    await tick(); await tick();
    const s = h.socket();
    h.speak(GEMINI_FRAME_SAMPLES * 2);
    s.server({ serverContent: { speechState: "SPEECH" } });
    s.server({ serverContent: { inputTranscription: { text: "Ithaca." } } });
    s.server({ serverContent: { generationComplete: true } });
    s.server({ serverContent: { speechState: "NON_SPEECH" }, voiceActivity: { type: "ACTIVITY_END", audioOffset: offset(GEMINI_FRAME_SAMPLES * 2) } });
    await tick();
    h.speak(GEMINI_FRAME_SAMPLES * 4, 440, 0.005);
    let settled = false;
    const draining = h.client.drainAndStop().then(() => { settled = true; });
    await tick(); await tick();
    h.advance(GEMINI_DRAIN_QUIET_MS);
    await tick();
    expect(settled, "GEMINI_DRAIN_SILENCE_IS_NOT_VOICE").toBe(true);
    await draining;
  });

  test("an earlier segment's answer that ends short of the stream end waits the short quiet for quieter speech", async () => {
    const h = harness({ rate: 16_000, timers: true });
    await h.client.start();
    await tick(); await tick();
    const s = h.socket();
    const first = GEMINI_FRAME_SAMPLES * 2;
    h.speak(first);
    s.server({ serverContent: { speechState: "SPEECH" } });
    await tick();
    h.speak(GEMINI_FRAME_SAMPLES * 6, 440, 0);
    // Speech below the voice bar: the microphone cannot tell it from silence.
    h.speak(GEMINI_FRAME_SAMPLES * 2, 440, 0.012);
    let settled = false;
    const draining = h.client.drainAndStop().then(() => { settled = true; });
    await tick(); await tick();
    s.server({ serverContent: { inputTranscription: { text: "Ask Nestor." } } });
    s.server({ serverContent: { generationComplete: true } });
    s.server({ serverContent: { speechState: "NON_SPEECH" }, voiceActivity: { type: "ACTIVITY_END", audioOffset: offset(first + GEMINI_FRAME_SAMPLES * 4) } });
    await tick();
    expect(settled, "GEMINI_DRAIN_QUIET_AFTER_PARTIAL_ANSWER").toBe(false);
    h.advance(75);
    s.server({ serverContent: { speechState: "SPEECH" } });
    await tick();
    h.advance(GEMINI_DRAIN_QUIET_MS);
    await tick();
    expect(settled, "the quieter speech is now an open segment").toBe(false);
    s.server({ serverContent: { inputTranscription: { text: "Quietly." } } });
    s.server({ serverContent: { generationComplete: true } });
    s.server({ serverContent: { speechState: "NON_SPEECH" }, voiceActivity: { type: "ACTIVITY_END", audioOffset: offset(first + GEMINI_FRAME_SAMPLES * 8) } });
    await tick();
    expect(settled, "GEMINI_DRAIN_ENDS_ON_ACTIVITY_END").toBe(true);
    await draining;
    expect(h.events.map((event) => event.text)).toEqual(["Ask Nestor.", "Quietly."]);
  });

  test("a message that says nothing about speech does not end Done", async () => {
    const h = harness({ timers: true });
    await h.client.start();
    await tick(); await tick();
    let settled = false;
    const draining = h.client.drainAndStop().then(() => { settled = true; });
    await tick(); await tick();
    h.socket().server({ serverContent: {} });
    await tick();
    expect(settled, "GEMINI_DRAIN_IGNORES_UNRELATED").toBe(false);
    h.advance(GEMINI_DRAIN_QUIET_MS);
    await tick();
    expect(settled).toBe(true);
    await draining;
  });

  for (const [name, message] of [
    ["finished", { serverContent: { inputTranscription: { text: "Ask Nestor.", finished: true } } }],
    ["turnComplete", { serverContent: { turnComplete: true } }],
  ] as const) test(`an earlier segment's ${name} does not end Done before voice Google has not placed`, async () => {
    const h = harness({ rate: 16_000, timers: true });
    await h.client.start();
    await tick(); await tick();
    const s = h.socket();
    h.speak(GEMINI_FRAME_SAMPLES * 2);
    h.speak(GEMINI_FRAME_SAMPLES * 6, 440, 0);
    h.speak(GEMINI_FRAME_SAMPLES * 2);
    let settled = false;
    const draining = h.client.drainAndStop().then(() => { settled = true; });
    await tick(); await tick();
    s.server(message);
    s.server({ serverContent: { speechState: "NON_SPEECH" }, voiceActivity: { type: "ACTIVITY_END", audioOffset: offset(GEMINI_FRAME_SAMPLES * 4) } });
    await tick();
    expect(settled, "GEMINI_DRAIN_FLAGGED_COMPLETION").toBe(false);
    s.server({ serverContent: { speechState: "SPEECH" } });
    s.server({ serverContent: { inputTranscription: { text: "Then the ships." }, generationComplete: true } });
    s.server({ serverContent: { speechState: "NON_SPEECH" }, voiceActivity: { type: "ACTIVITY_END", audioOffset: offset(GEMINI_FRAME_SAMPLES * 10) } });
    await draining;
    expect(h.events.at(-1)).toEqual({ type: "final", text: "Then the ships.", endsTurn: true });
  });

  test("an ACTIVITY_END Google rounded down to 10 ms still reaches the stream end", async () => {
    const h = harness({ rate: 16_000, timers: true });
    await h.client.start();
    await tick(); await tick();
    const s = h.socket();
    const streamed = GEMINI_FRAME_SAMPLES * 3 + 37;
    h.speak(streamed);
    s.server({ serverContent: { speechState: "SPEECH" } });
    await tick();
    let settled = false;
    const draining = h.client.drainAndStop().then(() => { settled = true; });
    await tick(); await tick();
    s.server({ serverContent: { inputTranscription: { text: "Ithaca." }, generationComplete: true } });
    s.server({ serverContent: { speechState: "NON_SPEECH" }, voiceActivity: { type: "ACTIVITY_END", audioOffset: `${(Math.floor(streamed / 160) / 100).toFixed(2)}s` } });
    await tick();
    expect(settled, "GEMINI_DRAIN_OFFSET_ROUNDING").toBe(true);
    await draining;
  });

  test("speech messages do not extend a running tail window", async () => {
    const h = harness({ rate: 16_000, timers: true });
    await h.client.start();
    await tick(); await tick();
    h.speak(GEMINI_FRAME_SAMPLES * 2);
    let settled = false;
    const draining = h.client.drainAndStop().then(() => { settled = true; });
    await tick(); await tick();
    h.advance(GEMINI_DRAIN_TAIL_MS - 500);
    h.socket().server({ serverContent: { speechState: "NON_SPEECH" } });
    await tick();
    h.advance(500);
    await tick();
    expect(settled, "GEMINI_DRAIN_TAIL_NOT_EXTENDED").toBe(true);
    await draining;
  });

  test("voice Google never calls speech ends Done at the tail window, not the 3 s cap", async () => {
    const h = harness({ rate: 16_000, timers: true });
    await h.client.start();
    await tick(); await tick();
    h.speak(GEMINI_FRAME_SAMPLES * 2);
    let settled = false;
    const draining = h.client.drainAndStop().then(() => { settled = true; });
    await tick(); await tick();
    h.advance(GEMINI_DRAIN_TAIL_MS - 1);
    await tick();
    expect(settled).toBe(false);
    h.advance(1);
    await tick();
    expect(settled, "GEMINI_DRAIN_TAIL_BOUNDED").toBe(true);
    await draining;
  });

  test("a final that arrived before the quiet lapsed but is still decoding reaches review", async () => {
    const h = harness({ timers: true });
    await h.client.start();
    await tick(); await tick();
    const s = h.socket();
    let release!: () => void;
    const decoded = new Promise<void>((resolve) => { release = resolve; });
    class SlowBlob extends Blob { override async text() { await decoded; return super.text(); } }
    let settled = false;
    const draining = h.client.drainAndStop().then(() => { settled = true; });
    await tick(); await tick();
    h.advance(GEMINI_DRAIN_QUIET_MS - 50);
    s.onmessage?.({ data: new SlowBlob([JSON.stringify({ serverContent: { inputTranscription: { text: "Penelope waits." } } })]) });
    h.advance(50);
    await tick();
    expect(settled, "the quiet waits for messages that already arrived").toBe(false);
    release();
    await draining;
    expect(h.events, "GEMINI_DRAIN_WAITS_FOR_INBOUND").toEqual([{ type: "final", text: "Penelope waits.", endsTurn: true }]);
  });

  test("speech still decoding when the quiet lapses keeps Done open for its completion", async () => {
    const h = harness({ timers: true });
    await h.client.start();
    await tick(); await tick();
    const s = h.socket();
    let release!: () => void;
    const decoded = new Promise<void>((resolve) => { release = resolve; });
    class SlowBlob extends Blob { override async text() { await decoded; return super.text(); } }
    let settled = false;
    const draining = h.client.drainAndStop().then(() => { settled = true; });
    await tick(); await tick();
    h.advance(GEMINI_DRAIN_QUIET_MS - 50);
    s.onmessage?.({ data: new SlowBlob([JSON.stringify({ serverContent: { interimInputTranscription: { text: "Penelope" } } })]) });
    h.advance(50);
    release();
    await tick(); await tick();
    expect(settled, "GEMINI_DRAIN_LAPSED_QUIET_YIELDS").toBe(false);
    s.server({ serverContent: { inputTranscription: { text: "Penelope waits." }, generationComplete: true } });
    await draining;
    expect(h.events.at(-1)).toEqual({ type: "final", text: "Penelope waits.", endsTurn: true });
  });

  test("a final and its completion in one message end Done at once", async () => {
    const h = harness({ timers: true });
    await h.client.start();
    await tick(); await tick();
    const s = h.socket();
    s.server({ serverContent: { speechState: "SPEECH" } });
    await tick();
    let settled = false;
    const draining = h.client.drainAndStop().then(() => { settled = true; });
    await tick(); await tick();
    s.server({ serverContent: { inputTranscription: { text: "Sail at dawn." }, generationComplete: true } });
    await tick();
    expect(settled, "GEMINI_DRAIN_COMBINED_COMPLETION").toBe(true);
    await draining;
    expect(h.events).toEqual([{ type: "final", text: "Sail at dawn.", endsTurn: true }]);
  });

  test("a final without generationComplete after audioStreamEnd ends Done once nothing is left unplaced", async () => {
    const h = harness({ timers: true });
    await h.client.start();
    await tick(); await tick();
    const s = h.socket();
    s.server({ serverContent: { interimInputTranscription: { text: "Sail at" } } });
    await tick();
    let settled = false;
    const draining = h.client.drainAndStop().then(() => { settled = true; });
    await tick(); await tick();
    s.server({ serverContent: { inputTranscription: { text: "Sail at dawn." } } });
    await tick();
    expect(settled, "GEMINI_DRAIN_FINAL_WITHOUT_COMPLETION").toBe(true);
    await draining;
  });

  test("hard stop during the quiet window leaves no timer behind", async () => {
    const h = harness({ timers: true });
    await h.client.start();
    await tick(); await tick();
    const draining = h.client.drainAndStop();
    await tick(); await tick();
    expect(h.pending.length, "the cap and the quiet window are armed").toBe(2);
    h.client.stop();
    await draining;
    expect(h.pending, "GEMINI_DRAIN_STOP_CLEARS_QUIET").toHaveLength(0);
  });

  test("Done before setupComplete sends the waiting audio and the stream end once setup completes", async () => {
    const h = harness({ answerSetup: false });
    await h.client.start();
    await tick();
    h.speak(GEMINI_FRAME_SAMPLES * 3 * 2);
    const draining = h.client.drainAndStop();
    expect(h.socket().audio()).toHaveLength(0);
    h.socket().server({ setupComplete: {} });
    await tick();
    expect(h.socket().audio()).toHaveLength(2);
    expect(JSON.parse(h.socket().sent.at(-1)!)).toEqual({ realtimeInput: { audioStreamEnd: true } });
    h.socket().server({ serverContent: { turnComplete: true } });
    await draining;
  });

  test("hard stop releases tracks, worklet, context, timers, queue and socket; late messages mutate nothing", async () => {
    const h = harness({ answerSetup: false, timers: true });
    await h.client.start();
    await tick();
    h.speak(GEMINI_FRAME_SAMPLES * 3);
    const socket = h.socket();
    const handler = socket.onmessage!;
    h.client.stop();
    expect(h.tracks[0]!.readyState).toBe("ended");
    expect(h.nodes[0]!.connected).toBe(false);
    expect(h.nodes[0]!.port.onmessage).toBe(null);
    expect(h.contexts[0]!.closes, "GEMINI_TEARDOWN_CONTEXT_CLOSED").toBe(1);
    expect(h.contexts[0]!.state, "GEMINI_TEARDOWN_CONTEXT_CLOSED").toBe("closed");
    expect(socket.readyState).toBe(3);
    expect(socket.closeCode).toBe(1000);
    expect(h.pending, "no timer outlives the take").toHaveLength(0);
    handler({ data: JSON.stringify({ setupComplete: {} }) });
    handler({ data: JSON.stringify({ serverContent: { inputTranscription: { text: "Late words", finished: true } } }) });
    await tick();
    expect(socket.audio(), "the queue was discarded").toHaveLength(0);
    expect(h.events).toEqual([]);
    expect(h.errors).toEqual([]);
    expect(h.closes()).toBe(0);
  });

  test("a stop while the microphone opens releases the stream it was granted", async () => {
    const h = harness();
    const starting = h.client.start();
    h.client.stop();
    await starting;
    expect(h.tracks.every((track) => track.readyState === "ended")).toBe(true);
    expect(h.sockets.every((socket) => socket.readyState === 3)).toBe(true);
  });

  for (const [name, end, code] of [
    ["Google's clean close at the session limit", (s: ReturnType<typeof harness>) => s.socket().end(1000), null],
    ["an abnormal close", (s: ReturnType<typeof harness>) => s.socket().end(1011), "network"],
    ["goAway", (s: ReturnType<typeof harness>) => s.socket().server({ goAway: { timeLeft: "5s" } }), "network"],
    ["a model error", (s: ReturnType<typeof harness>) => s.socket().server({ error: { message: `Token ${TOKEN} rejected` } }), "unknown"],
    ["a malformed message", (s: ReturnType<typeof harness>) => s.socket().onmessage?.({ data: "{not json" }), "unknown"],
    ["the microphone track ending", (s: ReturnType<typeof harness>) => s.tracks[0]!.ended?.(), "audio-capture"],
  ] as const) test(`${name} ends the take once, keeping what was heard`, async () => {
    const h = harness();
    await h.client.start();
    await tick(); await tick();
    h.socket().server({ serverContent: { inputTranscription: { text: "Ask Nestor", finished: false } } });
    await tick();
    end(h);
    await tick();
    expect(h.errors.map((error) => (error as Error & { code?: string }).code)).toEqual(code ? [code] : []);
    for (const error of h.errors) expect(error.message).not.toContain(TOKEN);
    expect(h.closes()).toBe(1);
    expect(h.events).toEqual([{ type: "final", text: "Ask Nestor", endsTurn: false }]);
    expect(h.tracks[0]!.readyState).toBe("ended");
    expect(h.contexts[0]!.state).toBe("closed");
    h.socket().onclose?.({ code: 1006 });
    expect(h.closes(), "ends once").toBe(1);
  });
});
