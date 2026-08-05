import { create } from "zustand";
import type { VoiceMode } from "@schlessera/brain-ui-sdk/protocol";

interface VoiceState {
  mode: VoiceMode;
  connecting: boolean;      // session fetch / mic open in progress (mic not yet live)
  draining: boolean;        // post-Done flush in progress
  partial: string;
  finalText: string;        // accumulated final transcript for current capture
  audioLevel: number;       // 0..1 RMS level for waveform
  reviewText: string;       // text waiting in the review card (post-stop)
  providerId: string | null; // active speech provider (from the session response)
  error: string | null;

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
}

export const useVoiceStore = create<VoiceState>((set) => ({
  mode: "idle",
  connecting: false,
  draining: false,
  partial: "",
  finalText: "",
  audioLevel: 0,
  reviewText: "",
  providerId: null,
  error: null,

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
  clearReview: () => set({ reviewText: "" }),
  setProviderId: (providerId) => set({ providerId }),
  setError: (error) => set({ error }),
  resetCapture: () =>
    set({ partial: "", finalText: "", audioLevel: 0, error: null }),
}));
