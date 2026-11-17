import type { DictationNotice } from "./dictation-failure.js";
import { createStore } from "zustand/vanilla";
import type { VoiceMode, VoiceProvidersResponse } from "@schlessera/brain-ui-sdk/protocol";
import type { StoreEnvironment } from "../stores/store-environment.js";

type DiscoveredProvider = VoiceProvidersResponse["providers"][number];

/**
 * What stands between a tap and a session request (#3709): the one-time
 * acknowledgement of where audio goes (D4), or a reason there is nowhere to
 * send it. Either is shown in the voice field's notice (D0, Dx, #3694) before
 * anything is minted and before the microphone opens.
 */
type DictationGate =
  | { kind: "consent"; provider: DiscoveredProvider }
  | { kind: "blocked"; reason: "none" | "choose" | "unavailable"; saved: string | null };

/** A brain-wide dictation choice as Settings › Voice writes it. */
export type DictationChoice = { defaultProvider: string | null; smart: boolean };

/**
 * Who a Settings write is made for: the account the pane established as the
 * writer and the auth generation (`root.authLock.epoch()`) it was established in.
 */
export type DictationWriter = { account: string; epoch: number };

/**
 * Settings › Voice writes, kept on the root rather than in the pane (#3709):
 * an accepted choice is written even after the pane closes, and reopening it
 * shows where the writes stand.
 */
export interface DictationSaveState {
  /** The newest accepted choice the server has not confirmed yet. */
  pending: DictationChoice | null;
  status:
    | { kind: "saving" }
    | { kind: "failed"; retry: DictationChoice; text: string }
    /** Changed on another device; `current` once the server's value was read again. */
    | { kind: "stale"; current: boolean }
    | null;
  /** The last discovery read failed: what is shown may be out of date. */
  refreshFailed: boolean;
  /** The writer a save was refused for as not the owner; it holds for that identity only. */
  refused: DictationWriter | null;
}

export interface VoiceState {
  mode: VoiceMode;
  connecting: boolean;      // session fetch / mic open in progress (mic not yet live)
  /** The browser is asking for the microphone while it opens (D2, #3694). */
  micPrompt: boolean;
  /** Capturing, with no speech heard for a moment (D4, #3694). */
  quiet: boolean;
  draining: boolean;        // post-Done flush in progress
  partial: string;
  finalText: string;        // accumulated final transcript for current capture
  audioLevel: number;       // 0..1 RMS level for waveform
  reviewText: string;       // what a take heard, until the composer moves it into the draft (D6)
  providerId: string | null; // active speech provider (from the session response)
  /** The provider this take disclosed and was sent to; frozen for the take. */
  dictationTarget: DiscoveredProvider | null;
  dictationGate: DictationGate | null;
  /**
   * The last discovery snapshot and when it was read (`GET /voice/providers`).
   * `stale` marks one that may no longer be the server's: a take reads
   * discovery again before it discloses anything from it.
   */
  discovery: { snapshot: VoiceProvidersResponse; at: number; stale?: boolean } | null;
  dictationSave: DictationSaveState;
  /** Device-local acknowledgement storage; a read that fails returns null. */
  readAcknowledgement: (key: string) => string | null;
  writeAcknowledgement: (key: string, value: string) => void;
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
type LocalCapturePhase = "idle" | "opening" | "recording" | "stopping";

export function createVoiceStore(env?: Pick<StoreEnvironment, "storage" | "storageKey">) {
  // Without persistence (tests, stories, SSR) an acknowledgement lasts for
  // the root's life. Persistence that throws is never treated as consent.
  const memory = new Map<string, string>();
  return createStore<VoiceState>((set) => ({
    mode: "idle",
    connecting: false,
    micPrompt: false,
    quiet: false,
    draining: false,
    partial: "",
    finalText: "",
    audioLevel: 0,
    reviewText: "",
    providerId: null,
    dictationTarget: null,
    dictationGate: null,
    discovery: null,
    dictationSave: { pending: null, status: null, refreshFailed: false, refused: null },
    readAcknowledgement: (key) => {
      try {
        const storage = env?.storage() ?? null;
        return storage === null ? memory.get(key) ?? null : storage.getItem(env!.storageKey(key));
      } catch { return null; }
    },
    writeAcknowledgement: (key, value) => {
      try {
        const storage = env?.storage() ?? null;
        if (storage === null) memory.set(key, value);
        else storage.setItem(env!.storageKey(key), value);
      } catch { /* Not stored: the next take asks again. */ }
    },
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
      set({ partial: "", finalText: "", audioLevel: 0, quiet: false, micPrompt: false, error: null, dictationNotice: null }),
    setLocal: (local) => set({ local }),
    setLocalNotice: (localNotice) => set({ localNotice }),
  }));
}
