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
/** Done waits at most this long for the last final after audioStreamEnd. */
export const GEMINI_DRAIN_MS = 3_000;
/**
 * With nothing pending at audioStreamEnd, Done ends after this much quiet.
 * Google sends nothing at all after audioStreamEnd when no speech is pending
 * (#3710), so without it every such Done waited the full cap (#3768).
 */
export const GEMINI_DRAIN_QUIET_MS = 300;
/**
 * The quiet window when the microphone heard voice that Google has not yet
 * placed in a segment: its speech signal is still on the way. Google signalled
 * speech about 75 ms after the audio reached it in #3710, so this leaves room
 * for a slow network; if Google never calls it speech, Done ends here.
 */
export const GEMINI_DRAIN_TAIL_MS = 1_500;
/** Block RMS that counts as voice; the conversation capture uses the same bar. */
const GEMINI_VOICE_RMS = 0.015;
/** Google reports audioOffset in 10 ms steps; one frame absorbs its rounding. */
const OFFSET_SLACK = GEMINI_FRAME_SAMPLES;
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
    generationComplete: z.boolean().optional(),
    speechState: z.string().max(32).optional(),
  }).optional(),
  // Google's voice activity detection; audioOffset is a Duration ("3.310s")
  // from the first audio of the stream.
  voiceActivity: z.object({ type: z.string().max(32).optional(), audioOffset: z.string().max(32).optional() }).optional(),
  goAway: z.object({}).optional(),
  // Remote error text is deliberately never surfaced: it may echo request details.
  error: z.unknown().optional(),
});
const vocabularySchema = z.array(z.string().min(1).max(64)).max(100);
const languageCodesSchema = z.array(z.string().regex(/^[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8}){0,3}$/)).min(1).max(4);

interface GeminiAsrClientOptions {
  /** Constrained Live endpoint, from the server. */
  url: string;
  /** Single-use ephemeral token (`auth_tokens/…`), from the server. */
  token: string;
  /** `model`, `mode` (SMART/VERBATIM), `vocabulary` and `languageCodes` (JSON arrays), from the server. */
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
  /** Speech or an interim arrived that no final or generationComplete has closed yet. */
  private pending = false;
  /** audioStreamEnd has been sent; only now can generationComplete end the drain. */
  private streamEnded = false;
  private quiet: ReturnType<typeof setTimeout> | null = null;
  /** Bumped on every (re)arm and disarm, so a stale quiet callback does nothing. */
  private quietRound = 0;
  /** Length of the window now armed, or 0. */
  private quietMs = 0;
  /** Samples captured for the stream so far: the stream offset of the next one. */
  private captured = 0;
  /** Stream offset just past the last block the microphone heard voice in. */
  private voicedTo = 0;
  /** Stream offset up to which Google has closed segments (ACTIVITY_END). */
  private heardTo = 0;
  private readonly setup: string;

