import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createWebSearchRoutes } from "../src/routes/web-search";
import { resolveServerConfig } from "../src/config/env";

const PROFILES = JSON.stringify([
  { id: "gpt-sol", label: "GPT-5.6 Sol", vendor: "openai-codex", model: "gpt-5.6-sol" },
]);

const agentFor = (env: Record<string, string> = {}) =>
  resolveServerConfig({ NODE_ENV: "test", ...env }).agent;

const dirs: string[] = [];
function tempConfigPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "web-search-test-"));
  dirs.push(dir);
  return join(dir, "web-search.json");
}
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

/** An env with no provider keys, so the credential check is deterministic. */
const CLEAN_ENV: Record<string, string | undefined> = {};

function appFor(
  env: Record<string, string> = {},
  configPath?: string,
  processEnv: Record<string, string | undefined> = CLEAN_ENV
) {
  return createWebSearchRoutes({
    agent: agentFor(env),
    ...(configPath ? { configPath } : {}),
    env: processEnv,
    // Deterministic stand-in for the lazily-loaded pi module (cache clearing).
    importer: async () => ({
      backendModule: {
        id: "pi",
        settingsHooks: {},
        profileSchema: {
          source: "BRAIN_UI_PI_PROFILES",
          parse(raw: string | null) {
            return { ok: true, profiles: raw ? JSON.parse(raw) : [] } as const;
          },
        },
        resolveFromEnv() {
          throw new Error("not used by route tests");
        },
      },
      invalidateExtensionCache: async () => true,
    }),
  });
}

const piApp = (path: string, processEnv?: Record<string, string | undefined>) =>
  appFor({ BRAIN_UI_PI_PROFILES: PROFILES }, path, processEnv);

const stored = (path: string) =>
  JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;

type ProviderView = {
  id: string;
  enabled: boolean;
  keyless: boolean;
  keyConfigured: boolean;
  keyFromEnv: boolean;
  hasKeyField: boolean;
};
type ConfigView = {
  configured: boolean;
  order: string[];
  overriddenBy: string | null;
  appliesTo: string[];
  providers: ProviderView[];
};

async function get(app: ReturnType<typeof appFor>): Promise<ConfigView> {
  const res = await app.request("/web-search");
  expect(res.status).toBe(200);
  return (await res.json()) as ConfigView;
}

