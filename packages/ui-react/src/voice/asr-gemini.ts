// Gemini 3.5 Transcribe Live dictation client (#3708).
// The server mints a single-use constrained token and the constrained Live
// endpoint; this client opens the socket with it, sends the setup the token
// locks, streams 16 kHz mono PCM16 LE in 100 ms frames and reports interim
// text as partials and finalized segments as finals. Wire shapes follow the
// Live Transcribe guide; design: docs/plans/selectable-dictation.md §6.
//
// Every bound is explicit: 5 s of audio may wait for setupComplete, the
// handshake has 10 s, and an upload backlog over 256 KiB fails the take with
// a network error. Audio is never dropped silently. Provider text (errors,
// goAway, close reasons) never reaches the user or a log.

import { z } from "zod";
import type { AsrClient } from "@schlessera/brain-ui-sdk/client";
import { CONVERSATION_LIMITS, type AsrEvent } from "@schlessera/brain-ui-sdk/protocol";
import { speechError } from "./dictation-failure.js";
import { openPcmMicrophone, pcm16Bytes, type PcmMicrophone } from "./pcm-capture.js";

const GEMINI_SAMPLE_RATE = 16_000;
/** 100 ms of 16 kHz mono PCM16: 1,600 samples, 3,200 bytes. */
export const GEMINI_FRAME_SAMPLES = 1_600;
/** Frames that may wait for setupComplete: 5 s of audio. */
export const GEMINI_PRESETUP_FRAMES = 50;
export const GEMINI_HANDSHAKE_MS = 10_000;
/** Upload backlog at which the take fails rather than grow without bound. */
export const GEMINI_MAX_BUFFERED_BYTES = 256 * 1024;
/** Done waits this long for the last final after audioStreamEnd. */
export const GEMINI_DRAIN_MS = 3_000;
const MAX_MESSAGE_BYTES = 262_144;
const MODEL = "models/gemini-3.5-transcribe-live";
const MIME = `audio/pcm;rate=${GEMINI_SAMPLE_RATE}`;

const transcript = z.object({ text: z.string().max(CONVERSATION_LIMITS.maxFragmentChars).optional(), finished: z.boolean().optional() });
const messageSchema = z.object({
  setupComplete: z.object({}).optional(),
  serverContent: z.object({
    interimInputTranscription: transcript.optional(),
    inputTranscription: transcript.optional(),
    turnComplete: z.boolean().optional(),
  }).optional(),
  goAway: z.object({}).optional(),
  // Remote error text is deliberately never surfaced: it may echo request details.
  error: z.unknown().optional(),
});
const vocabularySchema = z.array(z.string().min(1).max(64)).max(100);

interface GeminiAsrClientOptions {
  /** Constrained Live endpoint, from the server. */
  url: string;
  /** Single-use ephemeral token (`auth_tokens/…`), from the server. */
  token: string;
  /** `model`, `mode` (SMART/VERBATIM) and `vocabulary` (JSON array), from the server. */
  params: Record<string, string>;
  onEvent: (event: AsrEvent) => void;
  onError?: (error: Error) => void;
  onAudioLevel?: (level: number) => void;
  /** The provider ended the take without a stop(): close, expiry, error. */
  onClose?: () => void;
}

type Phase = "idle" | "live" | "draining" | "closed";

export class GeminiAsrClient implements AsrClient {
  private phase: Phase = "idle";
  private socket: WebSocket | null = null;
  private microphone: PcmMicrophone | null = null;
  private setupDone = false;
  private handshake: ReturnType<typeof setTimeout> | null = null;
  /** Frames waiting for setupComplete, oldest first. */
  private queue: string[] = [];
  private frame = new Int16Array(GEMINI_FRAME_SAMPLES);
  private filled = 0;
  private reported = false;
  private settleDrain: (() => void) | null = null;
  /** Done has the worklet's tail and the partial frame; audioStreamEnd may follow. */
  private tailFlushed = false;
  private inbound: Promise<void> = Promise.resolve();
  private readonly setup: string;

