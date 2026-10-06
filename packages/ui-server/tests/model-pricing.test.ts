import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { canonicalModelId } from "@schlessera/brain-ui-sdk/internal";
import { createModelPricing, pricingCachePath } from "../src/pricing/model-pricing";
import { resolveServerConfig } from "../src/config/env";

let brainPath: string;

beforeEach(() => {
  brainPath = mkdtempSync(join(tmpdir(), `pricing-${process.pid}-`));
});

afterEach(() => {
  chmodSync(brainPath, 0o755); // undo any read-only test setup before cleanup
  rmSync(brainPath, { recursive: true, force: true });
});

/** Realistic slices of both catalogs, per-token USD. */
const LITELLM_FIXTURE = {
  sample_spec: {
    input_cost_per_token: 0,
    output_cost_per_token: 0,
    litellm_provider: "one of https://docs.litellm.ai/docs/providers",
  },
  "claude-sonnet-4-5": {
    input_cost_per_token: 3e-6,
    output_cost_per_token: 1.5e-5,
    cache_read_input_token_cost: 3e-7,
    cache_creation_input_token_cost: 3.75e-6,
  },
  "gemini/gemini-2.5-pro": {
    input_cost_per_token: 1.25e-6,
    output_cost_per_token: 1e-5,
  },
  // Also carried by the OpenRouter fixture, at a different rate — which of
  // the two wins is the run's ROUTE, not a fixed precedence.
  "z-ai/glm-4.7": {
    input_cost_per_token: 9e-7,
    output_cost_per_token: 9e-6,
  },
  // A real collision, transcribed from both live catalogs on 2026-09-22:
  // DeepSeek's own API is 2.1x cheaper on output than OpenRouter's resale of
  // the same id, and only the direct table carries a cache-read rate.
  "deepseek/deepseek-chat": {
    input_cost_per_token: 2.8e-7,
    output_cost_per_token: 4.2e-7,
    cache_read_input_token_cost: 2.8e-8,
  },
  "context-window-only": { max_input_tokens: 200_000 },
  "malformed-input": { input_cost_per_token: "wat", output_cost_per_token: 1e-6 },
  "negative-rate": { input_cost_per_token: -1e-6, output_cost_per_token: 1e-6 },
  // Past the $0.01/token plausibility ceiling — a wrong or hostile entry that
  // must be dropped at ingest, never frozen into a rollup.
  "absurd-rate": { input_cost_per_token: 0.5, output_cost_per_token: 1e-6 },
  "non-finite-rate": { input_cost_per_token: Infinity, output_cost_per_token: 1e-6 },
};

const OPENROUTER_FIXTURE = {
  data: [
    {
      id: "z-ai/glm-4.7",
      pricing: { prompt: "0.0000006", completion: "0.0000022", input_cache_read: "0.00000011" },
    },
    { id: "deepseek/deepseek-chat", pricing: { prompt: "0.00000032", completion: "0.00000089" } },
    { id: "openai/gpt-oss-120b", pricing: { prompt: "0", completion: "0" } },
    { id: "no-pricing-row" },
    { id: "malformed-row", pricing: { prompt: "free!", completion: "0.000001" } },
  ],
};

/**
 * A fetch double answering both catalog URLs. Per-source `status` values are
 * consumed in order (so a 500-then-200 sequence exercises the retry); the
 * final value repeats.
 */
