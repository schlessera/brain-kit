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
//     free, not unknown.
//
// Some ids appear in BOTH at different rates — OpenRouter resells what the
// model vendor also sells directly — so a model id does not identify its own
// price. Which catalog is right for a given run is the run's ROUTE, resolved
// at run start from its inference profile and passed to `resolve()`. Without
// a route (a pre-route run, a proxy the backend cannot classify) OpenRouter
// keeps the precedence it had before routes existed: a rate from the wrong
// side of a collision is still far better than an unpriced run.
//
// Pricing is best-effort by construction: no network, a broken response, or a
// corrupt cache degrades to the last good table (or the snapshot), never to a
// throw. A model the table cannot price resolves to null — the caller renders
// unknown, never zero (the binding fail-loud decision).

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs";
import { dirname, join } from "path";

import { canonicalModelId, type PricingRoute } from "@schlessera/brain-ui-sdk/protocol";

const LITELLM_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
const OPENROUTER_URL = "https://openrouter.ai/api/v1/models";
const REQUEST_TIMEOUT_MS = 10_000;
const CACHE_VERSION = 1;
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
/** Hard cap on a catalog response — both real catalogs are ~2 MB; anything an
 *  order of magnitude past that is a broken or hostile endpoint, not data. */
const MAX_RESPONSE_BYTES = 20 * 1024 * 1024;
/** Plausibility ceiling on a per-token rate: $0.01/token = $10,000 per million
 *  tokens, far past any real price. A rate above it is a corrupt or hostile
 *  entry — once frozen into a rollup it would misreport spend forever. */
const MAX_RATE_PER_TOKEN = 0.01;

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
  /**
   * True when these rates are not what the run was billed at: they came from
   * the bundled snapshot (genuinely dated), from a routing variant's base id,
   * or from the catalog the run did NOT go through (the route's own catalog
   * had no entry for the model).
   */
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

/** A finite, non-negative, plausible price from a float or an OpenRouter
 *  string; else null. The ceiling drops absurd rates at ingest, before they
 *  can freeze into any rollup. */
function asPrice(value: unknown): number | null {
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 && n <= MAX_RATE_PER_TOKEN ? n : null;
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
  // Null-prototype: ids are foreign strings — a "__proto__" entry must be an
  // ordinary key, never a prototype write (same rule for every table below).
  const rates: Record<string, RawRate> = Object.create(null);
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
  const rates: Record<string, RawRate> = Object.create(null);
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
      if (res.ok) {
        // Size-capped read: an unbounded body from a broken or hostile
        // endpoint must not be streamed into memory (and onward to the brain
        // volume). The declared length rejects early; the actual length
        // catches a body without one. Oversize is terminal, not retryable —
        // the caller serves its last good table.
        const declared = Number(res.headers.get("content-length"));
        if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
          lastError = new Error(`response too large (${declared} bytes)`);
          break;
        }
        const text = await res.text();
        if (text.length > MAX_RESPONSE_BYTES) {
          lastError = new Error(`response too large (${text.length} chars)`);
          break;
        }
        return parse(JSON.parse(text));
      }
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
  const clean: Record<string, RawRate> = Object.create(null);
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

/**
 * Atomic cache write: temp file + rename, so a concurrent writer (server and
 * cron wrapper share this file) or a crash mid-write can never leave a torn
 * file behind — the reader sees the old cache or the new one, nothing between.
 * Returns the failure message instead of throwing: a read-only volume costs
 * persistence across restarts, nothing else — the in-memory table keeps
 * serving — but the failure must be observable in state(). (No console here
 * by package rule.)
 */
