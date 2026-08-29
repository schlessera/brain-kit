import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createWebSearchRoutes } from "../src/routes/web-search";
import { resolvePiConfigDir, resolveServerConfig } from "../src/config/env";

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

function appFor(env: Record<string, string> = {}, configPath?: string) {
  return createWebSearchRoutes({
    agent: agentFor(env),
    ...(configPath ? { configPath } : {}),
    // Deterministic stand-in for the lazily-loaded pi module (cache clearing).
    importer: async () => ({ invalidateExtensionCache: async () => true }),
  });
}

describe("pi config dir resolution", () => {
  test("mirrors the extension's precedence", () => {
    expect(resolvePiConfigDir({ PI_CODING_AGENT_DIR: "/x/agent" })).toBe("/x/agent");
    expect(resolvePiConfigDir({ XDG_CONFIG_HOME: "/x/cfg" })).toBe("/x/cfg/pi");
    expect(resolvePiConfigDir({ HOME: "/home/u" })).toBe("/home/u/.pi");
    expect(resolvePiConfigDir({})).toBe("/root/.pi");
  });
});

describe("GET /web-search", () => {
  test("reports not-configured when pi is not in play", async () => {
    const res = await appFor().request("/web-search");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { configured: boolean; providers: unknown[] };
    expect(body.configured).toBe(false);
    expect(body.providers).toHaveLength(0);
  });

  test("defaults to auto with exa marked keyless, no key values anywhere", async () => {
    const path = tempConfigPath();
    writeFileSync(path, JSON.stringify({ exaApiKey: "exa-secret-123" }), "utf-8");
    const res = await appFor({ BRAIN_UI_PI_PROFILES: PROFILES }, path).request("/web-search");
    expect(res.status).toBe(200);
    const text = await res.text();
    // The stored key VALUE must never travel.
    expect(text).not.toContain("exa-secret-123");
    const body = JSON.parse(text) as {
      configured: boolean;
      provider: string;
      providers: Array<{ id: string; keyless: boolean; keyConfigured: boolean }>;
    };
    expect(body.configured).toBe(true);
    expect(body.provider).toBe("auto");
    const exa = body.providers.find((p) => p.id === "exa")!;
    expect(exa.keyless).toBe(true);
    expect(exa.keyConfigured).toBe(true);
    expect(body.providers.find((p) => p.id === "auto")!.keyless).toBe(true);
  });
});

describe("PUT /web-search", () => {
  test("rejected when pi is not configured", async () => {
    const res = await appFor().request("/web-search", {
      method: "PUT",
      body: JSON.stringify({ provider: "exa" }),
    });
    expect(res.status).toBe(409);
  });

  test("sets a provider and stores a key; auto resets to absence", async () => {
    const path = tempConfigPath();
    const app = appFor({ BRAIN_UI_PI_PROFILES: PROFILES }, path);

    let res = await app.request("/web-search", {
      method: "PUT",
      body: JSON.stringify({ provider: "exa", apiKeys: { exa: "  exa-key-1  " } }),
    });
    expect(res.status).toBe(200);
    let body = (await res.json()) as { provider: string };
    expect(body.provider).toBe("exa");
    let stored = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
    expect(stored.provider).toBe("exa");
    expect(stored.exaApiKey).toBe("exa-key-1"); // trimmed

    res = await app.request("/web-search", {
      method: "PUT",
      body: JSON.stringify({ provider: "auto" }),
    });
    expect(res.status).toBe(200);
    body = (await res.json()) as { provider: string };
    expect(body.provider).toBe("auto");
    stored = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
    // auto is stored as ABSENCE; the key survives the provider switch.
    expect("provider" in stored).toBe(false);
    expect(stored.exaApiKey).toBe("exa-key-1");
  });

  test("null clears a key", async () => {
    const path = tempConfigPath();
    writeFileSync(path, JSON.stringify({ exaApiKey: "old" }), "utf-8");
    const app = appFor({ BRAIN_UI_PI_PROFILES: PROFILES }, path);
    const res = await app.request("/web-search", {
      method: "PUT",
      body: JSON.stringify({ apiKeys: { exa: null } }),
    });
    expect(res.status).toBe(200);
    const stored = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
    expect("exaApiKey" in stored).toBe(false);
  });

  test("preserves unmanaged hand-edited config", async () => {
    const path = tempConfigPath();
    writeFileSync(
      path,
      JSON.stringify({ searchRouting: { providers: ["openai"] }, ssrf: { trustEnvProxy: true } }),
      "utf-8"
    );
    const app = appFor({ BRAIN_UI_PI_PROFILES: PROFILES }, path);
    const res = await app.request("/web-search", {
      method: "PUT",
      body: JSON.stringify({ provider: "brave", apiKeys: { brave: "b-key" } }),
    });
    expect(res.status).toBe(200);
    const stored = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
    expect(stored.searchRouting).toEqual({ providers: ["openai"] });
    expect(stored.ssrf).toEqual({ trustEnvProxy: true });
    expect(stored.braveApiKey).toBe("b-key");
  });

  test("rejects unknown providers, bad keys, and keys for auto", async () => {
    const path = tempConfigPath();
    const app = appFor({ BRAIN_UI_PI_PROFILES: PROFILES }, path);
    const cases: Array<Record<string, unknown>> = [
      { provider: "duckduckgo-typo" },
      { apiKeys: { auto: "x" } },
      { apiKeys: { unknown: "x" } },
      { apiKeys: { exa: "with\nnewline" } },
      { apiKeys: { exa: 42 } },
      { apiKeys: ["not-an-object"] },
    ];
    for (const body of cases) {
      const res = await app.request("/web-search", {
        method: "PUT",
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(400);
    }
  });

  test("refuses to clobber a corrupt config file", async () => {
    const path = tempConfigPath();
    writeFileSync(path, "{ not json", "utf-8");
    const app = appFor({ BRAIN_UI_PI_PROFILES: PROFILES }, path);
    const res = await app.request("/web-search", {
      method: "PUT",
      body: JSON.stringify({ provider: "exa" }),
    });
    expect(res.status).toBe(409);
    expect(readFileSync(path, "utf-8")).toBe("{ not json");
  });
});
