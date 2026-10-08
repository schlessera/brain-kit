import { useCallback, useEffect, useRef, useState } from "react";
import { useBrainUiRoot } from "../root-context.js";
import type { RecordingStore, Recording } from "../lib/recordings.js";
import {
  detectLocalCaptureSupport,
  startLocalCapture,
  type LocalCapture,
  type LocalCaptureStopReason,
} from "./local-capture.js";

/**
 * Whether this root may offer "Record on this device": `null` while the probe
 * runs and whenever the root does not offer local recording at all, then the
 * probe's answer. The probe never touches the microphone.
 */
export function useLocalCaptureSupport(): boolean | null {
  const root = useBrainUiRoot();
  const enabled = root.localCapture !== null;
  const [supported, setSupported] = useState<boolean | null>(null);
  useEffect(() => {
    if (!enabled) { setSupported(null); return; }
    let live = true;
    void detectLocalCaptureSupport().then((result) => { if (live) setSupported(result.supported); });
    return () => { live = false; };
  }, [enabled]);
  return enabled ? supported : null;
}

/**
 * Drives one recording on the device for the composer (#1012). `start` is
 * only ever called from a tap; nothing here opens the microphone by itself,
 * on load, on reconnect or after a permission grant.
 */
export function useLocalCapture({ store, allowLocked = false }: { store?: RecordingStore; allowLocked?: boolean } = {}) {
  const root = useBrainUiRoot();
  const recordings = store ?? root.recordings;
  const captureRef = useRef<LocalCapture | null>(null);
  const recordingRef = useRef<Pick<Recording, "partition" | "id"> | null>(null);
  // Bumped by every start and every stop: a start whose microphone opens
  // after the user already stopped (or the composer went away) closes it.
  const genRef = useRef(0);
  // Aborts a start still waiting on the microphone, so a cancelled one never
  // records or reaches the sink.
  const openingRef = useRef<AbortController | null>(null);
  const cancelOpening = () => { openingRef.current?.abort(); openingRef.current = null; };

  const start = useCallback(async () => {
    const options = root.localCapture;
    const voice = root.stores.voice.getState();
    if (!options || voice.local !== "idle" || (!allowLocked && root.authLock.state.getState().phase !== "active")) return;
    const gen = ++genRef.current;
    recordingRef.current = null;
    voice.setLocalNotice(null);
    voice.setLocal("opening");
    const opening = new AbortController();
    openingRef.current = opening;
    let capture: LocalCapture;
    try {
      const env = { timesliceMs: options.timesliceMs, signal: opening.signal, onAudioLevel: (level: number) => root.stores.voice.getState().setAudioLevel(level) };
      capture = recordings && options.durable
        ? await recordings.start(env)
        : await startLocalCapture({ sink: options.sink(), ...env });
    } catch (err) {
      if (openingRef.current === opening) openingRef.current = null;
      if (genRef.current !== gen) return;
      const state = root.stores.voice.getState();
      state.setLocal("idle");
      // A refusal gets its own copy; there is no retry and no second prompt.
      if (err instanceof DOMException && (err.name === "NotAllowedError" || err.name === "SecurityError")) {
        state.setLocalNotice("denied");
      } else {
        state.setError(err instanceof Error ? err.message : "Recording could not start");
      }
      return;
    }
    if (openingRef.current === opening) openingRef.current = null;
    if (genRef.current !== gen) {
      await capture.stop("user");
      return;
    }
    captureRef.current = capture;
    recordingRef.current = options.durable ? recordings?.active() ?? null : null;
    root.stores.voice.getState().setLocal("recording");
    // However it ends — a caller's stop, the browser ending the track —
    // the composer goes back to idle once the final chunk was handed over.
    void capture.ended.then(() => {
      if (captureRef.current !== capture) return;
      captureRef.current = null;
      root.stores.voice.getState().setLocal("idle");
    });
  }, [root, recordings, allowLocked]);

  const stop = useCallback(async (reason: LocalCaptureStopReason = "user") => {
    genRef.current++;
    cancelOpening();
    const capture = captureRef.current;
    const voice = root.stores.voice.getState();
    if (!capture) {
      if (voice.local === "opening") voice.setLocal("idle");
      return;
    }
    voice.setLocal("stopping");
    if (reason === "auth" && root.localCapture?.durable) await recordings?.stop(reason);
    else await capture.stop(reason);
  }, [root, recordings]);

  useEffect(() => root.authLock.registerStop(() => stop("auth")), [root, stop]);

  useEffect(() => () => {
    // The composer going away leaves no microphone open behind it.
    genRef.current++;
    cancelOpening();
    const capture = captureRef.current;
    captureRef.current = null;
    recordingRef.current = null;
    if (capture) void capture.stop("interrupted");
    if (root.stores.voice.getState().local !== "idle") root.stores.voice.getState().setLocal("idle");
  }, [root]);

  return { start, stop, recording: () => recordingRef.current };
}
