// Web Speech API ASR client — the `webspeech` provider. Recognition runs
// entirely in the browser (no server session, no token), so this is the
// zero-dependency / zero-cost STT path. Availability varies by browser
// (Chrome/Edge yes, Firefox no), so callers must guard with
// isWebSpeechAvailable() before selecting it.

import { speechError } from "./dictation-failure.js";
import type { AsrClient } from "@schlessera/brain-ui-sdk/client";
import type { AsrEvent } from "@schlessera/brain-ui-sdk/protocol";

// The Web Speech API isn't in the standard TS DOM lib; declare the minimal
// surface we use.
interface SpeechRecognitionAlternativeLike {
  transcript: string;
}
interface SpeechRecognitionResultLike {
  isFinal: boolean;
  0: SpeechRecognitionAlternativeLike;
}
interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: ArrayLike<SpeechRecognitionResultLike>;
}
interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
  onend: (() => void) | null;
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function getRecognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/** True when this browser supports the Web Speech API. */
export function isWebSpeechAvailable(): boolean {
  return getRecognitionCtor() !== null;
}

export interface WebSpeechClientOptions {
  onEvent: (evt: AsrEvent) => void;
  onError?: (err: Error) => void;
  onEnd?: () => void;
  /** BCP-47 language tag. Defaults to "en-US". */
  lang?: string;
}

export class WebSpeechClient implements AsrClient {
  private recognition: SpeechRecognitionLike | null = null;
  private opts: WebSpeechClientOptions;
  private closed = false;
  private endResolvers: Array<() => void> = [];

  constructor(opts: WebSpeechClientOptions) {
    this.opts = opts;
  }

  async start(): Promise<void> {
    const Ctor = getRecognitionCtor();
    if (!Ctor) {
      throw new Error("Web Speech API is not available in this browser.");
    }
    const recognition = new Ctor();
    recognition.lang = this.opts.lang ?? "en-US";
    recognition.continuous = true;
    recognition.interimResults = true;

    recognition.onresult = (event) => {
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const transcript = result[0]?.transcript ?? "";
        if (!transcript) continue;
        if (result.isFinal) {
          // No reliable end-of-utterance signal, so never auto-end the turn.
          this.opts.onEvent({ type: "final", text: transcript, endsTurn: false });
        } else {
          this.opts.onEvent({ type: "partial", text: transcript });
        }
      }
    };

    recognition.onerror = (event) => {
      if (this.closed) return;
      this.opts.onError?.(speechError(`Speech recognition error: ${event.error ?? "unknown"}`, event.error ?? "unknown"));
    };

    recognition.onend = () => {
      this.settleEnd();
      if (!this.closed) this.opts.onEnd?.();
    };

    this.recognition = recognition;
    recognition.start();
  }

  stop() {
    this.closed = true;
    try {
      this.recognition?.abort();
    } catch {}
    this.recognition = null;
    this.settleEnd();
  }

  async drainAndStop(): Promise<void> {
    this.closed = true;
    if (!this.recognition) return;
    // stop() flushes the pending final result, then fires onend.
    const done = new Promise<void>((resolve) => this.endResolvers.push(resolve));
    try {
      this.recognition.stop();
    } catch {
      this.settleEnd();
    }
    // Bound the wait so a browser that never fires onend can't hang the UI.
    await Promise.race([done, new Promise<void>((r) => setTimeout(r, 1500))]);
    this.recognition = null;
  }

  private settleEnd() {
    const resolvers = this.endResolvers;
    this.endResolvers = [];
    for (const resolve of resolvers) resolve();
  }
}
