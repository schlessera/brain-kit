// Which dictation service the next take goes to, as the browser knows it.
//
// The server owns registration and the saved brain-wide default
// (`GET /api/voice/providers`, #3707). This module keeps one read-only
// discovery snapshot per root, resolves the take's target from it, names the
// service for the mic, the sheet and the acknowledgement card, and keeps the
// one-time per-device acknowledgement (D4). Reading discovery never mints a
// credential, never opens the microphone and never sends audio.

import type { DictationSettings, VoiceProvidersResponse } from "@schlessera/brain-ui-sdk/protocol";
import type { BrainUiRoot } from "../root.js";

export type DictationProvider = VoiceProvidersResponse["providers"][number];

/** A take reads discovery again when its snapshot is older than this (plan §5). */
const DISCOVERY_MAX_AGE_MS = 60_000;

/**
 * Display names for built-ins that register without a label or destination.
 * The server's own `label` and `destination` win whenever it sends them.
 */
const BUILT_IN: Record<string, { label: string; short: string; destination: string }> = {
  deepgram: { label: "Deepgram", short: "Deepgram", destination: "While you speak, microphone audio streams from this browser to Deepgram." },
  webspeech: { label: "Browser speech", short: "Browser speech", destination: "While you speak, microphone audio goes to this browser's speech service. In Chrome, that is Google." },
  gemini: { label: "Google Gemini 3.5 Transcribe Live", short: "Gemini", destination: "While you speak, microphone audio streams from this browser to Google." },
};

/** The server's label, when it sent one; a label equal to the id means none was registered. */
const serverLabel = (provider: DictationProvider): string | null =>
  provider.label && provider.label !== provider.id ? provider.label : null;

/** The provider's full name, as the sheet and Settings show it. */
export function providerLabel(provider: DictationProvider): string {
  return serverLabel(provider) ?? BUILT_IN[provider.id]?.label ?? provider.id;
}

/**
 * The short name for the mic's accessible name and tooltip. A built-in's
 * short name stands in only for the name it shortens; any other label the
 * server sends is used as it is.
 */
export function providerShortLabel(provider: DictationProvider): string {
  const known = BUILT_IN[provider.id];
  const label = serverLabel(provider);
  return known && (label === null || label === known.label) ? known.short : providerLabel(provider);
}

/** A saved choice the host no longer offers, by the name Settings knew it by. */
export function savedServiceName(id: string | null): string | null {
  return id === null ? null : BUILT_IN[id]?.short ?? id;
}

/** Where the audio goes, in the provider's own words when it gave any. */
export function providerDestination(provider: DictationProvider): string {
  return provider.destination?.trim() || BUILT_IN[provider.id]?.destination
    || `While you speak, microphone audio streams from this browser to ${providerLabel(provider)}.`;
}

/**
 * Whether this browser is known to be Chrome, whose speech service is
 * Google's. Only a brand the browser reports counts; anything else is not
 * claimed (#3694, K2).
 */
function isChrome(nav: Navigator | undefined = typeof navigator === "undefined" ? undefined : navigator): boolean {
  const brands = (nav as (Navigator & { userAgentData?: { brands?: { brand: string }[] } }) | undefined)?.userAgentData?.brands;
  return Boolean(brands?.some((b) => b.brand === "Google Chrome"));
}

/** The built-in Gemini service under its own name, which the field calls Google Gemini. */
const builtInGemini = (provider: DictationProvider) => provider.id === "gemini" && providerShortLabel(provider) === BUILT_IN.gemini!.short;

/**
 * Where the words go, as the voice field's label meta names it in Dc and
 * D3–D5 (#3694): "to Google Gemini", "via Deepgram", or browser speech with
 * its destination only where the browser is known.
 */
export function providerMeta(provider: DictationProvider, chrome = isChrome()): string {
  if (provider.id === "webspeech") return chrome ? "browser speech \u00b7 audio goes to Google" : "browser speech \u00b7 sent by your browser";
  if (provider.id === "deepgram") return `via ${providerShortLabel(provider)}`;
  if (builtInGemini(provider)) return "to Google Gemini";
  return `to ${providerShortLabel(provider)}`;
}

/** Who the words are sent to, as the first-take acknowledgement (D0) says it. */
export function providerRecipient(provider: DictationProvider, chrome = isChrome()): string {
  if (provider.id === "webspeech") return chrome ? "Google" : "your browser\u2019s speech service";
  if (builtInGemini(provider)) return "Google Gemini";
  return providerShortLabel(provider);
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

/** The root's snapshot, when it is current and young enough for a take to use as is. */
export function freshDiscovery(root: BrainUiRoot, maxAgeMs = DISCOVERY_MAX_AGE_MS): VoiceProvidersResponse | null {
  const known = root.stores.voice.getState().discovery;
  return known && !known.stale && Date.now() - known.at <= maxAgeMs ? known.snapshot : null;
}

/**
 * The snapshot may no longer be the server's: the next take reads discovery
 * again before it discloses anything, and no read issued before now can
 * publish over what comes next. The snapshot stays for display, marked stale.
 */
export function invalidateDiscovery(root: BrainUiRoot): void {
  const cache = cacheOf(root);
  cache.inflight = null;
  cache.published = cache.issued;
  const known = root.stores.voice.getState().discovery;
  if (known && !known.stale) root.stores.voice.setState({ discovery: { ...known, stale: true } });
}

/**
 * The snapshot with settings the server confirmed, resolved by the server's
 * own precedence (plan §4): a saved choice wins, or is unavailable; else the
 * host default; else the only registered provider.
 */
function reconcileDiscovery(snapshot: VoiceProvidersResponse, settings: DictationSettings): VoiceProvidersResponse {
  const ids = snapshot.providers.map((provider) => provider.id);
  const saved = settings.defaultProvider;
  const host = snapshot.dictation.host;
  const savedUsable = saved !== null && ids.includes(saved);
  const effective = saved !== null ? savedUsable ? saved : null : host ?? (ids.length === 1 ? ids[0]! : null);
  const source = saved !== null ? savedUsable ? "saved" : "unavailable" : host !== null ? "host" : effective !== null ? "only" : "none";
  return { providers: snapshot.providers, dictation: { saved, savedUsable, host, effective, source, smart: settings.smart, revision: settings.revision } };
}

/**
 * A write the server confirmed. Settings, the mic and the tray show it at
 * once; the snapshot it was made against is stale, so a take re-reads
 * discovery before it uses it.
 */
export function confirmDictationSettings(root: BrainUiRoot, settings: DictationSettings): void {
  invalidateDiscovery(root);
  const known = root.stores.voice.getState().discovery;
  if (known) root.stores.voice.setState({ discovery: { snapshot: reconcileDiscovery(known.snapshot, settings), at: known.at, stale: true } });
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
