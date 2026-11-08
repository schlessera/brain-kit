// Which dictation service the next take goes to, as the browser knows it.
//
// The server owns registration and the saved brain-wide default
// (`GET /api/voice/providers`, #3707). This module keeps one read-only
// discovery snapshot per root, resolves the take's target from it, names the
// service for the mic, the sheet and the acknowledgement card, and keeps the
// one-time per-device acknowledgement (D4). Reading discovery never mints a
// credential, never opens the microphone and never sends audio.

import type { VoiceProvidersResponse } from "@schlessera/brain-ui-sdk/protocol";
import type { BrainUiRoot } from "../root.js";

export type DictationProvider = VoiceProvidersResponse["providers"][number];

/** A take reads discovery again when its snapshot is older than this (plan §5). */
const DISCOVERY_MAX_AGE_MS = 60_000;

/** Display names for built-ins that register without a label. */
const BUILT_IN: Record<string, { label: string; short: string; destination: string }> = {
  deepgram: { label: "Deepgram", short: "Deepgram", destination: "While you speak, microphone audio streams from this browser to Deepgram." },
  webspeech: { label: "Browser speech", short: "Browser speech", destination: "While you speak, microphone audio goes to this browser's speech service. In Chrome, that is Google." },
  gemini: { label: "Google Gemini", short: "Gemini", destination: "While you speak, microphone audio streams from this browser to Google." },
};

/** The provider's full name, as the sheet and Settings show it. */
export function providerLabel(provider: DictationProvider): string {
  if (provider.label && provider.label !== provider.id) return provider.label;
  return BUILT_IN[provider.id]?.label ?? provider.id;
}

/** The short name for the mic's accessible name and tooltip. */
export function providerShortLabel(provider: DictationProvider): string {
  return BUILT_IN[provider.id]?.short ?? providerLabel(provider);
}

/** Where the audio goes, in the provider's own words when it gave any. */
export function providerDestination(provider: DictationProvider): string {
  return provider.destination?.trim() || BUILT_IN[provider.id]?.destination
    || `While you speak, microphone audio streams from this browser to ${providerLabel(provider)}.`;
}

type DictationTarget =
  | { kind: "ready"; provider: DictationProvider; smart: boolean }
  /** none: nothing registered; choose: several, nothing saved, no host default; unavailable: the saved choice is gone. */
  | { kind: "blocked"; reason: "none" | "choose" | "unavailable"; saved: string | null };

/** The take's target from a discovery snapshot. Never falls back past the server's rules. */
export function dictationTarget(snapshot: VoiceProvidersResponse): DictationTarget {
  const { dictation, providers } = snapshot;
  const effective = dictation.effective === null ? undefined : providers.find((p) => p.id === dictation.effective);
  if (effective) return { kind: "ready", provider: effective, smart: dictation.smart };
  // With nothing registered there is nothing to choose, whatever was saved.
  if (providers.length === 0) return { kind: "blocked", reason: "none", saved: null };
  if (dictation.source === "unavailable" || (dictation.saved !== null && !dictation.savedUsable)) {
    return { kind: "blocked", reason: "unavailable", saved: dictation.saved };
  }
  return { kind: "blocked", reason: "choose", saved: null };
}

const SOURCES = new Set(["saved", "host", "only", "none", "unavailable"]);
const optionalString = (value: unknown) => value === undefined || typeof value === "string";
const nullableString = (value: unknown) => value === null || typeof value === "string";

