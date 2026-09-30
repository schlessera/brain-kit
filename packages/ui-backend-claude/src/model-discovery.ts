// Anthropic model discovery.
//
// The model roster changes far faster than this package ships, so the picker
// asks the Models API (`GET /v1/models`) instead of carrying a hardcoded list or
// making every deployment hand-maintain one in an env var.
//
// Two things this has to get right:
//
//  1. CREDENTIALS. A subscription deployment has only `CLAUDE_CODE_OAUTH_TOKEN`
//     (no API key). That token works against the Models API, but as
//     `Authorization: Bearer` plus the `oauth-2025-04-20` beta header — not as
//     `x-api-key`. Verified against a live subscription token.
//
//  2. ALIASES. The API lists some models ONLY under a dated id
//     (`claude-haiku-4-5-20251001`), while others are undated
//     (`claude-opus-5-5`). Showing dated ids is noise, but dropping them loses
//     those models entirely. Stripping the `-YYYYMMDD` suffix yields the public
//     alias, which the API itself resolves (`GET /v1/models/claude-haiku-4-5`
//     → 200, canonicalizing back to the dated id). We strip, then confirm the
//     alias resolves before using it, and remember the answer in the cache so a
//     refresh normally costs exactly one request.
//
// Discovery is best-effort by construction: no credential, no network, or a
// broken response degrades to "no discovered models" (or the last good cache),
// never to a throw. The picker keeps working off declared profiles.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { canonicalModelId, THINKING_LEVELS } from "@schlessera/brain-ui-sdk/protocol";
import type { ThinkingLevel } from "@schlessera/brain-ui-sdk/protocol";
import { SUBSCRIPTION_AUTH_INSTRUCTIONS } from "@schlessera/brain-ui-sdk/server";
import { resolveEnv } from "./config/env.js";
import type { BackendLogFn } from "./options.js";
import type { InferenceProfileInput } from "./profiles.js";

// Long-standing export of this module; the definition now lives in the SDK
// so pricing (ui-server) canonicalizes identically.
export { canonicalModelId };

const MODELS_URL = "https://api.anthropic.com/v1/models";
const ANTHROPIC_VERSION = "2023-06-01";
const OAUTH_BETA = "oauth-2025-04-20";
const REQUEST_TIMEOUT_MS = 10_000;
/** Bound on `has_more` paging; the roster is ~10 models, 100 per page. */
const MAX_PAGES = 5;
const CACHE_VERSION = 1;
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

/** The subset of a Models API row we use. */
interface AnthropicModel {
  id: string;
  display_name?: string;
  max_input_tokens?: number;
  capabilities?: { effort?: Partial<Record<ThinkingLevel, { supported?: boolean }>> | null };
}

interface ModelsListResponse {
  data?: AnthropicModel[];
  has_more?: boolean;
  last_id?: string;
}

/** Alias id → whether the API resolves it. Persisted so we ask once per alias. */
export type AliasChecks = Record<string, boolean>;

interface ModelCacheFile {
  version: number;
  fetchedAt: number;
  models: InferenceProfileInput[];
  aliasChecks: AliasChecks;
}

/** The Models API refused the credential discovery sent. */
export class ModelDiscoveryAuthError extends Error {
  constructor(
    readonly status: number,
    /** Which credential was refused. */
    readonly credential: DiscoveryCredential = "oauth"
  ) {
    super(`Anthropic Models API refused the credential (HTTP ${status}): authentication failed`);
    this.name = "ModelDiscoveryAuthError";
  }
}

export interface DiscoverOptions {
  /** Previously confirmed alias resolutions, to skip re-validating known ids. */
  aliasChecks?: AliasChecks;
  /** @internal Test seam — inject fetch. */
  fetchImpl?: typeof fetch;
}

/** The credential discovery authenticated with. */
export type DiscoveryCredential = "oauth" | "api_key";

export interface DiscoverResult {
  models: InferenceProfileInput[];
  aliasChecks: AliasChecks;
  /** The credential the roster was fetched with; null when there was none. */
  credential: DiscoveryCredential | null;
  /** The Models API accepted the credential and answered with a roster. */
  authenticated: boolean;
}

/**
 * Auth headers for the Models API, or null when the process holds no usable
 * credential. The subscription token wins over an API key, the same rule the
 * turns follow (subscription.ts): a host that holds both runs its chat on the
 * subscription, so it discovers the models the subscription can reach.
 */
function authHeaders(): { headers: Record<string, string>; credential: DiscoveryCredential } | null {
  const base = {
    "anthropic-version": ANTHROPIC_VERSION,
    accept: "application/json",
  };
  const { anthropicApiKey, claudeCodeOauthToken } = resolveEnv();
  const oauth = claudeCodeOauthToken?.trim();
  if (oauth) {
    return {
      credential: "oauth",
      headers: {
        ...base,
        authorization: `Bearer ${oauth}`,
        // Without this the OAuth token is rejected on most endpoints.
        "anthropic-beta": OAUTH_BETA,
      },
    };
  }

  const apiKey = anthropicApiKey?.trim();
  if (apiKey) return { credential: "api_key", headers: { ...base, "x-api-key": apiKey } };
  return null;
}

