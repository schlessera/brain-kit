import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import {
  canonicalModelId,
  createModelSource,
  discoverAnthropicModels,
  modelCachePath,
} from "../src/model-discovery";

const ENV_KEYS = ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"] as const;
let savedEnv: Record<string, string | undefined>;
let brainPath: string;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const key of ENV_KEYS) delete process.env[key];
  brainPath = mkdtempSync(join(tmpdir(), `models-${process.pid}-`));
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(brainPath, { recursive: true, force: true });
});

/** A fetch double that answers the list endpoint and per-alias lookups. */
function stubFetch(options: {
  models: Array<{ id: string; display_name?: string; max_input_tokens?: number }>;
  /** Aliases that resolve; every other alias 404s. */
  validAliases?: string[];
  calls?: string[];
}): typeof fetch {
  const valid = new Set(options.validAliases ?? []);
  return (async (input: string | URL | Request) => {
    const url = String(input);
    options.calls?.push(url);
    if (url.includes("/v1/models?")) {
      return new Response(JSON.stringify({ data: options.models, has_more: false }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    const alias = url.split("/v1/models/")[1] ?? "";
    return valid.has(decodeURIComponent(alias))
      ? new Response(JSON.stringify({ id: alias }), { status: 200 })
      : new Response("not found", { status: 404 });
  }) as typeof fetch;
}

describe("canonicalModelId", () => {
  test("strips a dated snapshot suffix", () => {
    expect(canonicalModelId("claude-haiku-4-5-20251001")).toBe("claude-haiku-4-5");
  });

  test("leaves an undated id alone", () => {
    expect(canonicalModelId("claude-opus-5")).toBe("claude-opus-5");
  });
});

describe("discoverAnthropicModels", () => {
  test("returns nothing when the process holds no credential", async () => {
    const result = await discoverAnthropicModels({
      fetchImpl: stubFetch({ models: [{ id: "claude-opus-5" }] }),
    });
    expect(result.models).toEqual([]);
  });

  test("uses the OAuth bearer + beta header for a subscription token", async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-oat01-test";
    let headers: Record<string, string> = {};
    const fetchImpl = (async (_input: unknown, init?: RequestInit) => {
      headers = (init?.headers ?? {}) as Record<string, string>;
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }) as unknown as typeof fetch;

    await discoverAnthropicModels({ fetchImpl });

    expect(headers.authorization).toBe("Bearer sk-ant-oat01-test");
    expect(headers["anthropic-beta"]).toBe("oauth-2025-04-20");
    expect(headers["x-api-key"]).toBeUndefined();
  });

  test("prefers an explicit API key over the subscription token", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-api-test";
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-oat01-test";
    let headers: Record<string, string> = {};
    const fetchImpl = (async (_input: unknown, init?: RequestInit) => {
      headers = (init?.headers ?? {}) as Record<string, string>;
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }) as unknown as typeof fetch;

    await discoverAnthropicModels({ fetchImpl });

    expect(headers["x-api-key"]).toBe("sk-ant-api-test");
    expect(headers.authorization).toBeUndefined();
  });

  test("canonicalizes a dated id to its alias when the alias resolves", async () => {
    process.env.ANTHROPIC_API_KEY = "k";
    const { models, aliasChecks } = await discoverAnthropicModels({
      fetchImpl: stubFetch({
        models: [
          { id: "claude-haiku-4-5-20251001", display_name: "Claude Haiku 4.5", max_input_tokens: 200_000 },
        ],
        validAliases: ["claude-haiku-4-5"],
      }),
    });

    expect(models).toEqual([
      {
        id: "claude-haiku-4-5",
        label: "Claude Haiku 4.5",
        vendor: "anthropic",
        model: "claude-haiku-4-5",
        source: "discovered",
        contextWindow: 200_000,
      },
    ]);
    expect(aliasChecks["claude-haiku-4-5"]).toBe(true);
  });

  test("keeps the dated id when the alias does not resolve", async () => {
    process.env.ANTHROPIC_API_KEY = "k";
    const { models } = await discoverAnthropicModels({
      fetchImpl: stubFetch({
        models: [{ id: "claude-mystery-9-20260101" }],
        validAliases: [],
      }),
    });
    expect(models[0]!.id).toBe("claude-mystery-9-20260101");
  });

  test("does not re-validate an alias already recorded in the cache", async () => {
    process.env.ANTHROPIC_API_KEY = "k";
    const calls: string[] = [];
    await discoverAnthropicModels({
      aliasChecks: { "claude-haiku-4-5": true },
      fetchImpl: stubFetch({
        models: [{ id: "claude-haiku-4-5-20251001" }],
        validAliases: ["claude-haiku-4-5"],
        calls,
      }),
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("/v1/models?");
  });

  test("dedupes an alias and its dated twin, keeping the newest spelling", async () => {
    process.env.ANTHROPIC_API_KEY = "k";
    const { models } = await discoverAnthropicModels({
      fetchImpl: stubFetch({
        models: [
          { id: "claude-opus-5", display_name: "Claude Opus 5" },
          { id: "claude-opus-5-20260601", display_name: "Claude Opus 5 (dated)" },
        ],
        validAliases: ["claude-opus-5"],
      }),
    });
    expect(models.map((m) => m.id)).toEqual(["claude-opus-5"]);
    expect(models[0]!.label).toBe("Claude Opus 5");
  });
});

describe("createModelSource", () => {
  test("list() is empty and offline until a refresh happens", () => {
    const source = createModelSource({ brainPath, fetchImpl: stubFetch({ models: [] }) });
    expect(source.list()).toEqual([]);
    expect(source.state().refreshedAt).toBeNull();
    expect(source.state().stale).toBe(true);
  });

  test("refresh() populates the list and writes the cache", async () => {
    process.env.ANTHROPIC_API_KEY = "k";
    const source = createModelSource({
      brainPath,
      fetchImpl: stubFetch({ models: [{ id: "claude-opus-5", display_name: "Claude Opus 5" }] }),
    });

    await source.refresh();

    expect(source.list().map((m) => m.id)).toEqual(["claude-opus-5"]);
    expect(source.state().stale).toBe(false);
    const cached = JSON.parse(readFileSync(modelCachePath(brainPath), "utf-8"));
    expect(cached.models[0].id).toBe("claude-opus-5");
  });

  test("a fresh cache on disk is served without any network call", () => {
    const path = modelCachePath(brainPath);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        fetchedAt: Date.now(),
        models: [{ id: "cached-model", label: "Cached", model: "cached-model" }],
        aliasChecks: {},
      })
    );

    const source = createModelSource({
      brainPath,
      fetchImpl: (() => {
        throw new Error("must not fetch");
      }) as unknown as typeof fetch,
    });

    expect(source.list().map((m) => m.id)).toEqual(["cached-model"]);
    expect(source.state().stale).toBe(false);
  });

  test("keeps serving the previous list when a refresh fails", async () => {
    process.env.ANTHROPIC_API_KEY = "k";
    let fail = false;
    const fetchImpl = (async (input: string | URL | Request) => {
      if (fail) throw new Error("network down");
      return stubFetch({ models: [{ id: "claude-opus-5" }] })(input);
    }) as typeof fetch;

    const source = createModelSource({ brainPath, fetchImpl });
    await source.refresh();
    fail = true;
    await expect(source.refresh()).rejects.toThrow("network down");

    expect(source.list().map((m) => m.id)).toEqual(["claude-opus-5"]);
    expect(source.state().error).toContain("network down");
  });

  test("concurrent refreshes share one in-flight fetch", async () => {
    process.env.ANTHROPIC_API_KEY = "k";
    const calls: string[] = [];
    const source = createModelSource({
      brainPath,
      fetchImpl: stubFetch({ models: [{ id: "claude-opus-5" }], calls }),
    });

    await Promise.all([source.refresh(), source.refresh(), source.refresh()]);

    expect(calls.filter((url) => url.includes("/v1/models?"))).toHaveLength(1);
  });

  test("ensureFresh() awaits a cold start but returns immediately when stale", async () => {
    process.env.ANTHROPIC_API_KEY = "k";
    let now = 1_000_000;
    const source = createModelSource({
      brainPath,
      ttlMs: 1_000,
      now: () => now,
      fetchImpl: stubFetch({ models: [{ id: "claude-opus-5" }] }),
    });

    // Cold: nothing to serve, so the caller waits and gets a populated list.
    await source.ensureFresh();
    expect(source.list()).toHaveLength(1);

    // Stale: returns without awaiting the refresh, list still served.
    now += 5_000;
    expect(source.state().stale).toBe(true);
    await source.ensureFresh();
    expect(source.list()).toHaveLength(1);
  });

  test("disabled sources never fetch and report themselves disabled", async () => {
    process.env.ANTHROPIC_API_KEY = "k";
    const source = createModelSource({
      brainPath,
      enabled: false,
      fetchImpl: (() => {
        throw new Error("must not fetch");
      }) as unknown as typeof fetch,
    });

    await source.ensureFresh();
    await source.refresh();

    expect(source.list()).toEqual([]);
    expect(source.state().enabled).toBe(false);
    expect(source.state().stale).toBe(false);
  });
});
