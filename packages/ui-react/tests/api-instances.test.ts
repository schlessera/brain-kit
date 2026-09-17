import { describe, expect, test } from "bun:test";
import { createBrainUiConfig, uiConfig } from "../src/config.js";
import { createBrainApi } from "../src/lib/api-client.js";
import { apiBaseFor, getBackendUrlFor, getWsUrlFor } from "../src/lib/backend.js";

function transport() {
  const calls: { url: string; init?: RequestInit }[] = [];
  return {
    calls,
    request: async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return Response.json({ ok: true, results: [], warnings: [], outcomes: [] });
    },
  };
}

describe("independent UI clients", () => {
  test("config instances never alias each other or the application default", () => {
    const before = { ...uiConfig };
    const a = createBrainUiConfig({ appName: "Odyssey", backendUrl: "https://a.example/" });
    const b = createBrainUiConfig();
    a.assistantName = "Athena";
    b.backendUrl = "https://b.example";
    expect(a.backendUrl).toBe("https://a.example");
    expect(b.appName).toBe("Brain UI");
    expect(b.assistantName).toBe("Brain");
    expect(uiConfig).toEqual(before);
    expect(createBrainUiConfig()).toEqual({ ...b, backendUrl: "" });
  });

  test("interleaved JSON and upload requests stay on their own backend and transport", async () => {
    const a = createBrainUiConfig({ backendUrl: "https://a.example" });
    const b = createBrainUiConfig({ backendUrl: "https://b.example" });
    const ta = transport();
    const tb = transport();
    const ca = createBrainApi(() => apiBaseFor(a), ta.request);
    const cb = createBrainApi(() => apiBaseFor(b), tb.request);
    const cancel = new AbortController();
    await Promise.all([
      ca.brainSearch("sea & shore", { signal: cancel.signal }),
      cb.login("fixture-password"),
      ca.skillInstallZip(new File(["fixture"], "skill.zip"), false),
    ]);

    expect(ta.calls.map((call) => call.url)).toEqual([
      "https://a.example/api/brain/search?q=sea%20%26%20shore",
      "https://a.example/api/skills/install/zip",
    ]);
    expect(tb.calls.map((call) => call.url)).toEqual(["https://b.example/api/auth/login"]);
    expect(ta.calls[0]!.init?.signal).toBe(cancel.signal);
    expect(new Headers(ta.calls[0]!.init?.headers).get("Content-Type")).toBe("application/json");
    expect(tb.calls[0]!.init?.body).toBe(JSON.stringify({ password: "fixture-password" }));
    const upload = ta.calls[1]!.init!;
    expect(upload.body).toBeInstanceOf(FormData);
    expect((upload.body as FormData).get("overwrite")).toBe("false");
    // The browser must add the multipart boundary, including on an instance.
    expect(new Headers(upload.headers).has("Content-Type")).toBe(false);
  });

  test("configuration supplied after construction reaches JSON and multipart calls", async () => {
    const config = createBrainUiConfig();
    const t = transport();
    const client = createBrainApi(() => apiBaseFor(config), t.request);
    await client.health();
    config.backendUrl = "https://late.example";
    await client.health();
    await client.skillInstallZip(new File(["fixture"], "skill.zip"), true);
    expect(t.calls.map((call) => call.url)).toEqual([
      "/api/health",
      "https://late.example/api/health",
      "https://late.example/api/skills/install/zip",
    ]);
  });

  test("a failed or cancelled request cannot affect another client's request", async () => {
    const bad = createBrainApi(() => "/api", async () => Response.json({ error: "Unavailable" }, { status: 503 }));
    const good = createBrainApi(() => "/api", transport().request);
    await expect(bad.health()).rejects.toThrow("Unavailable");
    await expect(good.health()).resolves.toHaveProperty("ok", true);
    const cancel = new AbortController();
    cancel.abort();
    const cancelled = createBrainApi(() => "/api", async (_url, init) => {
      init?.signal?.throwIfAborted();
      return Response.json({});
    });
    await expect(cancelled.brainSearch("test", { signal: cancel.signal })).rejects.toThrow();
    await expect(good.health()).resolves.toHaveProperty("ok", true);
  });
});

describe("root-owned backend URLs", () => {
  test("split topology resolves without browser globals", () => {
    const a = createBrainUiConfig({ backendUrl: "https://a.example/" });
    const b = createBrainUiConfig({ backendUrl: "http://b.example:8080" });
    expect(getWsUrlFor(a)).toBe("wss://a.example/ws");
    expect(getWsUrlFor(b)).toBe("ws://b.example:8080/ws");
    expect(getBackendUrlFor(a, "/api/brain/whatsup")).toBe("https://a.example/api/brain/whatsup");
    b.backendUrl = "https://next.example";
    expect(getWsUrlFor(b)).toBe("wss://next.example/ws");
    expect(getWsUrlFor(a)).toBe("wss://a.example/ws");
  });

  test("same-origin topology derives websocket security and port from the page", () => {
    const config = createBrainUiConfig();
    expect(apiBaseFor(config)).toBe("/api");
    expect(getBackendUrlFor(config, "/api/brain/whatsup")).toBe("/api/brain/whatsup");
    expect(getWsUrlFor(config, { protocol: "https:", host: "ui.example:8443" })).toBe("wss://ui.example:8443/ws");
    expect(getWsUrlFor(config, { protocol: "http:", host: "localhost:3000" })).toBe("ws://localhost:3000/ws");
  });
});
