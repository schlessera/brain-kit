import { useBrainUiRoot } from "../root-context.js";
import { useCallback, useEffect, useRef } from "react";
import { useVoiceStore } from "./voice-store.js";
import { type AsrClient } from "@schlessera/brain-ui-sdk/client";
import { speechUiHints } from "@schlessera/brain-ui-sdk/internal/client";
import type { PronunciationOverride } from "@schlessera/brain-ui-sdk/protocol";
import { dictationFailure, dictationExplanation, endedNotice, speechError } from "./dictation-failure.js";
import { registerAsrClients } from "./asr-clients.js";
import { endDictation, live, owners, release, stopping, type Capture } from "./dictation-capture.js";
import { acknowledge, dictationTarget, freshDiscovery, invalidateDiscovery, isAcknowledged, loadDiscovery } from "./dictation-providers.js";

/** V3 (#3690): a take with no speech for this long stops on its own, to review or to rest. */
export const SILENCE_STOP_MS = 30_000;
/** No speech for this long draws the take as quiet (D4). */
const QUIET_MS = 1_500;
/** An input level at or above this counts as speech; transcript events always do. */
const SPEECH_LEVEL = 0.15;

/**
 * Whether opening the microphone will ask (D2), read without asking. A
 * browser that cannot say answers null, and the take stays "Connecting".
 */