  constructor(private readonly opts: GeminiAsrClientOptions) {
    const params = opts.params ?? {};
    const mode = params.mode === "VERBATIM" ? "VERBATIM" : "SMART";
    let vocabulary: string[] = [];
    try { vocabulary = vocabularySchema.parse(JSON.parse(params.vocabulary ?? "[]")); } catch { vocabulary = []; }
    this.setup = JSON.stringify({
      setup: {
        model: params.model || MODEL,
        generationConfig: { responseModalities: ["TEXT"] },
        inputAudioTranscription: { mode, ...(vocabulary.length ? { customVocabulary: vocabulary } : {}) },
      },
    });
  }

  async start(): Promise<void> {
    if (this.phase !== "idle") return;
    let url: URL;
    try { url = new URL(this.opts.url); } catch { this.phase = "closed"; throw speechError("Gemini session material is invalid", "network"); }
    url.searchParams.set("access_token", this.opts.token);
    this.phase = "live";
    const socket = new WebSocket(url.toString());
    socket.binaryType = "arraybuffer";
    this.socket = socket;
    this.handshake = setTimeout(() => this.fail("Gemini handshake timed out", "network"), GEMINI_HANDSHAKE_MS);
    socket.onopen = () => { if (this.socket === socket) socket.send(this.setup); };
    socket.onmessage = (event: MessageEvent) => {
      if (this.socket !== socket) return;
      const data: unknown = event.data;
      // Keep arrival order even for a Blob, whose text resolves later.
      this.inbound = this.inbound.then(async () => {
        const text = typeof data === "string" ? data
          : data instanceof ArrayBuffer ? new TextDecoder().decode(data)
          : typeof Blob !== "undefined" && data instanceof Blob ? await data.text() : null;
        if (this.socket === socket) this.receive(text);
      });
    };
    socket.onerror = () => { if (this.socket === socket) this.fail("Gemini socket error", "network"); };
    socket.onclose = (event: CloseEvent) => {
      if (this.socket !== socket) return;
      // A clean close (Google's session limit, an expired token, or the end of
      // a drained Done) ends the take; anything else is a connection failure,
      // during Done too, so the kept words carry a notice saying why.
      if (event.code !== 1000) this.report("Gemini session closed", "network");
      if (this.phase === "draining") { this.finishDrain(); return; }
      this.end();
    };

    this.microphone = openPcmMicrophone(GEMINI_SAMPLE_RATE, (pcm, rms) => this.capture(pcm, rms), () => {}, () => this.fail("Microphone ended", "audio-capture"));
    try {
      await this.microphone.ready;
    } catch (error) {
      this.phase = "closed";
      this.teardown();
      throw error;
    }
  }

  /** Hard stop: release everything now and ignore whatever arrives later. */
  stop(): void {
    this.phase = "closed";
    this.teardown();
  }

