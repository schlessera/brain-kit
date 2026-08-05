// Deepgram streaming ASR client.
// Captures mic audio with MediaRecorder (Opus) and pipes it to Deepgram's
// streaming endpoint via WebSocket. The full connect URL (base params + domain
// keyterms) and a short-lived token are minted server-side and injected here;
// this client just opens the socket and emits partial + final transcript
// events. Implements the @schlessera/brain-ui-sdk AsrClient surface.

import type { AsrClient } from "@schlessera/brain-ui-sdk/client";
import type { AsrEvent } from "@schlessera/brain-ui-sdk/protocol";

export interface DeepgramClientOptions {
  /** Full Deepgram streaming WS URL (base params + keyterms), from the server. */
  url: string;
  /** Short-lived Deepgram token, from the server. */
  token: string;
  onEvent: (evt: AsrEvent) => void;
  onAudioLevel?: (level: number) => void;
  onError?: (err: Error) => void;
  onClose?: () => void;
}

export class DeepgramClient implements AsrClient {
  private ws: WebSocket | null = null;
  private recorder: MediaRecorder | null = null;
  private stream: MediaStream | null = null;
  private audioContext: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private levelRaf: number | null = null;
  private opts: DeepgramClientOptions;
  // Audio chunks captured before the Deepgram socket opens. The recorder starts
  // as soon as the mic is granted; this holds the head of the utterance until
  // it can be flushed on ws.onopen.
  private pending: Blob[] = [];
  private closed = false;
  private drainResolve: (() => void) | null = null;
  private wakeLock: WakeLockSentinel | null = null;
  private wakeLockHandler: (() => void) | null = null;

  constructor(opts: DeepgramClientOptions) {
    this.opts = opts;
  }

