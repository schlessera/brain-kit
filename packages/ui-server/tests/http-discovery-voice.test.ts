import { expect, spyOn, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ProviderInfo } from "@schlessera/brain-ui-sdk";
import type { BackendModelSource, BackendModelSourceState } from "@schlessera/brain-ui-sdk/server";
import { createStaticBackendRegistry } from "../src/agent/backend";
import { makeFakeBackend } from "./helpers/fake-backend";
import { httpContractApp } from "./helpers/http-contract-app";

test("mounted model refresh updates the roster and keeps the last nonempty roster on discovery failure", async () => {
  let profiles: ProviderInfo[] = [{ id: "fixture", label: "Fixture model" }];
  let state: BackendModelSourceState = { enabled: true, stale: false, refreshedAt: 1 };
  let fail = false, refreshes = 0, reads = 0;
  const backend = makeFakeBackend({ id: "fixture" });
  backend.listProfiles = () => profiles;
  const source: BackendModelSource = {
    list: () => profiles,
    state: () => state,
    ensureFresh: async () => { reads++; },
    refresh: async () => {
      refreshes++;
      if (fail) { state = { ...state, stale: true, error: "Fixture discovery unavailable" }; throw new Error(state.error); }
      profiles = [...profiles, { id: "discovered-fixture", label: "Discovered fixture" }];
      state = { enabled: true, stale: false, refreshedAt: 2 };
    },
  };
  const registry = createStaticBackendRegistry([backend], "fixture", { modelSource: source });
  const t = await httpContractApp({ registry });
  try {
    const initial = await (await t.fetch("/api/models")).json();
    expect(initial.models.map((m: ProviderInfo) => m.id)).toEqual(["fixture"]);
    expect(reads).toBe(1);
    const refreshed = await t.fetch("/api/models/refresh", { method: "POST", body: "ignored input" });
    expect(refreshed.status).toBe(200);
    const updated = await refreshed.json();
    expect(updated.models.map((m: ProviderInfo) => m.id)).toEqual(["fixture", "discovered-fixture"]);
    expect(updated.refreshedAt).toBe(2);
    expect(updated.discovery.enabled).toBe(true);
    fail = true;
    const unavailable = await t.fetch("/api/models/refresh", { method: "POST" });
    expect(unavailable.status).toBe(200);
    const previous = await unavailable.json();
    expect(previous.models).toEqual(updated.models);
    expect(previous.stale).toBe(true);
    expect(previous.discovery.error).toBe("Fixture discovery unavailable");
    expect(refreshes).toBe(2);
    backend.listProfiles = () => { throw new Error("Fixture registry failure"); };
    registry.invalidateProfiles();
    const failures = spyOn(console, "error").mockImplementation(() => {});
    try {
      for (const path of ["/api/providers", "/api/models"]) {
        const response = await t.fetch(path);
        expect(response.status).toBe(500);
        expect(await response.text()).toBe("Internal Server Error");
      }
      expect(failures).toHaveBeenCalledTimes(2);
    } finally { failures.mockRestore(); }
  } finally { await t.close(); }
});

test("mounted voice session and legacy token use only short-lived injected grants and preserve failures", async () => {
  const t = await httpContractApp({ env: { VOICE_PROVIDER: "deepgram", DEEPGRAM_API_KEY: "fixture-only-deepgram-key" } });
  const calls: Array<{ url: string; authorization: string | null; body: unknown }> = [];
  let refuse = false;
  const transport: typeof fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = String(input);
    if (url !== "https://api.deepgram.com/v1/auth/grant") throw new Error("Unexpected network attempt in voice fixture");
    calls.push({ url, authorization: new Headers(init?.headers).get("authorization"), body: JSON.parse(String(init?.body)) });
    return refuse ? new Response("Fixture grant refusal", { status: 403 }) : Response.json({ access_token: "fixture-short-lived-token", expires_in: 60 });
  }, { preconnect: fetch.preconnect });
  mkdirSync(t.app.config.voice.cacheDir, { recursive: true });
  writeFileSync(join(t.app.config.voice.cacheDir, "keyterms.json"), JSON.stringify({ version: 2, generatedAt: Date.now(), keyterms: ["Odysseus"], count: 1, overrides: [] }));
  const mock = spyOn(globalThis, "fetch").mockImplementation(transport);
  try {
    for (const path of ["/api/voice/session", "/api/voice/token"]) {
      const before = Date.now();
      const response = await t.fetch(path, { method: "POST", body: "ignored non-JSON input" });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.token).toBe("fixture-short-lived-token");
      expect(body.expiresAt).toBeGreaterThanOrEqual(before + 60_000);
      expect(body.expiresAt).toBeLessThanOrEqual(Date.now() + 60_000);
      if (path.endsWith("session")) {
        expect(body.providerId).toBe("deepgram");
        expect(new URL(body.url).searchParams.get("keyterm")).toBe("Odysseus");
        expect(body.capabilities).toMatchObject({ keyterms: true, streaming: true });
      } else { expect(Object.keys(body).sort()).toEqual(["expiresAt", "token"]); }
    }
    expect(calls).toHaveLength(2);
    expect(calls.every((c) => c.authorization === "Token fixture-only-deepgram-key")).toBe(true);
    expect(calls.map((c) => c.body)).toEqual([{ ttl_seconds: 60 }, { ttl_seconds: 60 }]);
    refuse = true;
    for (const path of ["/api/voice/session", "/api/voice/token"]) {
      const response = await t.fetch(path, { method: "POST" });
      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body.error).toContain("Deepgram grant rejected (403)");
      expect(body.token).toBeUndefined();
    }
    expect(calls).toHaveLength(4);
  } finally { mock.mockRestore(); await t.close(); }
});