  /**
   * Done: flush the worklet's partial block, send it and audioStreamEnd, wait
   * for the last final, then close; all of it within 3 s. Heard words are kept.
   */
  async drainAndStop(): Promise<void> {
    if (this.phase !== "live") { this.stop(); return; }
    this.phase = "draining";
    this.opts.onAudioLevel?.(0);
    const microphone = this.microphone;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => this.finishDrain(), GEMINI_DRAIN_MS);
      const settle = () => { clearTimeout(timer); resolve(); };
      this.settleDrain = settle;
      // Up to one worklet block (~93 ms) of the last words is still in the
      // worklet; its acknowledged flush delivers it through capture() first.
      void (microphone?.flush() ?? Promise.resolve()).then(() => {
        if (this.settleDrain !== settle) return;
        microphone?.stop();
        if (this.filled) {
          this.enqueue(this.frame.slice(0, this.filled));
          this.filled = 0;
        }
        if (this.settleDrain !== settle) return;
        this.tailFlushed = true;
        // Before setupComplete the stream end waits with the queued audio.
        if (this.setupDone) this.endInput();
      });
    });
    this.stop();
  }

  private capture(pcm: Int16Array, rms: number): void {
    // During Done the flush still delivers the worklet's last samples.
    if (this.phase === "draining" ? this.tailFlushed : this.phase !== "live") return;
    if (this.phase === "live") this.opts.onAudioLevel?.(Math.min(1, rms * 4));
    const drain = this.settleDrain;
    // A failure ends the loop: it closes a live take or settles the drain.
    const open = () => this.phase === "live" || (this.phase === "draining" && this.settleDrain === drain);
    let offset = 0;
    while (offset < pcm.length && open()) {
      const take = Math.min(GEMINI_FRAME_SAMPLES - this.filled, pcm.length - offset);
      this.frame.set(pcm.subarray(offset, offset + take), this.filled);
      this.filled += take;
      offset += take;
      if (this.filled === GEMINI_FRAME_SAMPLES) {
        this.filled = 0;
        this.enqueue(this.frame.slice());
      }
    }
  }

  private enqueue(samples: Int16Array): void {
    const bytes = pcm16Bytes(samples);
    let binary = "";
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
    const frame = JSON.stringify({ realtimeInput: { audio: { data: btoa(binary), mimeType: MIME } } });
    if (!this.setupDone) {
      if (this.queue.length >= GEMINI_PRESETUP_FRAMES) { this.fail("Gemini setup did not complete in time", "network"); return; }
      this.queue.push(frame);
      return;
    }
    this.send(frame);
  }

  private send(frame: string): boolean {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) { this.fail("Gemini socket is not open", "network"); return false; }
    if (socket.bufferedAmount > GEMINI_MAX_BUFFERED_BYTES) { this.fail("Gemini upload stalled", "network"); return false; }
    socket.send(frame);
    return true;
  }

  private endInput(): void {
    for (const frame of this.queue.splice(0)) if (!this.send(frame)) return;
    this.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } }));
  }

  private receive(text: string | null): void {
    if (this.phase === "closed" || this.phase === "idle") return;
    let message: z.infer<typeof messageSchema>;
    try {
      if (text === null || text.length > MAX_MESSAGE_BYTES) throw new Error("oversized");
      message = messageSchema.parse(JSON.parse(text));
    } catch {
      this.fail("Gemini message rejected", "unknown");
      return;
    }
    if (message.error !== undefined) { this.fail("Gemini reported an error", "unknown"); return; }
    if (message.setupComplete && !this.setupDone) {
      this.setupDone = true;
      if (this.handshake) { clearTimeout(this.handshake); this.handshake = null; }
      if (this.phase === "draining" && this.tailFlushed) this.endInput();
      else for (const frame of this.queue.splice(0)) if (!this.send(frame)) return;
    }
    const content = message.serverContent;
    const interim = content?.interimInputTranscription?.text;
    // Interim text replaces the current partial, during Done too: if no final
    // follows within the drain bound, what was last heard still reaches review.
    if (interim) this.opts.onEvent({ type: "partial", text: interim });
    const final = content?.inputTranscription;
    if (final?.text) this.opts.onEvent({ type: "final", text: final.text, endsTurn: final.finished ?? true });
    if (this.phase === "draining" && (final?.finished === true || content?.turnComplete === true)) this.finishDrain();
    // The session is about to end: what was heard is kept, the take ends.
    if (message.goAway) this.fail("Gemini session ending", "network");
  }

  private finishDrain(): void {
    const settle = this.settleDrain;
    this.settleDrain = null;
    settle?.();
  }

  /** One error per take, by category only. */
  private report(message: string, code: string): void {
    if (this.reported) return;
    this.reported = true;
    this.opts.onError?.(speechError(message, code));
  }

  private fail(message: string, code: string): void {
    if (this.phase === "closed" || this.phase === "idle") return;
    this.report(message, code);
    if (this.phase === "draining") { this.finishDrain(); return; }
    this.end();
  }

  /** The provider side ended a live take: release, then hand the words to review once. */
  private end(): void {
    if (this.phase !== "live") return;
    this.phase = "closed";
    this.teardown();
    this.opts.onClose?.();
  }

  private teardown(): void {
    if (this.handshake) { clearTimeout(this.handshake); this.handshake = null; }
    this.microphone?.stop();
    this.microphone = null;
    this.queue = [];
    this.filled = 0;
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.onopen = null; socket.onmessage = null; socket.onerror = null; socket.onclose = null;
      if (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN) {
        try { socket.close(1000); } catch {}
      }
    }
    this.finishDrain();
  }
}