  async start(): Promise<void> {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        channelCount: 1,
      },
    });
    // Stopped while the mic permission was resolving? Release the freshly
    // granted stream now — otherwise it stays live with no reference left to
    // stop it (cleanup() already ran before the stream existed).
    if (this.closed) {
      for (const track of stream.getTracks()) track.stop();
      return;
    }
    this.stream = stream;

    void this.acquireWakeLock();
    this.startAudioLevelMeter(this.stream);

    // Record from the moment the mic is live — chunks buffer in `pending` until
    // the socket opens, so connect latency doesn't eat the first words.
    this.startRecorder();

    if (this.closed) return;

    // Token is passed as a sec-websocket-protocol header per Deepgram spec.
    this.ws = new WebSocket(this.opts.url, ["token", this.opts.token]);

    this.ws.onopen = () => {
      this.flushPending();
    };

    this.ws.onmessage = (evt) => {
      try {
        const data = JSON.parse(evt.data);
        this.handleDeepgramMessage(data);
      } catch (err) {
        this.opts.onError?.(
          err instanceof Error ? err : new Error("Bad Deepgram message")
        );
      }
    };

    this.ws.onerror = () => {
      this.opts.onError?.(new Error("Deepgram socket error"));
    };

    this.ws.onclose = () => {
      this.cleanup();
      if (!this.closed) this.opts.onClose?.();
    };
  }

  private startRecorder() {
    if (!this.stream) return;
    const mimeType = pickOpusMime();
    this.recorder = new MediaRecorder(this.stream, {
      mimeType,
      audioBitsPerSecond: 32000,
    });
    this.recorder.ondataavailable = (evt) => {
      if (evt.data.size === 0) return;
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(evt.data);
      } else {
        this.pending.push(evt.data);
      }
    };
    // 250ms chunks — small enough to feel live, big enough to be Opus-frame-aligned
    this.recorder.start(250);
  }

  private flushPending() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    for (const chunk of this.pending) this.ws.send(chunk);
    this.pending = [];
  }

  private handleDeepgramMessage(data: any) {
    if (data.type === "Results") {
      const alt = data.channel?.alternatives?.[0];
      const transcript: string = alt?.transcript ?? "";
      if (data.is_final) {
        if (transcript) {
          this.opts.onEvent({
            type: "final",
            text: transcript,
            endsTurn: !!data.speech_final,
          });
        }
        // If we are draining, this final settles the wait — but allow more
        // arrivals up to the deadline. We resolve on Metadata or timeout.
      } else if (transcript) {
        this.opts.onEvent({ type: "partial", text: transcript });
      }
      return;
    }
    if (data.type === "UtteranceEnd") {
      this.opts.onEvent({ type: "final", text: "", endsTurn: true });
      return;
    }
    if (data.type === "Metadata") {
      // Final summary — Deepgram sends this when the stream is closing.
      this.drainResolve?.();
      this.drainResolve = null;
      return;
    }
  }

  // Keep the screen on for the duration of capture so the phone doesn't sleep
  // mid-sentence and clip the audio. The lock is released when the page becomes
  // hidden, so re-acquire on visibility return.
  private async acquireWakeLock(): Promise<void> {
    if (typeof navigator === "undefined" || !("wakeLock" in navigator)) {
      return;
    }
    try {
      this.wakeLock = await navigator.wakeLock.request("screen");
      this.wakeLock.addEventListener("release", () => {
        this.wakeLock = null;
      });
      if (!this.wakeLockHandler) {
        this.wakeLockHandler = () => {
          if (
            document.visibilityState === "visible" &&
            !this.closed &&
            !this.wakeLock
          ) {
            void this.acquireWakeLock();
          }
        };
        document.addEventListener("visibilitychange", this.wakeLockHandler);
      }
    } catch (err) {
      console.warn("[voice] Wake lock request failed:", err);
    }
  }

  private releaseWakeLock(): void {
    if (this.wakeLockHandler) {
      document.removeEventListener("visibilitychange", this.wakeLockHandler);
      this.wakeLockHandler = null;
    }
    if (this.wakeLock) {
      this.wakeLock.release().catch(() => {});
      this.wakeLock = null;
    }
  }

  private startAudioLevelMeter(stream: MediaStream) {
    if (!this.opts.onAudioLevel) return;
    try {
      const ctx = new AudioContext();
      const src = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      src.connect(analyser);
      this.audioContext = ctx;
      this.analyser = analyser;
      const buf = new Uint8Array(analyser.frequencyBinCount);
      const tick = () => {
        if (!this.analyser) return;
        this.analyser.getByteTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) {
          const v = (buf[i] - 128) / 128;
          sum += v * v;
        }
        const rms = Math.sqrt(sum / buf.length);
        this.opts.onAudioLevel?.(Math.min(1, rms * 4));
        this.levelRaf = requestAnimationFrame(tick);
      };
      tick();
    } catch (err) {
      console.warn("[voice] Audio level meter failed:", err);
    }
  }

  stop() {
    this.closed = true;
    this.cleanup();
  }

  // Graceful stop: tells Deepgram to flush any buffered audio, waits for the
  // remaining final results, then closes. Use this for "Done" — it preserves
  // the tail of an utterance that hasn't been finalized yet.
  async drainAndStop(maxWaitMs = 2000): Promise<void> {
    this.closed = true;
    if (this.recorder && this.recorder.state === "recording") {
      try {
        this.recorder.stop();
      } catch {}
    }
    // If the socket is still connecting, give it a moment to open so the
    // buffered head of the utterance can still be delivered and transcribed.
    if (this.ws && this.ws.readyState === WebSocket.CONNECTING) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, maxWaitMs);
        const settle = () => {
          clearTimeout(timer);
          resolve();
        };
        this.ws!.addEventListener("open", settle, { once: true });
        this.ws!.addEventListener("close", settle, { once: true });
      });
    }
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.cleanup();
      return;
    }
    this.flushPending();
    await new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        this.drainResolve = null;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(finish, maxWaitMs);
      this.drainResolve = finish;
      try {
        // Finalize emits final results for buffered audio without closing.
        this.ws!.send(JSON.stringify({ type: "Finalize" }));
        // CloseStream then triggers a final Metadata message and closes.
        this.ws!.send(JSON.stringify({ type: "CloseStream" }));
      } catch {
        finish();
      }
    });
    this.cleanup();
  }

  private cleanup() {
    this.releaseWakeLock();
    if (this.levelRaf !== null) {
      cancelAnimationFrame(this.levelRaf);
      this.levelRaf = null;
    }
    if (this.recorder && this.recorder.state !== "inactive") {
      try {
        this.recorder.stop();
      } catch {}
    }
    this.recorder = null;
    this.pending = [];
    if (this.stream) {
      for (const track of this.stream.getTracks()) track.stop();
      this.stream = null;
    }
    if (this.audioContext) {
      this.audioContext.close().catch(() => {});
      this.audioContext = null;
    }
    this.analyser = null;
    if (this.ws && this.ws.readyState <= WebSocket.OPEN) {
      try {
        // Send Deepgram's CloseStream control message before closing
        if (this.ws.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({ type: "CloseStream" }));
        }
        this.ws.close();
      } catch {}
    }
    this.ws = null;
  }
}

function pickOpusMime(): string {
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/ogg;codecs=opus",
    "audio/webm",
  ];
  for (const c of candidates) {
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(c)) {
      return c;
    }
  }
  return "audio/webm";
}
