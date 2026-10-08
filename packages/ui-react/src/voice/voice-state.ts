import type { DictationNotice } from "./dictation-failure.js";
import { createStore } from "zustand/vanilla";
import type { VoiceMode } from "@schlessera/brain-ui-sdk/protocol";

export interface VoiceState {
  mode: VoiceMode;
  connecting: boolean;      // session fetch / mic open in progress (mic not yet live)
  draining: boolean;        // post-Done flush in progress
  partial: string;
  finalText: string;        // accumulated final transcript for current capture
  audioLevel: number;       // 0..1 RMS level for waveform
  reviewText: string;       // text waiting in the review card (post-stop)
  providerId: string | null; // active speech provider (from the session response)
  error: string | null;
  /** Capture-scoped explanation, independent of an open-sheet error. */
  dictationNotice: DictationNotice | null;
  dismissDictationNotice: () => void;
  /** A recording on the device (#1012), separate from streaming dictation. */
  local: LocalCapturePhase;
  /** Why the last tap could not record: the microphone was refused. */
  localNotice: "denied" | null;

  setMode: (mode: VoiceMode) => void;
  setConnecting: (connecting: boolean) => void;
  setDraining: (draining: boolean) => void;
  setPartial: (text: string) => void;
  appendFinal: (text: string) => void;
  setAudioLevel: (level: number) => void;
  setReviewText: (text: string) => void;
  clearReview: () => void;
  setProviderId: (providerId: string | null) => void;
  setError: (err: string | null) => void;
  resetCapture: () => void;
  setLocal: (local: LocalCapturePhase) => void;
  setLocalNotice: (notice: "denied" | null) => void;
}

/** opening: waiting on the microphone; stopping: the final chunk is on its way. */
export type LocalCapturePhase = "idle" | "opening" | "recording" | "stopping";

export function createVoiceStore() {
  return createStore<VoiceState>((set) => ({
    mode: "idle",
    connecting: false,
    draining: false,
    partial: "",
    finalText: "",
    audioLevel: 0,
    reviewText: "",
    providerId: null,
    error: null,
    dictationNotice: null,
    dismissDictationNotice: () => set({ dictationNotice: null }),
    local: "idle",
    localNotice: null,

    setMode: (mode) => set({ mode }),
    setConnecting: (connecting) => set({ connecting }),
    setDraining: (draining) => set({ draining }),
    setPartial: (partial) => set({ partial }),
    appendFinal: (text) =>
      set((s) => ({
        finalText: (s.finalText ? s.finalText + " " : "") + text.trim(),
        partial: "",
      })),
    setAudioLevel: (audioLevel) => set({ audioLevel }),
    setReviewText: (reviewText) => set({ reviewText }),
    clearReview: () => set({ reviewText: "", dictationNotice: null }),
    setProviderId: (providerId) => set({ providerId }),
    setError: (error) => set({ error }),
    resetCapture: () =>
      set({ partial: "", finalText: "", audioLevel: 0, error: null, dictationNotice: null }),
    setLocal: (local) => set({ local }),
    setLocalNotice: (localNotice) => set({ localNotice }),
  }));
}