  constructor(private readonly opts: GeminiAsrClientOptions) {
    const params = opts.params ?? {};
    const mode = params.mode === "VERBATIM" ? "VERBATIM" : "SMART";
    let vocabulary: string[] = [];
    try { vocabulary = vocabularySchema.parse(JSON.parse(params.vocabulary ?? "[]")); } catch { vocabulary = []; }
    // The token locks the language server side; a missing or malformed hint
    // here only omits the repeat, it cannot unlock anything.
    let languageCodes: string[] = [];
    try { languageCodes = languageCodesSchema.parse(JSON.parse(params.languageCodes ?? "null")); } catch { languageCodes = []; }
    this.setup = JSON.stringify({
      setup: {
        model: params.model || MODEL,
        generationConfig: { responseModalities: ["TEXT"] },
        inputAudioTranscription: { mode, ...(languageCodes.length ? { languageCodes } : {}), ...(vocabulary.length ? { customVocabulary: vocabulary } : {}) },
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
   * for the last final (generationComplete) or, with nothing pending, a short
   * quiet, then close; all of it within 3 s. Heard words are kept.
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
    if (rms >= GEMINI_VOICE_RMS) this.voicedTo = this.captured + pcm.length;
    this.captured += pcm.length;
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
    if (!this.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } }))) return;
    this.streamEnded = true;
    this.settleOrWait(false);
  }

  /** The microphone heard voice past the last segment Google closed. */
  private unplaced(): boolean {
    return this.voicedTo > this.heardTo + OFFSET_SLACK;
  }

  /** Google's last ACTIVITY_END reaches the end of the stream. */
  private covered(): boolean {
    return this.heardTo + OFFSET_SLACK >= this.captured;
  }

  /**
   * After audioStreamEnd, decide whether Done is complete. Google answers it
   * with the pending final, generationComplete and an ACTIVITY_END at the
   * stream end (+253 ms in #3710), and with nothing at all when no speech is
   * pending; it never sent finished or turnComplete. So Done:
   * - waits while a segment is open;
   * - waits the tail window while the microphone heard voice past Google's
   *   last ACTIVITY_END, since an earlier segment's answer can arrive before
   *   the new speech is signalled (a window already running is not extended);
   * - ends at once when Google's answer has an ACTIVITY_END reaching the
   *   stream end;
   * - otherwise ends after the short quiet, restarted by each speech message,
   *   because voice too quiet for the RMS bar may still be signalled.
   * The 3 s cap bounds every wait.
   */
  private settleOrWait(answered: boolean): void {
    if (this.pending) this.disarmQuiet();
    else if (this.unplaced()) { if (this.quietMs !== GEMINI_DRAIN_TAIL_MS) this.armQuiet(GEMINI_DRAIN_TAIL_MS); }
    else if (answered && this.covered()) this.finishDrain();
    else this.armQuiet(GEMINI_DRAIN_QUIET_MS);
  }

  /**
   * (Re)start a quiet window. When it lapses, messages that already arrived
   * are processed first (a Blob decodes asynchronously), and any of them that
   * re-armed or disarmed the window wins.
   */
  private armQuiet(ms: number): void {
    this.disarmQuiet();
    const round = this.quietRound;
    this.quietMs = ms;
    this.quiet = setTimeout(() => {
      this.quiet = null;
      void this.inbound.then(() => { if (this.quietRound === round) this.finishDrain(); });
    }, ms);
  }

  private disarmQuiet(): void {
    this.quietRound++;
    this.quietMs = 0;
    if (this.quiet) { clearTimeout(this.quiet); this.quiet = null; }
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
    const endedBefore = this.streamEnded;
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
    const activity = message.voiceActivity;
    const turnEnded = final?.finished === true || content?.turnComplete === true;
    if (interim || content?.speechState === "SPEECH") this.pending = true;
    if (final?.text || content?.generationComplete === true || turnEnded) this.pending = false;
    if (activity?.type === "ACTIVITY_END") {
      const seconds = /^(\d{1,6}(?:\.\d{1,9})?)s$/.exec(activity.audioOffset ?? "")?.[1];
      if (seconds !== undefined) this.heardTo = Math.max(this.heardTo, Math.ceil(Number(seconds) * GEMINI_SAMPLE_RATE));
    }
    // Only speech messages bear on Done; a setupComplete that just sent
    // audioStreamEnd has already decided. finished and turnComplete close the
    // segment like generationComplete, and nothing more.
    const speech = interim || final !== undefined || content?.speechState !== undefined
      || content?.generationComplete !== undefined || content?.turnComplete !== undefined || activity !== undefined;
    if (this.phase === "draining" && endedBefore && speech) this.settleOrWait(true);
    // The session is about to end: what was heard is kept, the take ends.
    if (message.goAway) this.fail("Gemini session ending", "network");
  }

  private finishDrain(): void {
    this.disarmQuiet();
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
