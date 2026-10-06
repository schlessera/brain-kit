import { useBrainUiRoot } from "../root-context.js";
import { useCallback, useEffect, useRef } from "react";
import { useVoiceStore } from "./voice-store.js";
import { type AsrClient } from "@schlessera/brain-ui-sdk/client";
import { speechUiHints } from "@schlessera/brain-ui-sdk/internal/client";
import type { PronunciationOverride } from "@schlessera/brain-ui-sdk/protocol";
import { registerAsrClients } from "./asr-clients.js";

/** Apply pronunciation overrides client-side to a finalized transcript. */
function applyOverrides(
  text: string,
  overrides: PronunciationOverride[]
): string {
  if (overrides.length === 0) return text;
  let out = text;
  for (const { match, replacement } of overrides) {
    if (!match) continue;
    const escaped = match.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(`\\b${escaped}\\b`, "gi"), replacement);
  }
  return out;
}

export function useDictation() {
  const root = useBrainUiRoot();
  // start() may resolve a client before this hook's effects have run.
  registerAsrClients(root);
  const api = root.api;

  const clientRef = useRef<AsrClient | null>(null);
  const overridesRef = useRef<PronunciationOverride[]>([]);
  // Bumped on every start() and on every stop/cancel/unmount. A start that
  // discovers its generation has been superseded aborts instead of opening
  // (or continuing to hold) the mic — this closes the window where a slow
  // session fetch would open a MediaStream after the user already stopped.
  const startGenRef = useRef(0);
  // AbortController for the in-flight session fetch, so stop/cancel/unmount
  // can actually cancel a pending connect rather than just ignoring its result.
  const sessionAbortRef = useRef<AbortController | null>(null);
  const setMode = useVoiceStore((s) => s.setMode);
  const setConnecting = useVoiceStore((s) => s.setConnecting);
  const setProviderId = useVoiceStore((s) => s.setProviderId);
  const setPartial = useVoiceStore((s) => s.setPartial);
  const appendFinal = useVoiceStore((s) => s.appendFinal);
  const setError = useVoiceStore((s) => s.setError);
  const resetCapture = useVoiceStore((s) => s.resetCapture);
  const setReviewText = useVoiceStore((s) => s.setReviewText);

  const start = useCallback(async () => {
    const gen = ++startGenRef.current;
    resetCapture();
    setProviderId(null);
    // Show the sheet immediately, but as "connecting" — the mic is still shut
    // during the session fetch, so we must not present a live "Listening" state
    // (or its pulsing dot) until capture is actually open.
    setConnecting(true);
    setMode("dictate");

    const abort = new AbortController();
    sessionAbortRef.current = abort;

    try {
      // Fetch the dictation session + pronunciation overrides. The AsrClient's
      // start() opens the mic and buffers audio until its stream is ready, so
      // words spoken during connect are not lost.
      const [session, ov] = await Promise.all([
        api.voiceSession(abort.signal),
        api
          .voiceOverrides(abort.signal)
          .catch(() => ({ overrides: [] as PronunciationOverride[] })),
      ]);
      // Superseded by a Stop/Escape/backdrop/unmount while the session was in
      // flight? Bail before opening the mic — a MediaStream created here would
      // have no reference left to stop it.
      if (startGenRef.current !== gen) return;
      if (sessionAbortRef.current === abort) sessionAbortRef.current = null;
      overridesRef.current = ov.overrides;
      // Surface which provider actually served this session (e.g. a silent
      // fallback to browser speech) — see the sheet's provider indicator.
      setProviderId(session.providerId);

      const hints = speechUiHints(session.capabilities);
      const client = root.asr.create({
        session,
        onEvent: (evt) => {
          if (evt.type === "partial") {
            // Providers without interim results skip live partials.
            if (hints.showPartials) {
              setPartial(applyOverrides(evt.text, overridesRef.current));
            }
          } else if (evt.type === "final" && evt.text) {
            appendFinal(applyOverrides(evt.text, overridesRef.current));
          }
        },
        onError: (err) => setError(err.message),
      });
      // Publish the client before awaiting start() so a concurrent stop() can
      // grab and close it (releasing its MediaStream) while the mic is opening.
      clientRef.current = client;
      await client.start();
      // Stopped while the mic was opening? Close the client we just started —
      // its start() honors the closed flag and releases the stream.
      if (startGenRef.current !== gen) {
        client.stop();
        if (clientRef.current === client) clientRef.current = null;
        return;
      }
      // Capture is live now — drop the connecting state so the sheet can show
      // the honest "Listening" indicator.
      setConnecting(false);
    } catch (err) {
      // A superseded start failing (e.g. the aborted session fetch) is
      // expected — swallow it so it doesn't surface a spurious error.
      if (startGenRef.current !== gen) return;
      if (sessionAbortRef.current === abort) sessionAbortRef.current = null;
      setError(err instanceof Error ? err.message : "Voice start failed");
      setConnecting(false);
      setMode("idle");
    }
  }, [
    root,
    api,
    resetCapture,
    setMode,
    setConnecting,
    setProviderId,
    setPartial,
    appendFinal,
    setError,
  ]);

  // Invalidate any in-flight start, cancel its session fetch, and hand back
  // the current client for the caller to close. It reads the refs when it
  // runs, not when the hook mounted, so it reaches a session started later.
  const releaseCapture = useCallback((): AsrClient | null => {
    startGenRef.current++;
    sessionAbortRef.current?.abort();
    sessionAbortRef.current = null;
    const client = clientRef.current;
    clientRef.current = null;
    return client;
  }, []);

  const stop = useCallback(
    async (commitToReview = true) => {
      // A slow connect must not open the mic after the user asked it to stop.
      const client = releaseCapture();

      const setDraining = root.stores.voice.getState().setDraining;
      if (client) {
        if (commitToReview) {
          setDraining(true);
          try {
            await client.drainAndStop();
          } finally {
            setDraining(false);
          }
        } else {
          client.stop();
        }
      }

      const { finalText, partial, reviewText } = root.stores.voice.getState();
      const merged = [finalText, partial].filter(Boolean).join(" ").trim();
      setConnecting(false);
      setMode("idle");
      if (commitToReview && merged) {
        // Append to any text already under review so a prompt can be built up
        // across multiple record/edit rounds without losing earlier takes.
        setReviewText(reviewText ? `${reviewText} ${merged}` : merged);
      }
      resetCapture();
    },
    [releaseCapture, resetCapture, setMode, setConnecting, setReviewText, root]
  );

  const cancel = useCallback(() => {
    void stop(false);
  }, [stop]);

  useEffect(() => {
    // Tear down on unmount or root change: invalidate the in-flight start,
    // abort its fetch, and stop the client so no MediaStream survives.
    return () => releaseCapture()?.stop();
  }, [root, releaseCapture]);

  return { start, stop, cancel };
}