async function microphonePrompt(): Promise<boolean | null> {
  try {
    const status = await navigator.permissions?.query({ name: "microphone" as PermissionName });
    return status ? status.state === "prompt" : null;
  } catch { return null; }
}

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
  // Resolves the acknowledgement card a start() is waiting on (D4).
  const consentRef = useRef<((confirmed: boolean) => void) | null>(null);
  // The last capture this hook started, on the root it started it on.
  const captureRef = useRef<Capture | null>(null);
  // Ends the silence watch of the capture that is listening (V3).
  const silenceRef = useRef<(() => void) | null>(null);
  // stop() is defined after start(); the silence watch calls the current one.
  const stopRef = useRef<(commitToReview?: boolean) => Promise<void>>(async () => {});
  const setMode = useVoiceStore((s) => s.setMode);
  const setConnecting = useVoiceStore((s) => s.setConnecting);
  const setProviderId = useVoiceStore((s) => s.setProviderId);
  const setPartial = useVoiceStore((s) => s.setPartial);
  const appendFinal = useVoiceStore((s) => s.appendFinal);
  const setError = useVoiceStore((s) => s.setError);
  const resetCapture = useVoiceStore((s) => s.resetCapture);

  /**
   * V3: while the capture listens, speech is a transcript event or an input
   * level at SPEECH_LEVEL. After QUIET_MS without any the take is quiet (D4);
   * after SILENCE_STOP_MS it stops as Done would, so what was heard goes to
   * review (D6), and an empty take simply ends (D1). The watch ends with the
   * capture, however it ends.
   */
  const watchSilence = useCallback((capture: Capture) => {
    const voice = root.stores.voice;
    let quiet: ReturnType<typeof setTimeout> | undefined;
    let silence: ReturnType<typeof setTimeout> | undefined;
    const end = () => {
      clearTimeout(quiet);
      clearTimeout(silence);
      unsubscribe();
      if (silenceRef.current === end) silenceRef.current = null;
    };
    const arm = () => {
      clearTimeout(quiet);
      clearTimeout(silence);
      if (voice.getState().quiet) voice.setState({ quiet: false });
      quiet = setTimeout(() => {
        if (owners.get(capture.root) === capture && !stopping.has(capture)) voice.setState({ quiet: true });
      }, QUIET_MS);
      silence = setTimeout(() => {
        end();
        if (owners.get(capture.root) === capture && !stopping.has(capture)) void stopRef.current(true).catch(() => {});
      }, SILENCE_STOP_MS);
    };
    const unsubscribe = voice.subscribe((state, previous) => {
      if (owners.get(capture.root) !== capture || stopping.has(capture)) { end(); return; }
      if (state.finalText !== previous.finalText || state.partial !== previous.partial
        || (state.audioLevel >= SPEECH_LEVEL && state.audioLevel !== previous.audioLevel)) arm();
    });
    arm();
    return end;
  }, [root]);

  const start = useCallback(async () => {
    if (root.authLock.state.getState().phase !== "active") return;
    const gen = ++startGenRef.current;
    const capture: Capture = { root: root.stores, client: null };
    captureRef.current = capture;
    owners.set(root.stores, capture);
    resetCapture();
    setProviderId(null);
    consentRef.current?.(false);
    consentRef.current = null;
    root.stores.voice.setState({ dictationGate: null, dictationTarget: null });
    // Show the field immediately, but as "connecting" (Dc) — the mic is still
    // shut during the session fetch, so nothing may say "Listening" until
    // capture is actually open.
    setConnecting(true);
    setMode("dictate");

    const abort = new AbortController();
    sessionAbortRef.current = abort;
    const current = () => startGenRef.current === gen && live(capture);
    // Read alongside the session, so knowing whether the browser will ask
    // costs the take no time. It never opens the microphone.
    let prompt: Promise<boolean | null> | null = null;

    try {
      // Where the words go, from a snapshot young enough to disclose (#3709).
      // A fresh one is used without waiting, so a known, acknowledged service
      // requests its session in the same task as the tap.
      const snapshot = freshDiscovery(root) ?? await loadDiscovery(root, { signal: abort.signal }).catch((error: unknown) => {
        throw error instanceof TypeError ? speechError("Discovery transport failed", "network") : error;
      });
      if (!current()) return;
      const target = dictationTarget(snapshot);
      if (target.kind === "blocked") {
        // Nowhere to send audio: no session, no microphone, no fallback.
        if (sessionAbortRef.current === abort) sessionAbortRef.current = null;
        root.stores.voice.setState({ dictationGate: target, connecting: false });
        return;
      }
      const provider = target.provider;
      if (!isAcknowledged(root, provider)) {
        // D4: the first take to this service on this device names where the
        // audio goes and waits for Start dictation before anything is minted.
        root.stores.voice.setState({ dictationGate: { kind: "consent", provider }, connecting: false });
        const confirmed = await new Promise<boolean>((resolve) => {
          consentRef.current = resolve;
          abort.signal.addEventListener("abort", () => resolve(false), { once: true });
        });
        if (!confirmed || !current()) return;
        acknowledge(root, provider);
        root.stores.voice.setState({ dictationGate: null, connecting: true });
      }
      // The take is bound to the provider it disclosed; a default saved
      // elsewhere from now on changes nothing about it.
      root.stores.voice.setState({ dictationTarget: provider });
      prompt = microphonePrompt();
      // Fetch the dictation session + pronunciation overrides. The AsrClient's
      // start() opens the mic and buffers audio until its stream is ready, so
      // words spoken during connect are not lost.
      const [session, ov] = await Promise.all([
        api.voiceSession(abort.signal, { providerId: provider.id, smart: target.smart }).catch((error: unknown) => {
          // A refusal or failure may mean the choice changed: read it again next tap.
          invalidateDiscovery(root);
          // Fetch transport failures have no provider code. Do not inspect their text.
          throw error instanceof TypeError ? speechError("Session transport failed", "network") : error;
        }),
        api
          .voiceOverrides(abort.signal)
          .catch(() => ({ overrides: [] as PronunciationOverride[] })),
      ]);
      // Superseded by a Stop/Escape/backdrop/unmount while the session was in
      // flight? Bail before opening the mic — a MediaStream created here would
      // have no reference left to stop it.
      if (startGenRef.current !== gen) return;
      if (sessionAbortRef.current === abort) sessionAbortRef.current = null;
      // An explicit selection is exact: a session for any other service is
      // refused, never used in its place.
      if (session.providerId !== provider.id) {
        invalidateDiscovery(root);
        throw speechError("The session names a different speech provider", "unknown");
      }
      overridesRef.current = ov.overrides;
      // Surface which provider actually served this session.
      setProviderId(session.providerId);

      const hints = speechUiHints(session.capabilities);
      const client = root.asr.create({
        session,
        onEvent: (evt) => {
          // Only the capture still showing on this root, or one a stop() is
          // draining, writes to it: words from a client whose dictation has
          // ended (by its provider, a teardown or a newer start) would sit
          // where nothing shows them, and a later stop() would commit them
          // a second time.
          if (!live(capture)) return;
          if (evt.type === "partial") {
            // Providers without interim results skip live partials.
            if (hints.showPartials) {
              setPartial(applyOverrides(evt.text, overridesRef.current));
            }
          } else if (evt.type === "final" && evt.text) {
            appendFinal(applyOverrides(evt.text, overridesRef.current));
          }
        },
        onError: (err) => {
          if (!live(capture)) return;
          capture.failure = dictationFailure(err);
          if (stopping.has(capture)) capture.drainFailure = capture.failure;
          setError(dictationExplanation(capture.failure, "open"));
        },
      });
      // Publish the client before awaiting start() so a concurrent stop() can
      // grab and close it (releasing its MediaStream) while the mic is opening.
      clientRef.current = client;
      capture.client = client;
      // D2: the browser asks before the microphone opens.
      if (await prompt) {
        if (startGenRef.current !== gen || !live(capture)) {
          if (clientRef.current === client) clientRef.current = null;
          return;
        }
        root.stores.voice.setState({ micPrompt: true });
      }
      await client.start();
      // Stopped while the mic was opening? Close the client we just started —
      // its start() honors the closed flag and releases the stream.
      if (startGenRef.current !== gen || !live(capture)) {
        client.stop();
        if (clientRef.current === client) clientRef.current = null;
        return;
      }
      // Capture is live now — drop the connecting state so the field can show
      // the honest "Listening" indicator.
      root.stores.voice.setState({ connecting: false, micPrompt: false, quiet: false });
      silenceRef.current = watchSilence(capture);
    } catch (err) {
      // A superseded start failing (e.g. the aborted session fetch) is
      // expected — swallow it so it doesn't surface a spurious error.
      if (startGenRef.current !== gen || !live(capture)) return;
      if (sessionAbortRef.current === abort) sessionAbortRef.current = null;
      const reason = dictationFailure(err);
      clientRef.current?.stop();
      clientRef.current = null;
      setError(dictationExplanation(reason, "startup"));
      root.stores.voice.setState({ dictationNotice: { reason, phase: "startup", retained: false }, dictationGate: null, dictationTarget: null, micPrompt: false });
      release(capture);
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
    watchSilence,
  ]);

  // Invalidate any in-flight start, cancel its session fetch, and hand back
  // the current client for the caller to close. It reads the refs when it
  // runs, not when the hook mounted, so it reaches a session started later.
  const releaseCapture = useCallback((): AsrClient | null => {
    startGenRef.current++;
    silenceRef.current?.();
    consentRef.current?.(false);
    consentRef.current = null;
    sessionAbortRef.current?.abort();
    sessionAbortRef.current = null;
    const client = clientRef.current;
    clientRef.current = null;
    return client;
  }, []);

  const stop = useCallback(
    async (commitToReview = true) => {
      // This stop now ends the capture, even if the hook is torn down while
      // it drains: the transcript still reaches review before it goes idle.
      // Only a capture still showing on its root: one its provider already
      // ended has handed its words over, and draining it again would let a
      // late event commit them twice.
      const owned = captureRef.current?.root === root.stores ? captureRef.current : null;
      const capture = owned && (owners.get(owned.root) === owned || stopping.has(owned)) ? owned : null;
      // A second Done while the first still drains: the first hands
      // everything to review, this one has nothing to add.
      // A Cancel then discards what that drain was handing over.
      if (owned && !capture) {
        releaseCapture()?.stop();
        return;
      }
      const ownDrain = Boolean(capture && stopping.has(capture));
      if (commitToReview && ownDrain) return;
      // A slow connect must not open the mic after the user asked it to stop.
      const client = releaseCapture() ?? (!commitToReview ? capture?.client : null);
      if (capture) stopping.add(capture);

      const setDraining = root.stores.voice.getState().setDraining;
      // A failed drain still ends the dictation and keeps what was heard;
      // the failure is rethrown after, so it is not swallowed.
      let drainFailure: { error: unknown } | null = null;
      const drained = Boolean(client && commitToReview);
      if (client) {
        if (commitToReview) {
          setDraining(true);
          try {
            await client.drainAndStop();
          } catch (error) {
            drainFailure = { error };
          }
        } else {
          client.stop();
        }
      }

      // What was heard joins the review text in the update that ends the
      // drain, so nothing sees the drain over and the words not yet in review.
      // Auth cancellation may have invalidated a Done still awaiting drain.
      if (commitToReview && capture && !stopping.has(capture)) return;
      // A failure the client reported while it drained (an abnormal close, a
      // socket error) ends this Done as the provider-ended path would: the
      // kept words carry a notice saying why. One reported earlier, which the
      // take survived, does not: Done is not a provider failure.
      const { finalText, partial } = root.stores.voice.getState();
      const notice = commitToReview && drained && capture?.drainFailure
        ? endedNotice(capture.drainFailure, [finalText, partial].filter(Boolean).join(" "))
        : null;
      const handled = endDictation(root.stores.voice, commitToReview, {
        ...(drained || ownDrain ? { draining: false } : {}),
        ...(notice ? { dictationNotice: notice } : {}),
      });
      if (capture) {
        release(capture);
        // Ended: nothing it reports from now on is heard.
        stopping.delete(capture);
      }
      // Another hook's drain still owns the buffer: leave it to that drain.
      // endDictation already cleared the transcript; a notice stays shown.
      if (handled && !notice) resetCapture();
      if (drainFailure) throw drainFailure.error;
    },
    [releaseCapture, resetCapture, root]
  );

  stopRef.current = stop;
  useEffect(() => root.authLock.registerStop(() => stop(false)), [root, stop]);

  const cancel = useCallback(() => {
    void stop(false);
  }, [stop]);

  useEffect(() => {
    // Tear down on unmount or root change: invalidate the in-flight start,
    // abort its fetch, and stop the client so no MediaStream survives.
    // The dictation this hook started has ended, so the store says so: a
    // live dictation holds update reloads (#1015), and one nobody can stop
    // would hold them for good. What was heard goes to review, as when the
    // provider ends it (#1189); text already under review stays.
    return () => {
      releaseCapture()?.stop();
      const capture = captureRef.current;
      if (!capture || capture.root !== root.stores || stopping.has(capture)) return;
      if (owners.get(root.stores) !== capture) return;
      release(capture);
      endDictation(root.stores.voice, true);
    };
  }, [root, releaseCapture]);

  /** Start dictation on the acknowledgement card (D4). */
  const confirm = useCallback(() => {
    const resolve = consentRef.current;
    consentRef.current = null;
    resolve?.(true);
  }, []);

  return { start, stop, cancel, confirm };
}