/** One GET with a hard timeout and a single retry on 5xx / network failure. */
async function getJson(
  url: string,
  headers: Record<string, string>,
  fetchImpl: typeof fetch
): Promise<{ status: number; body: unknown }> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetchImpl(url, {
        headers,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      // 4xx is terminal (bad credential, unknown model) — don't burn a retry.
      if (!res.ok && res.status < 500) return { status: res.status, body: null };
      if (res.ok) return { status: res.status, body: await res.json() };
      lastError = new Error(`HTTP ${res.status}`);
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/**
 * Fetch the roster, canonicalize dated ids to their aliases, and return
 * profile inputs ready to hand to `defineProfiles`. Throws only on a transport
 * failure the caller should surface; a missing credential resolves to an empty
 * roster.
 */
export async function discoverAnthropicModels(
  options: DiscoverOptions = {}
): Promise<DiscoverResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const aliasChecks: AliasChecks = { ...(options.aliasChecks ?? {}) };
  const auth = authHeaders();
  if (!auth) return { models: [], aliasChecks, credential: null, authenticated: false };
  const { headers, credential } = auth;

  const rows: AnthropicModel[] = [];
  // Only a 200 that carries a roster shows the credential works; a 429 or a
  // malformed body answers nothing about it.
  let authenticated = false;
  let url = `${MODELS_URL}?limit=100`;
  for (let page = 0; page < MAX_PAGES; page++) {
    const { status, body } = await getJson(url, headers, fetchImpl);
    // A refused credential is an auth failure to report, not an empty
    // roster: the same token authenticates every chat turn (#211).
    if (status === 401 || status === 403) throw new ModelDiscoveryAuthError(status, credential);
    const parsed = (body ?? {}) as ModelsListResponse;
    if (status !== 200 || !Array.isArray(parsed.data)) break;
    authenticated = true;
    rows.push(...parsed.data);
    if (!parsed.has_more || !parsed.last_id) break;
    url = `${MODELS_URL}?limit=100&after_id=${encodeURIComponent(parsed.last_id)}`;
  }

  const models: InferenceProfileInput[] = [];
  const seen = new Set<string>();

  for (const row of rows) {
    if (!row || typeof row.id !== "string" || row.id.length === 0) continue;

    const alias = canonicalModelId(row.id);
    let id = row.id;
    if (alias !== row.id) {
      let valid = aliasChecks[alias];
      if (valid === undefined) {
        valid = await aliasResolves(alias, headers, fetchImpl, credential);
        aliasChecks[alias] = valid;
      }
      // A dated id whose alias doesn't resolve stays dated — better an ugly
      // label than a model id the SDK will 404 on.
      if (valid) id = alias;
    }

    // The API returns newest first; the first spelling of a model wins.
    if (seen.has(id)) continue;
    seen.add(id);

    models.push({
      id,
      label: row.display_name?.trim() || id,
      vendor: "anthropic",
      model: id,
      source: "discovered",
      ...(row.capabilities && typeof row.capabilities === "object" && "effort" in row.capabilities
        ? { supportedThinkingLevels: THINKING_LEVELS.filter((level) => row.capabilities?.effort?.[level]?.supported === true) }
        : {}),
      ...(typeof row.max_input_tokens === "number"
        ? { contextWindow: row.max_input_tokens }
        : {}),
    });
  }

  return { models, aliasChecks, credential, authenticated };
}

/**
 * Does `GET /v1/models/{alias}` resolve? Network failures count as "no"; a
 * refused credential is an auth failure, not an answer about the alias.
 */
async function aliasResolves(
  alias: string,
  headers: Record<string, string>,
  fetchImpl: typeof fetch,
  credential: DiscoveryCredential
): Promise<boolean> {
  let status: number;
  try {
    ({ status } = await getJson(`${MODELS_URL}/${encodeURIComponent(alias)}`, headers, fetchImpl));
  } catch {
    return false;
  }
  if (status === 401 || status === 403) throw new ModelDiscoveryAuthError(status, credential);
  return status === 200;
}

// --- Cache -----------------------------------------------------------------

/** Cache path: alongside the voice keyterm cache, on the persisted brain volume. */
export function modelCachePath(brainPath: string): string {
  return join(brainPath, ".brain-ui", "anthropic-models.json");
}

function readCache(path: string): ModelCacheFile | null {
  try {
    if (!existsSync(path)) return null;
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as ModelCacheFile;
    if (parsed?.version !== CACHE_VERSION || !Array.isArray(parsed.models)) {
      return null;
    }
    return parsed;
  } catch {
    // A corrupt cache is not fatal — discovery will rewrite it.
    return null;
  }
}

function writeCache(path: string, cache: ModelCacheFile): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(cache, null, 2), "utf-8");
  } catch (err) {
    console.warn(
      `[models] Could not write model cache: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }
}

// --- Model source ----------------------------------------------------------

export interface ModelSourceOptions {
  /** Brain repo path; the cache lives under its `.brain-ui/` directory. */
  brainPath: string;
  /** How long a discovery result is considered fresh. Default 24h. */
  ttlMs?: number;
  /** Set false to disable discovery entirely (list() stays empty). */
  enabled?: boolean;
  /** @internal Test seam — inject fetch. */
  fetchImpl?: typeof fetch;
  /** @internal Test seam — inject the clock. */
  now?: () => number;
  /** Where a refused credential is reported. */
  log?: BackendLogFn;
}

export interface ModelSourceState {
  enabled: boolean;
  /** When discovery last succeeded; null when it never has. */
  refreshedAt: number | null;
  /** The cached result is older than the TTL (or absent). */
  stale: boolean;
  /** Last discovery failure, if the current list is served despite one. */
  error?: string;
  /** When discovery last succeeded on the subscription token, in this process. */
  subscriptionProvenAt?: number;
  /** The last time the Models API refused the subscription token. */
  subscriptionRefused?: { status: number; at: number };
}

/**
 * A lazily-refreshed roster of discovered models.
 *
 * `list()` is synchronous and never touches the network, so rendering the
 * picker can't block on Anthropic being reachable. `ensureFresh()` is what
 * callers put in front of a request: it awaits only on a cold start (no cache
 * at all) and otherwise serves the current list while refreshing behind it.
 */
export interface ModelSource {
  list(): InferenceProfileInput[];
  state(): ModelSourceState;
  /** Refresh if stale. Awaits only when there is nothing cached to serve. */
  ensureFresh(): Promise<void>;
  /** Force a refresh regardless of TTL. Rejects on failure. */
  refresh(): Promise<void>;
}

export function createModelSource(options: ModelSourceOptions): ModelSource {
  const { brainPath } = options;
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const enabled = options.enabled ?? true;
  const now = options.now ?? Date.now;
  const cachePath = modelCachePath(brainPath);

  const cached = enabled ? readCache(cachePath) : null;
  let models: InferenceProfileInput[] = cached?.models ?? [];
  let aliasChecks: AliasChecks = cached?.aliasChecks ?? {};
  let refreshedAt: number | null = cached?.fetchedAt ?? null;
  let lastError: string | undefined;
  // In memory only: a cached roster from an earlier process proves nothing
  // about the token this one holds.
  let subscriptionProvenAt: number | undefined;
  let subscriptionRefused: { status: number; at: number } | undefined;
  let inFlight: Promise<void> | null = null;

  const isStale = () =>
    refreshedAt === null || now() - refreshedAt > ttlMs;

  async function doRefresh(): Promise<void> {
    try {
      const result = await discoverAnthropicModels({
        aliasChecks,
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      });
      models = result.models;
      aliasChecks = result.aliasChecks;
      refreshedAt = now();
      lastError = undefined;
      if (result.authenticated && result.credential === "oauth") subscriptionProvenAt = refreshedAt;
      writeCache(cachePath, {
        version: CACHE_VERSION,
        fetchedAt: refreshedAt,
        models,
        aliasChecks,
      });
    } catch (err) {
      // Keep serving whatever we already had; surface the reason.
      lastError = err instanceof Error ? err.message : String(err);
      if (err instanceof ModelDiscoveryAuthError) {
        if (err.credential === "oauth") subscriptionRefused = { status: err.status, at: now() };
        options.log?.(
          "warn",
          err.credential === "oauth"
            ? `model discovery: ${SUBSCRIPTION_AUTH_INSTRUCTIONS.relogin}`
            : "model discovery: the API key was refused",
          {
            "http.status": err.status,
            "failure.class": "authentication_failed",
            ...(err.credential === "oauth" ? { "auth.action": "relogin" } : {}),
          }
        );
      }
      throw err;
    }
  }

  function refresh(): Promise<void> {
    if (!enabled) return Promise.resolve();
    // Single-flight: a burst of requests triggers one fetch, not N.
    if (!inFlight) {
      inFlight = doRefresh().finally(() => {
        inFlight = null;
      });
    }
    return inFlight;
  }

  return {
    list: () => (enabled ? models : []),
    state: () => ({
      enabled,
      refreshedAt,
      stale: enabled ? isStale() : false,
      ...(lastError !== undefined ? { error: lastError } : {}),
      ...(subscriptionProvenAt !== undefined ? { subscriptionProvenAt } : {}),
      ...(subscriptionRefused !== undefined ? { subscriptionRefused } : {}),
    }),
    async ensureFresh() {
      if (!enabled || !isStale()) return;
      // Cold start: nothing to serve, so the caller waits (bounded by the
      // request timeout). Otherwise refresh in the background.
      if (models.length === 0) {
        await refresh().catch(() => {});
        return;
      }
      void refresh().catch(() => {});
    },
    refresh,
  };
}