function writeCache(path: string, cache: PricingCacheFile): string | null {
  const tmp = `${path}.tmp.${process.pid}`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(tmp, JSON.stringify(cache, null, 2), "utf-8");
    renameSync(tmp, path);
    return null;
  } catch (err) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // Best-effort cleanup; the stray temp file is harmless.
    }
    return err instanceof Error ? err.message : String(err);
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
    return Object.assign(
      Object.create(null),
      litellm?.rates ?? {},
      openrouter?.rates ?? {}
    );
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
  /**
   * Rates for one model on one route. `route` picks which catalog is
   * authoritative for the run; omitting it resolves by model id alone, which
   * is what a run whose route is unknown gets.
   */
  resolve(modelId: string, route?: PricingRoute): PricingRates | null;
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
  let lastWriteError: string | undefined;
  let inFlight: Promise<void> | null = null;

  // Staleness keys on the OLDEST source, not the envelope: a partial refresh
  // (one catalog up, one down) must keep retrying the failed side on the
  // normal ensureFresh cadence instead of hiding behind the winner's
  // timestamp for a full TTL — which would also suppress the client's
  // staleness indicator exactly while one source is dark.
  const isStale = () => {
    if (remote === null) return true;
    const oldest = Math.min(
      remote.litellm.fetchedAt ?? 0,
      remote.openrouter.fetchedAt ?? 0
    );
    return now() - oldest > ttlMs;
  };

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
    lastWriteError =
      writeCache(cachePath, { version: CACHE_VERSION, ...remote }) ?? undefined;
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

  /** Own-property read: an id like "toString" must never resolve a prototype
   *  member as phantom rates. */
  function rateFor(table: Record<string, RawRate>, id: string): RawRate | undefined {
    return Object.hasOwn(table, id) ? table[id] : undefined;
  }

  function lookup(id: string, route?: PricingRoute): PricingRates | null {
    if (remote) {
      // The run's route decides which catalog is authoritative for it: an
      // openrouter-routed run is billed at OpenRouter's rate, a direct one at
      // the vendor's. With no route, OpenRouter leads exactly as it did
      // before routes existed, so an unclassified run resolves to the same
      // figure it always did.
      const preferDirect = route === "direct";
      const billed = preferDirect
        ? { rate: rateFor(remote.litellm.rates, id), source: "litellm" as const }
        : { rate: rateFor(remote.openrouter.rates, id), source: "openrouter" as const };
      if (billed.rate) return { ...billed.rate, estimate: false, source: billed.source };

      // The billing catalog has no entry for this id, so the other one's rate
      // serves — coverage must never regress into an unpriced run. But when a
      // route was known, that rate is demonstrably not the one this run was
      // billed at, so it rides as an ESTIMATE. With no route there is nothing
      // to be wrong about and the flag stays off, as before.
      const other = preferDirect
        ? { rate: rateFor(remote.openrouter.rates, id), source: "openrouter" as const }
        : { rate: rateFor(remote.litellm.rates, id), source: "litellm" as const };
      if (other.rate) {
        return { ...other.rate, estimate: route !== undefined, source: other.source };
      }
      return null;
    }
    // The snapshot is stored pre-merged and is dated anyway, so it cannot
    // answer per-route — every snapshot hit is already an estimate.
    const snap = rateFor(snapshot, id);
    return snap ? { ...snap, estimate: true, source: "snapshot" } : null;
  }

  const resolveId = (id: string, route?: PricingRoute) =>
    lookup(id, route) ?? lookup(canonicalModelId(id), route);

  return {
    resolve(modelId: string, route?: PricingRoute): PricingRates | null {
      if (!enabled) return null;
      const exact = resolveId(modelId, route);
      if (exact) return exact;
      // An OpenRouter routing suffix (`:nitro` / `:floor`) is a request-time
      // shortcut with no catalog price of its own — price at the base id's
      // rate, flagged ESTIMATE regardless of source: the routed premium is in
      // no catalog (AE2). The route carries into the base lookup: the premium
      // is unknown either way, but which catalog it sits on top of is not.
      const variant = modelId.match(/^(.+):(nitro|floor)$/);
      if (variant) {
        const base = resolveId(variant[1]!, route);
        if (base) return { ...base, estimate: true };
      }
      return null;
    },
    state: () => {
      // Cache-write failures ride the same error field as fetch failures —
      // both mean "the table you see may not survive a restart / refresh".
      const errors = [
        lastError,
        lastWriteError !== undefined ? `cache write failed: ${lastWriteError}` : undefined,
      ].filter((e): e is string => e !== undefined);
      return {
        enabled,
        fetchedAt: remote?.fetchedAt ?? null,
        stale: enabled ? isStale() : false,
        source: remote ? "remote" : "snapshot",
        litellmFetchedAt: remote?.litellm.fetchedAt ?? null,
        openrouterFetchedAt: remote?.openrouter.fetchedAt ?? null,
        ...(errors.length > 0 ? { error: errors.join("; ") } : {}),
      };
    },
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
