// Model pricing.
//
// The rollup layer needs per-token USD rates to turn a run's token usage into
// an effective cost, and prices change far faster than this package ships. So
// rates come from two remote catalogs, merged and TTL-cached, with a bundled
// snapshot as the offline fallback — the same shape as the model-discovery
// source in `ui-backend-claude` (versioned cache envelope, synchronous reads,
// cold-start-only await, single-flight refresh, serve-stale-on-error).
//
// The two sources cover different territory:
//
//  1. LITELLM (`model_prices_and_context_window.json`): community-maintained,
//     per-single-token floats, keyed bare for Anthropic/OpenAI and
//     `gemini/...` for Gemini. Broad coverage, known cross-key drift — so
//     entries are validated on ingest and dropped, never trusted blindly.
//
//  2. OPENROUTER (`GET /api/v1/models`): the vendor's own catalog, keyed
//     `vendor/model`, prices as STRING per-token USD. `"0"` is genuinely
//     free, not unknown. OpenRouter wins for ids its catalog carries, since
//     an openrouter-routed run is billed at OpenRouter's rate.
//
// Pricing is best-effort by construction: no network, a broken response, or a
// corrupt cache degrades to the last good table (or the snapshot), never to a
// throw. A model the table cannot price resolves to null — the caller renders
// unknown, never zero (the binding fail-loud decision).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";

import { canonicalModelId } from "@schlessera/brain-ui-sdk/protocol";

const LITELLM_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
const OPENROUTER_URL = "https://openrouter.ai/api/v1/models";
const REQUEST_TIMEOUT_MS = 10_000;
const CACHE_VERSION = 1;
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Per-token USD rates for one model. `cacheRead`/`cacheWrite` are null when
 * the source lacks them — a caller whose run consumed cache tokens must then
 * treat the whole run as unpriced, never price the gap at zero.
 */
export interface PricingRates {
  input: number;
  output: number;
  cacheRead: number | null;
  cacheWrite: number | null;
  /** True when the rates came from the bundled snapshot (genuinely dated). */
  estimate: boolean;
  source: "litellm" | "openrouter" | "snapshot";
}

/** The stored shape: rates without the resolution-time flags. */
interface RawRate {
  input: number;
  output: number;
  cacheRead: number | null;
  cacheWrite: number | null;
}

/** One remote source's last successful fetch. */
interface SourceTable {
  /** When this source last fetched successfully; null when it never has. */
  fetchedAt: number | null;
  rates: Record<string, RawRate>;
}

/**
 * The cache envelope — also the format of the bundled snapshot, which sets
 * `snapshot: true` so a consumer reading the file can tell the two apart.
 * Sources are stored separately (not pre-merged) so a partial refresh can
 * replace one side while keeping the other's last data.
 */
interface PricingCacheFile {
  version: number;
  /** Most recent successful refresh (either source). */
  fetchedAt: number;
  litellm: SourceTable;
  openrouter: SourceTable;
  snapshot?: boolean;
}

// --- ingest validation -------------------------------------------------------

/** A finite, non-negative price from a float or an OpenRouter string; else null. */
function asPrice(value: unknown): number | null {
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * Build a rate from raw fields, or null when input/output don't validate.
 * Cache rates are optional — absent or malformed becomes null, which the
 * resolution contract surfaces to the caller rather than papering over.
 */
function toRate(
  input: unknown,
  output: unknown,
  cacheRead: unknown,
  cacheWrite: unknown
): RawRate | null {
  const inp = asPrice(input);
  const out = asPrice(output);
  if (inp === null || out === null) return null;
  return { input: inp, output: out, cacheRead: asPrice(cacheRead), cacheWrite: asPrice(cacheWrite) };
}

/** LiteLLM: one big object keyed by model id, per-single-token floats. */
function parseLitellm(body: unknown): Record<string, RawRate> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new Error("unexpected LiteLLM payload");
  }
  const rates: Record<string, RawRate> = {};
  for (const [id, entry] of Object.entries(body)) {
    // The field-set documentation row, not a model.
    if (id === "sample_spec") continue;
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as Record<string, unknown>;
    const rate = toRate(
      e.input_cost_per_token,
      e.output_cost_per_token,
      e.cache_read_input_token_cost,
      e.cache_creation_input_token_cost
    );
    // Entries without usable input/output costs (context-window-only rows,
    // malformed values) are dropped — a bad community entry must not be fatal.
    if (rate) rates[id] = rate;
  }
  return rates;
}

/** OpenRouter: `{"data":[...]}`, `vendor/model` ids, string per-token prices. */
function parseOpenRouter(body: unknown): Record<string, RawRate> {
  const data = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) throw new Error("unexpected OpenRouter payload");
  const rates: Record<string, RawRate> = {};
  for (const row of data) {
    if (typeof row !== "object" || row === null) continue;
    const { id, pricing } = row as { id?: unknown; pricing?: unknown };
    if (typeof id !== "string" || id.length === 0) continue;
    if (typeof pricing !== "object" || pricing === null) continue;
    const p = pricing as Record<string, unknown>;
    const rate = toRate(p.prompt, p.completion, p.input_cache_read, p.input_cache_write);
    if (rate) rates[id] = rate;
  }
  return rates;
}