function stubFetch(options: {
  litellm?: unknown;
  openrouter?: unknown;
  litellmStatus?: number[];
  openrouterStatus?: number[];
  calls?: string[];
}): typeof fetch {
  const pending = {
    litellm: [...(options.litellmStatus ?? [])],
    openrouter: [...(options.openrouterStatus ?? [])],
  };
  return (async (input: string | URL | Request) => {
    const url = String(input);
    options.calls?.push(url);
    const source = url.includes("openrouter") ? "openrouter" : "litellm";
    const queue = pending[source];
    const status = queue.length > 1 ? queue.shift()! : (queue[0] ?? 200);
    if (status !== 200) return new Response("nope", { status });
    const body = source === "openrouter"
      ? (options.openrouter ?? OPENROUTER_FIXTURE)
      : (options.litellm ?? LITELLM_FIXTURE);
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

const failingFetch = (() => {
  throw new Error("network down");
}) as unknown as typeof fetch;

describe("canonicalModelId", () => {
  test("strips a dated snapshot suffix and leaves undated ids alone", () => {
    expect(canonicalModelId("claude-haiku-4-5-20251001")).toBe("claude-haiku-4-5");
    expect(canonicalModelId("claude-opus-5-5")).toBe("claude-opus-5-5");
  });
});

describe("createModelPricing resolution", () => {
  test("resolves LiteLLM float rates including cache rates", async () => {
    const pricing = createModelPricing({ brainPath, fetchImpl: stubFetch({}) });
    await pricing.refresh();

    expect(pricing.resolve("claude-sonnet-4-5")).toEqual({
      input: 3e-6,
      output: 1.5e-5,
      cacheRead: 3e-7,
      cacheWrite: 3.75e-6,
      estimate: false,
      source: "litellm",
    });
  });

  test("resolves OpenRouter string rates as numbers", async () => {
    const pricing = createModelPricing({ brainPath, fetchImpl: stubFetch({}) });
    await pricing.refresh();

    const rates = pricing.resolve("z-ai/glm-4.7");
    expect(rates).toEqual({
      input: 6e-7,
      output: 2.2e-6,
      cacheRead: 1.1e-7,
      cacheWrite: null,
      estimate: false,
      source: "openrouter",
    });
  });

  test("OpenRouter wins for an id both catalogs carry", async () => {
    const pricing = createModelPricing({ brainPath, fetchImpl: stubFetch({}) });
    await pricing.refresh();

    // The LiteLLM fixture prices the same id at 9e-7 — the OpenRouter entry
    // must shadow it.
    expect(pricing.resolve("z-ai/glm-4.7")!.input).toBe(6e-7);
    expect(pricing.resolve("z-ai/glm-4.7")!.source).toBe("openrouter");
  });

  test("a dated Anthropic id resolves via alias canonicalization", async () => {
    const pricing = createModelPricing({ brainPath, fetchImpl: stubFetch({}) });
    await pricing.refresh();

    const rates = pricing.resolve("claude-sonnet-4-5-20250929");
    expect(rates?.input).toBe(3e-6);
    expect(rates?.source).toBe("litellm");
  });

  test("a model in neither source resolves to null", async () => {
    const pricing = createModelPricing({ brainPath, fetchImpl: stubFetch({}) });
    await pricing.refresh();

    expect(pricing.resolve("mystery-model-9000")).toBeNull();
  });

  test("a :nitro/:floor routing variant prices at the base id, flagged estimate (AE2)", async () => {
    const pricing = createModelPricing({ brainPath, fetchImpl: stubFetch({}) });
    await pricing.refresh();

    // The variant has no catalog price of its own — the base id's rates
    // serve, flagged estimate (the routed premium is in no catalog).
    const nitro = pricing.resolve("z-ai/glm-4.7:nitro");
    expect(nitro).toEqual({ ...pricing.resolve("z-ai/glm-4.7")!, estimate: true });
    expect(pricing.resolve("z-ai/glm-4.7:floor")?.estimate).toBe(true);
    // The exact catalog id itself stays non-estimate.
    expect(pricing.resolve("z-ai/glm-4.7")!.estimate).toBe(false);
    // A variant of an unknown base still resolves to null.
    expect(pricing.resolve("mystery-model-9000:nitro")).toBeNull();
  });

  test("missing cache rates come back null, not zero", async () => {
    const pricing = createModelPricing({ brainPath, fetchImpl: stubFetch({}) });
    await pricing.refresh();

    const rates = pricing.resolve("gemini/gemini-2.5-pro");
    expect(rates?.input).toBe(1.25e-6);
    expect(rates?.cacheRead).toBeNull();
    expect(rates?.cacheWrite).toBeNull();
  });

  test('OpenRouter "0" prices are genuinely free, not unknown', async () => {
    const pricing = createModelPricing({ brainPath, fetchImpl: stubFetch({}) });
    await pricing.refresh();

    expect(pricing.resolve("openai/gpt-oss-120b")).toEqual({
      input: 0,
      output: 0,
      cacheRead: null,
      cacheWrite: null,
      estimate: false,
      source: "openrouter",
    });
  });

  test("malformed catalog entries are dropped, never fatal", async () => {
    const pricing = createModelPricing({ brainPath, fetchImpl: stubFetch({}) });
    await pricing.refresh();

    expect(pricing.resolve("sample_spec")).toBeNull();
    expect(pricing.resolve("context-window-only")).toBeNull();
    expect(pricing.resolve("malformed-input")).toBeNull();
    expect(pricing.resolve("negative-rate")).toBeNull();
    expect(pricing.resolve("no-pricing-row")).toBeNull();
    expect(pricing.resolve("malformed-row")).toBeNull();
    // Implausible and non-finite rates are equally dropped — the model
    // resolves unknown instead of freezing an absurd cost.
    expect(pricing.resolve("absurd-rate")).toBeNull();
    expect(pricing.resolve("non-finite-rate")).toBeNull();
  });

  test("a __proto__ catalog entry neither pollutes nor resolves phantom rates", async () => {
    // JSON.parse (like a real fetch body) yields an OWN "__proto__" property,
    // which is exactly what a hostile catalog would deliver.
    const litellm = JSON.parse(
      '{"__proto__": {"input_cost_per_token": 1e-6, "output_cost_per_token": 2e-6},' +
        '"honest-model": {"input_cost_per_token": 1e-6, "output_cost_per_token": 2e-6}}'
    );
    const pricing = createModelPricing({ brainPath, fetchImpl: stubFetch({ litellm }) });
    await pricing.refresh();

    expect(pricing.resolve("honest-model")).not.toBeNull();
    // No prototype pollution anywhere...
    expect(({} as any).input).toBeUndefined();
    expect(({} as any).input_cost_per_token).toBeUndefined();
    // ...and Object.prototype member names never resolve phantom rates.
    for (const id of ["toString", "constructor", "hasOwnProperty", "valueOf"]) {
      expect(pricing.resolve(id)).toBeNull();
    }
  });
});

describe("createModelPricing route-aware resolution", () => {
  /** Both catalogs loaded from the remote tables, no network left to reach. */
  async function priced() {
    const pricing = createModelPricing({ brainPath, fetchImpl: stubFetch({}) });
    await pricing.refresh();
    return pricing;
  }

  test("an id both catalogs carry prices at the route the run actually took", async () => {
    const pricing = await priced();

    // OpenRouter resells this id; DeepSeek's own API is cheaper. Pricing a
    // direct run at the resale rate overstates its output cost by 2.1x.
    expect(pricing.resolve("deepseek/deepseek-chat", "openrouter")).toEqual({
      input: 3.2e-7,
      output: 8.9e-7,
      cacheRead: null,
      cacheWrite: null,
      estimate: false,
      source: "openrouter",
    });
    expect(pricing.resolve("deepseek/deepseek-chat", "direct")).toEqual({
      input: 2.8e-7,
      output: 4.2e-7,
      cacheRead: 2.8e-8,
      cacheWrite: null,
      estimate: false,
      source: "litellm",
    });
  });

  test("an unknown route degrades to the pre-route precedence, not to unpriced", async () => {
    const pricing = await priced();

    // No route: OpenRouter still wins, exactly as before routes existed, and
    // the rates stay unflagged — an absent route is not an estimate.
    expect(pricing.resolve("deepseek/deepseek-chat")).toEqual(
      pricing.resolve("deepseek/deepseek-chat", "openrouter")
    );
    expect(pricing.resolve("z-ai/glm-4.7")!.source).toBe("openrouter");
    // Ids only one catalog carries resolve either way, unflagged.
    expect(pricing.resolve("claude-sonnet-4-5")).toEqual({
      input: 3e-6,
      output: 1.5e-5,
      cacheRead: 3e-7,
      cacheWrite: 3.75e-6,
      estimate: false,
      source: "litellm",
    });
    expect(pricing.resolve("openai/gpt-oss-120b")!.estimate).toBe(false);
  });

  test("a rate from the other catalog still prices the run, flagged estimate", async () => {
    const pricing = await priced();

    // The route's own catalog has no entry, so the other one's rate serves —
    // coverage must not regress into unpriced — but it is not the rate this
    // run was billed at, so it rides as an estimate.
    const direct = pricing.resolve("openai/gpt-oss-120b", "direct");
    expect(direct).toMatchObject({ source: "openrouter", estimate: true, input: 0 });
    const routed = pricing.resolve("claude-sonnet-4-5", "openrouter");
    expect(routed).toMatchObject({ source: "litellm", estimate: true, input: 3e-6 });
  });

  test("a model in neither catalog stays unpriced under every route", async () => {
    const pricing = await priced();

    for (const route of [undefined, "direct", "openrouter"] as const) {
      expect(pricing.resolve("mystery-model-9000", route)).toBeNull();
    }
  });

  test("route survives alias canonicalization and :nitro/:floor variants", async () => {
    const pricing = await priced();

    // A dated id canonicalizes first, then resolves on the route. Asserting
    // the ESTIMATE flag is what makes this bite: claude-sonnet-4-5 lives only
    // in the LiteLLM table, so both routes reach the same rates and only the
    // flag distinguishes them — it is exact for the direct route that table
    // describes, and an estimate for an openrouter run it does not.
    expect(pricing.resolve("claude-sonnet-4-5-20250929", "direct")).toEqual({
      ...pricing.resolve("claude-sonnet-4-5", "direct")!,
      source: "litellm",
      estimate: false,
    });
    expect(pricing.resolve("claude-sonnet-4-5-20250929", "openrouter")).toEqual({
      ...pricing.resolve("claude-sonnet-4-5", "openrouter")!,
      source: "litellm",
      estimate: true,
    });
    // A routing variant prices at the base id's ROUTED rate, still estimate.
    expect(pricing.resolve("deepseek/deepseek-chat:nitro", "direct")).toEqual({
      ...pricing.resolve("deepseek/deepseek-chat", "direct")!,
      estimate: true,
    });
  });

  test("resolution never touches the network, whatever the route", async () => {
    // AE2 guard, at the service boundary: a cached table prices every route
    // with zero fetches, so nothing route-aware can sneak an await into the
    // rollup transaction.
    const calls: string[] = [];
    const warm = createModelPricing({ brainPath, fetchImpl: stubFetch({ calls }) });
    await warm.refresh();
    calls.length = 0;

    const cold = createModelPricing({
      brainPath,
      fetchImpl: stubFetch({ calls }),
      // Far past the TTL: even a stale table must resolve without fetching.
      now: () => Date.now() + 10 * 24 * 60 * 60 * 1000,
    });
    expect(cold.state().stale).toBe(true);
    expect(cold.resolve("deepseek/deepseek-chat", "direct")?.source).toBe("litellm");
    expect(cold.resolve("deepseek/deepseek-chat", "openrouter")?.source).toBe("openrouter");
    expect(calls).toEqual([]);
  });
});

describe("createModelPricing snapshot fallback", () => {
  test("AE4: no cache + fetch failing → the bundled snapshot serves, flagged estimate", async () => {
    const pricing = createModelPricing({ brainPath, fetchImpl: failingFetch });
    await pricing.ensureFresh();

    const rates = pricing.resolve("claude-opus-4-6");
    expect(rates).not.toBeNull();
    expect(rates!.estimate).toBe(true);
    expect(rates!.source).toBe("snapshot");
    // OpenRouter-section snapshot entries resolve the same way.
    expect(pricing.resolve("z-ai/glm-4.7")?.source).toBe("snapshot");
    // A routing variant of a snapshot-priced base stays an estimate.
    expect(pricing.resolve("z-ai/glm-4.7:nitro")?.estimate).toBe(true);

    const state = pricing.state();
    expect(state.source).toBe("snapshot");
    expect(state.fetchedAt).toBeNull();
    expect(state.stale).toBe(true);
    expect(state.error).toContain("network down");
  });

  test("a corrupt cache file is discarded silently and rewritten by a refresh", async () => {
    const path = pricingCachePath(brainPath);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "{ not json");

    const pricing = createModelPricing({ brainPath, fetchImpl: stubFetch({}) });
    // Discarded, so the snapshot serves until a refresh lands.
    expect(pricing.state().source).toBe("snapshot");
    expect(pricing.resolve("claude-opus-4-6")?.estimate).toBe(true);

    await pricing.refresh();
    expect(pricing.state().source).toBe("remote");
    const rewritten = JSON.parse(readFileSync(path, "utf-8"));
    expect(rewritten.version).toBe(1);
    expect(rewritten.litellm.rates["claude-sonnet-4-5"].input).toBe(3e-6);
  });

  test("a fresh cache on disk is served without any network call", async () => {
    const seeded = createModelPricing({ brainPath, fetchImpl: stubFetch({}) });
    await seeded.refresh();

    const pricing = createModelPricing({ brainPath, fetchImpl: failingFetch });
    expect(pricing.state().source).toBe("remote");
    expect(pricing.state().stale).toBe(false);
    expect(pricing.resolve("claude-sonnet-4-5")?.estimate).toBe(false);
    await pricing.ensureFresh(); // fresh — must not fetch (fetchImpl would throw)
  });
});

describe("createModelPricing refresh behavior", () => {
  test("one source 500ing keeps the other's data and surfaces the failure", async () => {
    const pricing = createModelPricing({
      brainPath,
      fetchImpl: stubFetch({ litellmStatus: [500, 500] }),
    });
    await pricing.refresh(); // partial refresh is still a refresh — no throw

    expect(pricing.resolve("z-ai/glm-4.7")?.source).toBe("openrouter");
    expect(pricing.resolve("claude-sonnet-4-5")).toBeNull();

    const state = pricing.state();
    expect(state.source).toBe("remote");
    // Staleness keys on the OLDEST source: with litellm still dark the table
    // counts as stale, so ensureFresh keeps retrying the failed side (and
    // the client's staleness indicator can fire) instead of hiding behind
    // the winner's timestamp for a full TTL.
    expect(state.stale).toBe(true);
    expect(state.error).toContain("litellm");
    expect(state.litellmFetchedAt).toBeNull();
    expect(state.openrouterFetchedAt).not.toBeNull();
  });

  test("a failed refresh keeps serving the last good table", async () => {
    let fail = false;
    const inner = stubFetch({});
    const fetchImpl = (async (input: string | URL | Request) => {
      if (fail) throw new Error("network down");
      return inner(input);
    }) as typeof fetch;

    const pricing = createModelPricing({ brainPath, fetchImpl });
    await pricing.refresh();
    fail = true;
    await expect(pricing.refresh()).rejects.toThrow("network down");

    expect(pricing.resolve("claude-sonnet-4-5")?.input).toBe(3e-6);
    expect(pricing.state().error).toContain("network down");
    expect(pricing.state().source).toBe("remote");
  });

  test("a 5xx is retried once per source before counting as a failure", async () => {
    const calls: string[] = [];
    const pricing = createModelPricing({
      brainPath,
      fetchImpl: stubFetch({ litellmStatus: [500, 200], calls }),
    });
    await pricing.refresh();

    expect(pricing.resolve("claude-sonnet-4-5")).not.toBeNull();
    expect(pricing.state().error).toBeUndefined();
    expect(calls.filter((url) => !url.includes("openrouter"))).toHaveLength(2);
  });

  test("concurrent ensureFresh bursts share one in-flight fetch pair", async () => {
    const calls: string[] = [];
    const pricing = createModelPricing({ brainPath, fetchImpl: stubFetch({ calls }) });

    await Promise.all([pricing.ensureFresh(), pricing.ensureFresh(), pricing.ensureFresh()]);

    expect(calls).toHaveLength(2); // one per source, not per caller
    expect(pricing.resolve("claude-sonnet-4-5")).not.toBeNull();
  });

  test("ensureFresh awaits a cold start but returns immediately when stale", async () => {
    let now = 1_000_000;
    const pricing = createModelPricing({
      brainPath,
      ttlMs: 1_000,
      now: () => now,
      fetchImpl: stubFetch({}),
    });

    // Cold: the caller waits and gets remote data.
    await pricing.ensureFresh();
    expect(pricing.state().source).toBe("remote");

    // Stale: returns without awaiting, table still served.
    now += 5_000;
    expect(pricing.state().stale).toBe(true);
    await pricing.ensureFresh();
    expect(pricing.resolve("claude-sonnet-4-5")).not.toBeNull();
  });

  test("an oversized catalog body is rejected; the last good table keeps serving", async () => {
    let oversized = false;
    const inner = stubFetch({});
    const huge = "x".repeat(20 * 1024 * 1024 + 1);
    const fetchImpl = (async (input: string | URL | Request) => {
      if (!oversized) return inner(input);
      return new Response(huge, { status: 200 });
    }) as typeof fetch;

    const pricing = createModelPricing({ brainPath, fetchImpl });
    await pricing.refresh();
    oversized = true;
    await expect(pricing.refresh()).rejects.toThrow("response too large");

    // Stale-but-good data still serves, and the failure is visible.
    expect(pricing.resolve("claude-sonnet-4-5")?.input).toBe(3e-6);
    expect(pricing.state().source).toBe("remote");
    expect(pricing.state().error).toContain("too large");
  });

  test("a declared Content-Length past the cap is rejected before the body is read", async () => {
    const fetchImpl = (async () => {
      // The body itself is tiny — only the declared length is hostile. text()
      // throwing here would mean the body was read despite the declaration.
      const res = new Response("{}", { status: 200 });
      res.headers.set("content-length", String(30 * 1024 * 1024));
      res.text = () => {
        throw new Error("body must not be read");
      };
      return res;
    }) as unknown as typeof fetch;

    const pricing = createModelPricing({ brainPath, fetchImpl });
    await expect(pricing.refresh()).rejects.toThrow("response too large");
    expect(pricing.state().source).toBe("snapshot"); // degraded, not crashed
  });

  test("the cache is written atomically — no temp file survives a refresh", async () => {
    const pricing = createModelPricing({ brainPath, fetchImpl: stubFetch({}) });
    await pricing.refresh();

    const dir = dirname(pricingCachePath(brainPath));
    expect(readdirSync(dir)).toEqual(["model-pricing.json"]);
    expect(pricing.state().error).toBeUndefined();
  });

  test("a cache-write failure keeps serving and surfaces in state().error", async () => {
    chmodSync(brainPath, 0o555); // .brain-ui/ cannot be created
    const pricing = createModelPricing({ brainPath, fetchImpl: stubFetch({}) });
    await pricing.refresh(); // the refresh itself succeeds

    expect(pricing.resolve("claude-sonnet-4-5")?.input).toBe(3e-6);
    expect(pricing.state().source).toBe("remote");
    expect(pricing.state().error).toContain("cache write failed");

    // A later successful write clears the error.
    chmodSync(brainPath, 0o755);
    await pricing.refresh();
    expect(pricing.state().error).toBeUndefined();
  });

  test("kill switch: resolve() is always null and state says disabled", async () => {
    const pricing = createModelPricing({
      brainPath,
      enabled: false,
      fetchImpl: failingFetch, // would throw on any fetch attempt
    });

    await pricing.ensureFresh();
    await pricing.refresh();

    expect(pricing.resolve("claude-opus-4-6")).toBeNull(); // not even the snapshot
    expect(pricing.state().enabled).toBe(false);
    expect(pricing.state().stale).toBe(false);
  });
});

describe("config/env pricing group", () => {
  test("pricing discovery: on by default, off under a test runner, falsy disables", () => {
    expect(resolveServerConfig({}).pricing.enabled).toBe(true);
    expect(resolveServerConfig({ NODE_ENV: "test" }).pricing.enabled).toBe(false);
    expect(resolveServerConfig({ BRAIN_UI_PRICING_DISCOVERY: "off" }).pricing.enabled).toBe(false);
    expect(
      resolveServerConfig({ BRAIN_UI_PRICING_DISCOVERY: "1", NODE_ENV: "test" }).pricing.enabled
    ).toBe(true);
  });

  test("pricing TTL: hours to ms, garbage degrades to the 24h default", () => {
    expect(resolveServerConfig({ BRAIN_UI_PRICING_TTL_HOURS: "6" }).pricing.ttlMs).toBe(
      6 * 60 * 60 * 1000
    );
    for (const v of [undefined, "", "banana", "-3", "0"]) {
      expect(resolveServerConfig({ BRAIN_UI_PRICING_TTL_HOURS: v }).pricing.ttlMs).toBe(
        24 * 60 * 60 * 1000
      );
    }
  });
});