async function put(
  app: ReturnType<typeof appFor>,
  body: Record<string, unknown>
): Promise<Response> {
  return app.request("/web-search", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("GET /web-search", () => {
  test("reports not-configured when pi is not in play", async () => {
    const body = await get(appFor());
    expect(body.configured).toBe(false);
    expect(body.providers).toHaveLength(0);
    expect(body.order).toEqual([]);
  });

  test("no config means an empty chain, with exa keyless", async () => {
    const body = await get(piApp(tempConfigPath()));
    expect(body.configured).toBe(true);
    expect(body.order).toEqual([]);
    expect(body.overriddenBy).toBeNull();
    expect(body.providers.every((p) => !p.enabled)).toBe(true);
    expect(body.providers.find((p) => p.id === "exa")!.keyless).toBe(true);
    expect(body.providers.find((p) => p.id === "perplexity")!.keyless).toBe(false);
    // DuckDuckGo is keyless AND takes no key field at all.
    const ddg = body.providers.find((p) => p.id === "duckduckgo")!;
    expect(ddg.keyless).toBe(true);
    expect(ddg.hasKeyField).toBe(false);
  });

  test("never returns a stored key value", async () => {
    const path = tempConfigPath();
    writeFileSync(path, JSON.stringify({ exaApiKey: "exa-secret-123" }), "utf-8");
    const res = await piApp(path).request("/web-search");
    const text = await res.text();
    expect(text).not.toContain("exa-secret-123");
    const body = JSON.parse(text) as ConfigView;
    expect(body.providers.find((p) => p.id === "exa")!.keyConfigured).toBe(true);
  });

  test("reports a key supplied by the environment separately from a stored one", async () => {
    const body = await get(piApp(tempConfigPath(), { PERPLEXITY_API_KEY: "from-env" }));
    const pplx = body.providers.find((p) => p.id === "perplexity")!;
    expect(pplx.keyFromEnv).toBe(true);
    expect(pplx.keyConfigured).toBe(false);
  });

  test("reads an existing chain back, cheapest first", async () => {
    const path = tempConfigPath();
    writeFileSync(
      path,
      JSON.stringify({ searchRouting: { providers: ["perplexity", "exa"] } }),
      "utf-8"
    );
    const body = await get(piApp(path));
    expect(body.order).toEqual(["exa", "perplexity"]);
    expect(body.providers.find((p) => p.id === "exa")!.enabled).toBe(true);
    expect(body.providers.find((p) => p.id === "brave")!.enabled).toBe(false);
  });

  test("names the pi models these providers reach", async () => {
    // The card is shown whenever pi is configured, but Claude models sit in
    // the same picker and ignore all of this — so the view has to say which
    // models the toggles actually reach.
    const body = await get(piApp(tempConfigPath()));
    expect(body.appliesTo).toEqual(["GPT-5.6 Sol"]);
  });

  test("surfaces a single-provider selection as an override", async () => {
    const path = tempConfigPath();
    // The extension ignores searchRouting entirely while `provider` is set —
    // reporting the chain as live would be a lie.
    writeFileSync(
      path,
      JSON.stringify({ provider: "brave", searchRouting: { providers: ["exa"] } }),
      "utf-8"
    );
    const body = await get(piApp(path));
    expect(body.overriddenBy).toBe("brave");
  });
});

describe("PUT /web-search", () => {
  test("rejected when pi is not configured", async () => {
    const res = await put(appFor(), { enabled: { exa: true } });
    expect(res.status).toBe(409);
  });

  test("enabling a keyless provider writes a routing chain with fallbacks", async () => {
    const path = tempConfigPath();
    const res = await put(piApp(path), { enabled: { exa: true } });
    expect(res.status).toBe(200);
    expect((await res.json()).order).toEqual(["exa"]);
    const routing = stored(path).searchRouting as Record<string, unknown>;
    expect(routing.providers).toEqual(["exa"]);
    // Every failure kind must fall through, or the chain stops at the first
    // provider that cannot answer.
    expect(routing.fallbackOn).toEqual([
      "transient",
      "quota",
      "network",
      "invalid-response",
      "unsupported",
    ]);
  });

  test("refuses to enable a provider with no credential", async () => {
    const path = tempConfigPath();
    const res = await put(piApp(path), { enabled: { perplexity: true } });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("API key");
    // Nothing was written at all, so the chain cannot contain a dead entry.
    expect(existsSync(path)).toBe(false);
  });

  test("a key in the same request enables the provider", async () => {
    const path = tempConfigPath();
    const res = await put(piApp(path), {
      enabled: { perplexity: true },
      apiKeys: { perplexity: "  pplx-key  " },
    });
    expect(res.status).toBe(200);
    expect(stored(path).perplexityApiKey).toBe("pplx-key"); // trimmed
    expect((stored(path).searchRouting as Record<string, unknown>).providers).toEqual([
      "perplexity",
    ]);
  });

  test("a key from the environment is credential enough", async () => {
    const path = tempConfigPath();
    const res = await put(piApp(path, { PERPLEXITY_API_KEY: "env-key" }), {
      enabled: { perplexity: true },
    });
    expect(res.status).toBe(200);
    // The env key is NOT copied into the file.
    expect("perplexityApiKey" in stored(path)).toBe(false);
  });

  test("orders the chain cheapest-first regardless of enable order", async () => {
    const path = tempConfigPath();
    const app = piApp(path);
    await put(app, { enabled: { kagi: true }, apiKeys: { kagi: "k" } });
    await put(app, { enabled: { perplexity: true }, apiKeys: { perplexity: "p" } });
    const res = await put(app, { enabled: { exa: true } });
    expect((await res.json()).order).toEqual(["exa", "perplexity", "kagi"]);
  });

  test("writing the chain removes any single-provider override", async () => {
    const path = tempConfigPath();
    writeFileSync(path, JSON.stringify({ provider: "brave", searchProvider: "brave" }), "utf-8");
    const res = await put(piApp(path), { enabled: { exa: true } });
    expect(res.status).toBe(200);
    expect((await res.json()).overriddenBy).toBeNull();
    expect("provider" in stored(path)).toBe(false);
    expect("searchProvider" in stored(path)).toBe(false);
  });

  test("clearOverride drops the pinned provider on its own", async () => {
    const path = tempConfigPath();
    writeFileSync(
      path,
      JSON.stringify({ provider: "brave", searchRouting: { providers: ["exa"] } }),
      "utf-8"
    );
    const res = await put(piApp(path), { clearOverride: true });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ConfigView;
    expect(body.overriddenBy).toBeNull();
    expect(body.order).toEqual(["exa"]);
    expect((stored(path).searchRouting as Record<string, unknown>).providers).toEqual(["exa"]);
  });

  test("a pre-toggle single provider carries into the first chain written", async () => {
    const path = tempConfigPath();
    writeFileSync(path, JSON.stringify({ provider: "brave", braveApiKey: "b" }), "utf-8");
    const res = await put(piApp(path), {
      enabled: { perplexity: true },
      apiKeys: { perplexity: "p" },
    });
    expect(res.status).toBe(200);
    // Upgrading must not silently drop the provider the deployment was using.
    expect((await res.json()).order).toEqual(["brave", "perplexity"]);
  });

  test("disabling the last provider hands the choice back to the extension", async () => {
    const path = tempConfigPath();
    const app = piApp(path);
    await put(app, { enabled: { exa: true } });
    const res = await put(app, { enabled: { exa: false } });
    expect(res.status).toBe(200);
    expect((await res.json()).order).toEqual([]);
    // Absence, not an empty (invalid) providers array.
    expect("searchRouting" in stored(path)).toBe(false);
  });

  test("null clears a key", async () => {
    const path = tempConfigPath();
    writeFileSync(path, JSON.stringify({ exaApiKey: "old" }), "utf-8");
    const res = await put(piApp(path), { apiKeys: { exa: null } });
    expect(res.status).toBe(200);
    expect("exaApiKey" in stored(path)).toBe(false);
  });

  test("preserves unmanaged config, including other searchRouting fields", async () => {
    const path = tempConfigPath();
    writeFileSync(
      path,
      JSON.stringify({
        searchRouting: { providers: ["openai"], useCurrentModel: true },
        ssrf: { trustEnvProxy: true },
      }),
      "utf-8"
    );
    const res = await put(piApp(path), { enabled: { exa: true } });
    expect(res.status).toBe(200);
    const routing = stored(path).searchRouting as Record<string, unknown>;
    // A hand-written entry is left alone even without a credential here — the
    // credential gate stops the UI from ADDING a dead entry, it does not prune
    // someone's own config behind their back on an unrelated save. It shows as
    // enabled-but-keyless in the UI, where it can be switched off deliberately.
    expect(routing.providers).toEqual(["exa", "openai"]);
    expect(routing.useCurrentModel).toBe(true);
    expect(stored(path).ssrf).toEqual({ trustEnvProxy: true });
  });

  test("rejects unknown providers, non-boolean toggles, and bad keys", async () => {
    const path = tempConfigPath();
    const app = piApp(path);
    const cases: Array<Record<string, unknown>> = [
      { enabled: { "duckduckgo-typo": true } },
      { enabled: { exa: "yes" } },
      { enabled: ["not-an-object"] },
      { apiKeys: { duckduckgo: "x" } },
      { apiKeys: { unknown: "x" } },
      { apiKeys: { exa: "with\nnewline" } },
      { apiKeys: { exa: 42 } },
      { apiKeys: ["not-an-object"] },
    ];
    for (const body of cases) {
      const res = await put(app, body);
      expect(res.status).toBe(400);
    }
  });

  test("refuses to clobber a corrupt config file", async () => {
    const path = tempConfigPath();
    writeFileSync(path, "{ not json", "utf-8");
    const res = await put(piApp(path), { enabled: { exa: true } });
    expect(res.status).toBe(409);
    expect(readFileSync(path, "utf-8")).toBe("{ not json");
  });
});