// --- fetch -------------------------------------------------------------------

/** One GET-and-parse with a hard timeout and a single retry on 5xx / network failure. */
async function fetchSource(
  url: string,
  parse: (body: unknown) => Record<string, RawRate>,
  fetchImpl: typeof fetch
): Promise<Record<string, RawRate>> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetchImpl(url, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (res.ok) return parse(await res.json());
      lastError = new Error(`HTTP ${res.status}`);
      // 4xx is terminal (moved or removed endpoint) — don't burn a retry.
      if (res.status < 500) break;
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

// --- cache -------------------------------------------------------------------

/** Cache path: alongside the discovery and keyterm caches, on the brain volume. */
export function pricingCachePath(brainPath: string): string {
  return join(brainPath, ".brain-ui", "model-pricing.json");
}

/** Revalidate a stored table entry by entry; malformed entries are dropped. */
function sanitizeTable(raw: unknown): SourceTable | null {
  if (typeof raw !== "object" || raw === null) return null;
  const { fetchedAt, rates } = raw as { fetchedAt?: unknown; rates?: unknown };
  if (typeof rates !== "object" || rates === null) return null;
  const clean: Record<string, RawRate> = {};
  for (const [id, entry] of Object.entries(rates)) {
    const e = (entry ?? {}) as Record<string, unknown>;
    const rate = toRate(e.input, e.output, e.cacheRead, e.cacheWrite);
    if (rate) clean[id] = rate;
  }
  return { fetchedAt: typeof fetchedAt === "number" ? fetchedAt : null, rates: clean };
}

interface RemoteTables {
  fetchedAt: number;
  litellm: SourceTable;
  openrouter: SourceTable;
}

function readCache(path: string): RemoteTables | null {
  try {
    if (!existsSync(path)) return null;
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as PricingCacheFile;
    if (parsed?.version !== CACHE_VERSION || typeof parsed.fetchedAt !== "number") {
      return null;
    }
    const litellm = sanitizeTable(parsed.litellm);
    const openrouter = sanitizeTable(parsed.openrouter);
    if (!litellm || !openrouter) return null;
    return { fetchedAt: parsed.fetchedAt, litellm, openrouter };
  } catch {
    // A corrupt cache is not fatal — the next refresh rewrites it.
    return null;
  }
}

function writeCache(path: string, cache: PricingCacheFile): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(cache, null, 2), "utf-8");
  } catch {
    // A read-only volume costs persistence across restarts, nothing else —
    // the in-memory table keeps serving. (No console here by package rule.)
  }
}

/**
 * The bundled snapshot ships inside the package (`data/` is in `files`).
 * src/pricing/ and dist/pricing/ sit at the same depth, so the relative hop
 * to the package root resolves identically on both resolution paths — the
 * same pattern the migrations dir uses in src/db/client.ts.
 */
function readSnapshot(): Record<string, RawRate> {
  try {
    const path = join(import.meta.dir, "../../data/model-prices.json");
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as PricingCacheFile;
    if (parsed?.version !== CACHE_VERSION) return {};
    const litellm = sanitizeTable(parsed.litellm);
    const openrouter = sanitizeTable(parsed.openrouter);
    return { ...(litellm?.rates ?? {}), ...(openrouter?.rates ?? {}) };
  } catch {
    // A missing snapshot only narrows the fallback to "nothing resolves",
    // which every caller already handles as unknown.
    return {};
  }
}

// --- pricing service ---------------------------------------------------------

export interface ModelPricingOptions {
  /** Brain repo path; the cache lives under its `.brain-ui/` directory. */
  brainPath: string;
  /** How long a fetched table is considered fresh. Default 24h. */
  ttlMs?: number;
  /** Set false to disable pricing entirely (resolve() always null). */
  enabled?: boolean;
  /** @internal Test seam — inject fetch. */
  fetchImpl?: typeof fetch;
  /** @internal Test seam — inject the clock. */
  now?: () => number;
}

export interface ModelPricingState {
  enabled: boolean;
  /** When a refresh last succeeded (either source); null when none ever has. */
  fetchedAt: number | null;
  /** The current table is older than the TTL (or was never fetched). */
  stale: boolean;
  /** What the table is served from: remote data (cache included) or the snapshot. */
  source: "remote" | "snapshot";
  /** Per-source freshness — a partial refresh leaves the failed side behind. */
  litellmFetchedAt: number | null;
  openrouterFetchedAt: number | null;
  /** Last refresh failure, if the current table is served despite one. */
  error?: string;
}

/**
 * A lazily-refreshed model-price table.
 *
 * `resolve()` is synchronous and never touches the network, so the rollup
 * transaction can price a run without blocking on a catalog being reachable.
 * `ensureFresh()` awaits only on a cold start (no remote data at all — the
 * snapshot still serves through the wait) and otherwise refreshes behind the
 * current table.
 */