/** The `GET /voice/providers` shape, checked before anything is shown or sent from it. */
export function isDiscovery(value: unknown): value is VoiceProvidersResponse {
  if (!value || typeof value !== "object") return false;
  const { providers, dictation } = value as Partial<VoiceProvidersResponse>;
  if (!Array.isArray(providers) || !dictation || typeof dictation !== "object") return false;
  const providersValid = providers.every((provider) => provider && typeof provider === "object"
    && typeof provider.id === "string" && provider.id !== "" && typeof provider.label === "string" && optionalString(provider.destination)
    && provider.capabilities !== null && typeof provider.capabilities === "object");
  return providersValid && nullableString(dictation.saved) && typeof dictation.savedUsable === "boolean"
    && nullableString(dictation.host) && nullableString(dictation.effective) && SOURCES.has(dictation.source)
    && typeof dictation.smart === "boolean" && typeof dictation.revision === "string";
}

type Cache = { inflight: Promise<VoiceProvidersResponse> | null; issued: number; published: number };
const caches = new WeakMap<object, Cache>();
const cacheOf = (root: BrainUiRoot): Cache => {
  let cache = caches.get(root.stores);
  if (!cache) caches.set(root.stores, cache = { inflight: null, issued: 0, published: 0 });
  return cache;
};

/** The root's snapshot, when it is young enough for a take to use as is. */
export function freshDiscovery(root: BrainUiRoot, maxAgeMs = DISCOVERY_MAX_AGE_MS): VoiceProvidersResponse | null {
  const known = root.stores.voice.getState().discovery;
  return known && Date.now() - known.at <= maxAgeMs ? known.snapshot : null;
}

/** Forget the snapshot, so the next take reads the server's current choice. */
export function invalidateDiscovery(root: BrainUiRoot): void {
  root.stores.voice.setState({ discovery: null });
}

/**
 * Read discovery. Reads share one request per root unless `force` starts a
 * new one (after a save, so a read issued before it cannot answer for it);
 * the newest issued response is the one kept. An abort only stops the caller
 * from waiting.
 */
export function loadDiscovery(root: BrainUiRoot, options: { maxAgeMs?: number; force?: boolean; signal?: AbortSignal } = {}): Promise<VoiceProvidersResponse> {
  const fresh = options.force ? null : freshDiscovery(root, options.maxAgeMs ?? DISCOVERY_MAX_AGE_MS);
  if (fresh) return Promise.resolve(fresh);
  const cache = cacheOf(root);
  if (!cache.inflight || options.force) {
    const issued = ++cache.issued;
    const read: Promise<VoiceProvidersResponse> = root.api.voiceProviders().then((snapshot: unknown) => {
      // Only a well-formed answer can name a destination.
      if (!isDiscovery(snapshot)) throw new Error("Malformed dictation discovery");
      if (issued > cache.published) {
        cache.published = issued;
        root.stores.voice.setState({ discovery: { snapshot, at: Date.now() } });
      }
      return root.stores.voice.getState().discovery?.snapshot ?? snapshot;
    }).finally(() => { if (cache.inflight === read) cache.inflight = null; });
    cache.inflight = read;
  }
  const read = cache.inflight!;
  const signal = options.signal;
  if (!signal) return read;
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new DOMException("Aborted", "AbortError")); return; }
    const abort = () => reject(new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", abort, { once: true });
    read.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

/** Where a provider's acknowledgement lives: per brain origin, root prefix, account and provider. */
function acknowledgementKey(root: BrainUiRoot, provider: DictationProvider): string {
  const account = root.stores.connection.getState().accountKey ?? "anonymous";
  return `brain-ui:dictation-acknowledged:${encodeURIComponent(account)}:${encodeURIComponent(provider.id)}`;
}

/**
 * Whether this device acknowledged where this provider's audio goes. The
 * stored value is the destination text: a changed text asks again. Storage
 * that cannot be read means "not acknowledged", never consent.
 */
export function isAcknowledged(root: BrainUiRoot, provider: DictationProvider): boolean {
  return root.stores.voice.getState().readAcknowledgement(acknowledgementKey(root, provider)) === providerDestination(provider);
}

export function acknowledge(root: BrainUiRoot, provider: DictationProvider): void {
  root.stores.voice.getState().writeAcknowledgement(acknowledgementKey(root, provider), providerDestination(provider));
}