export interface ModelPricing {
  resolve(modelId: string): PricingRates | null;
  state(): ModelPricingState;
  /** Refresh if stale. Awaits only when no remote data has ever been fetched. */
  ensureFresh(): Promise<void>;
  /** Force a refresh regardless of TTL. Rejects only when BOTH sources fail. */
  refresh(): Promise<void>;
}

export function createModelPricing(options: ModelPricingOptions): ModelPricing {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const enabled = options.enabled ?? true;
  const now = options.now ?? Date.now;
  const fetchImpl = options.fetchImpl ?? fetch;
  const cachePath = pricingCachePath(options.brainPath);

  // Remote data (disk cache or a completed refresh) and the bundled snapshot
  // stay separate: the snapshot serves only while no remote table exists, and
  // its resolutions are flagged estimate — mixing the two would silently
  // launder dated rates as fresh ones.
  let remote: RemoteTables | null = enabled ? readCache(cachePath) : null;
  const snapshot: Record<string, RawRate> = enabled ? readSnapshot() : {};
  let lastError: string | undefined;
  let inFlight: Promise<void> | null = null;

  const isStale = () => remote === null || now() - remote.fetchedAt > ttlMs;

  async function doRefresh(): Promise<void> {
    const [litellm, openrouter] = await Promise.allSettled([
      fetchSource(LITELLM_URL, parseLitellm, fetchImpl),
      fetchSource(OPENROUTER_URL, parseOpenRouter, fetchImpl),
    ]);

    const failures: string[] = [];
    const describe = (reason: unknown) =>
      reason instanceof Error ? reason.message : String(reason);
    if (litellm.status === "rejected") failures.push(`litellm: ${describe(litellm.reason)}`);
    if (openrouter.status === "rejected")
      failures.push(`openrouter: ${describe(openrouter.reason)}`);

    if (litellm.status === "rejected" && openrouter.status === "rejected") {
      // Keep serving whatever we already had; surface the reason.
      lastError = failures.join("; ");
      throw new Error(lastError);
    }

    // Partial refresh is still a refresh: the failed source keeps its last
    // table (empty if it never succeeded) and shows through its fetchedAt
    // plus state().error.
    remote = {
      fetchedAt: now(),
      litellm:
        litellm.status === "fulfilled"
          ? { fetchedAt: now(), rates: litellm.value }
          : (remote?.litellm ?? { fetchedAt: null, rates: {} }),
      openrouter:
        openrouter.status === "fulfilled"
          ? { fetchedAt: now(), rates: openrouter.value }
          : (remote?.openrouter ?? { fetchedAt: null, rates: {} }),
    };
    lastError = failures.length > 0 ? failures.join("; ") : undefined;
    writeCache(cachePath, { version: CACHE_VERSION, ...remote });
  }

  function refresh(): Promise<void> {
    if (!enabled) return Promise.resolve();
    // Single-flight: a burst of requests triggers one fetch pair, not N.
    if (!inFlight) {
      inFlight = doRefresh().finally(() => {
        inFlight = null;
      });
    }
    return inFlight;
  }

  function lookup(id: string): PricingRates | null {
    if (remote) {
      // OpenRouter wins for ids its catalog carries — an openrouter-routed
      // run is billed at OpenRouter's rate, not LiteLLM's idea of it.
      const or = remote.openrouter.rates[id];
      if (or) return { ...or, estimate: false, source: "openrouter" };
      const ll = remote.litellm.rates[id];
      if (ll) return { ...ll, estimate: false, source: "litellm" };
      return null;
    }
    const snap = snapshot[id];
    return snap ? { ...snap, estimate: true, source: "snapshot" } : null;
  }

  const resolveId = (id: string) => lookup(id) ?? lookup(canonicalModelId(id));

  return {
    resolve(modelId: string): PricingRates | null {
      if (!enabled) return null;
      const direct = resolveId(modelId);
      if (direct) return direct;
      // An OpenRouter routing suffix (`:nitro` / `:floor`) is a request-time
      // shortcut with no catalog price of its own — price at the base id's
      // rate, flagged ESTIMATE regardless of source: the routed premium is in
      // no catalog (AE2).
      const variant = modelId.match(/^(.+):(nitro|floor)$/);
      if (variant) {
        const base = resolveId(variant[1]!);
        if (base) return { ...base, estimate: true };
      }
      return null;
    },
    state: () => ({
      enabled,
      fetchedAt: remote?.fetchedAt ?? null,
      stale: enabled ? isStale() : false,
      source: remote ? "remote" : "snapshot",
      litellmFetchedAt: remote?.litellm.fetchedAt ?? null,
      openrouterFetchedAt: remote?.openrouter.fetchedAt ?? null,
      ...(lastError !== undefined ? { error: lastError } : {}),
    }),
    async ensureFresh() {
      if (!enabled || !isStale()) return;
      // Cold start: no remote data yet, so the caller waits (bounded by the
      // request timeout); the snapshot serves anyone who won't. Otherwise
      // refresh in the background.
      if (remote === null) {
        await refresh().catch(() => {});
        return;
      }
      void refresh().catch(() => {});
    },
    refresh,
  };
}
