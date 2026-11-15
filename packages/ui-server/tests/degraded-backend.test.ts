import { mockWorkerHostForSdkStream } from "../../ui-backend-claude/tests/helpers/worker-host";
mockWorkerHostForSdkStream();
import { expect, spyOn, test } from "bun:test";
import * as modules from "node:module";
import { createTestApp } from "./helpers/test-app";
import { createRecordingObservability } from "../src/observability/index";
import { getSetting } from "../src/db/settings";
import { resolveAmbientPrincipal } from "../src/db/principals";
import { createWsHandlers } from "../src/ws/connection";
import type { WSContext } from "../src/ws/clients";
import { createUiDb } from "../src/db/client";
import { setSetting } from "../src/db/settings";

// The installed secondary SDK cannot satisfy this host floor. The real boot
// probe must contain that failure and the real lazy registry must exclude it.
test.each(["resolution", "runtime"] as const)("a secondary %s failure boots degraded while the default completes a turn", async (phase) => {
  const originalRequire = modules.createRequire;
  const requireSpy = phase === "resolution" ? spyOn(modules, "createRequire").mockImplementation(filename => {
    const require = originalRequire(filename);
    const resolve = require.resolve;
    require.resolve = Object.assign((specifier: string, options?: { paths?: string[] }) => {
      if (specifier === "@schlessera/brain-backend-pi") throw Object.assign(new Error(`Cannot find module '${specifier}'`), { code: "MODULE_NOT_FOUND" });
      return resolve(specifier, options);
    }, { paths: resolve.paths });
    return require;
  }) : undefined;
  const observability = createRecordingObservability();
  let t: Awaited<ReturnType<typeof createTestApp>> | undefined;
  let start: ReturnType<typeof spyOn> | undefined;
  try {
    t = await createTestApp({ env: {
      BRAIN_UI_PI_PROFILES: JSON.stringify([{ id: "pi-test", label: "Pi test", vendor: "openai", model: "gpt-test" }]),
    }, appOptions: { observability, ...(phase === "runtime" ? { versionRequirements: { backends: { pi: { sdk: "999.0.0" } } } } : {}) } });
    const health = await t.fetch("/api/health");
    expect(health.status).toBe(200);
    const publicHealth = await health.json() as Record<string, unknown>;
    expect(publicHealth).toMatchObject({ status: "degraded", reasons: ["backend_unavailable"] });
    expect(Object.keys(publicHealth).sort()).toEqual(["reasons", "status", "timestamp", "uptime"]);
    const status = await (await t.fetch("/api/status")).json() as { healthy: boolean; backendAvailability: { unavailable: unknown[] } };
    expect(status.healthy).toBe(false);
    expect(status.backendAvailability.unavailable).toEqual([expect.objectContaining({ backendId: "pi", phase, message: expect.stringContaining(phase === "runtime" ? "999.0.0" : "not installed") })]);
    expect(getSetting<unknown[]>(t.app.db, "boot.backendFailures", [])).toEqual(status.backendAvailability.unavailable);
    expect(observability.logs.find({ severity: "WARN" }).filter(log => String(log.body).includes("Backend pi unavailable:"))).toHaveLength(1);
    // The excluded backend's auth and extension services stay unloaded too.
    expect(await (await t.fetch("/api/pi-auth/providers")).json()).toEqual({ providers: [] });
    const json = { "content-type": "application/json" };
    expect((await t.fetch("/api/pi-auth/login", { method: "POST", headers: json, body: JSON.stringify({ providerId: "openai" }) })).status).toBe(409);
    expect((await t.fetch("/api/pi-auth/logout", { method: "POST", headers: json, body: JSON.stringify({ providerId: "openai" }) })).status).toBe(409);
    expect(await (await t.fetch("/api/web-search")).json()).toMatchObject({ configured: false, providers: [] });
    expect((await t.fetch("/api/web-search", { method: "PUT", headers: json, body: JSON.stringify({ enabled: ["exa"] }) })).status).toBe(409);
    const registry = t.app.wsHost.registry;
    expect((await registry.getBackends()).map(backend => backend.id)).toEqual(["claude"]);
    expect(await registry.getBackendById("pi")).toBeUndefined();
    await expect(registry.getBackendForSession("pi")).rejects.toThrow();
    const backend = await registry.getDefaultBackend();
    start = spyOn(backend, "startTurn").mockImplementation(async ({ bridge }) => {
      bridge.emit({ type: "session_info", sessionId: "ithaca-degraded", isNew: true });
      bridge.emit({ type: "result", sessionId: "ithaca-degraded", durationMs: 1, numTurns: 1, isError: false });
    });
    const sent: Array<{ type: string; isError?: boolean }> = [];
    const ws = { send: (data: string) => sent.push(JSON.parse(data)), close() {}, readyState: 1 } as unknown as WSContext;
    const principal = resolveAmbientPrincipal(t.app.db, "none", "No authentication", "No authentication");
    const handlers = createWsHandlers(t.app.wsHost, principal);
    handlers.onOpen(undefined as never, ws);
    handlers.onMessage({ data: JSON.stringify({ type: "chat_message", text: "Plan the journey to Ithaca" }) } as MessageEvent, ws);
    const until = Date.now() + 5_000;
    while (!sent.some(frame => frame.type === "result") && Date.now() < until) await Bun.sleep(5);
    expect(start).toHaveBeenCalledTimes(1);
    expect(sent).toContainEqual(expect.objectContaining({ type: "result", isError: false }));
  } finally { start?.mockRestore(); requireSpy?.mockRestore(); await t?.teardown(); }
});

// A repaired backend keeps its last recorded failure for the owner, and a
// malformed historical record is dropped rather than becoming a boot gate.
test("a repaired backend boots healthy and keeps its last failure; malformed history is dropped", async () => {
  const lastFailure = { backendId: "pi", phase: "runtime", site: "probeBackendRuntimes", errorClass: "Error",
    message: "pi SDK 1.0.0 is below the host floor 999.0.0", at: "2026-07-12T08:00:00.000Z" };
  let t: Awaited<ReturnType<typeof createTestApp>> | undefined;
  try {
    t = await createTestApp({
      env: { BRAIN_UI_PI_PROFILES: JSON.stringify([{ id: "pi-test", label: "Pi test", vendor: "openai", model: "gpt-test" }]) },
      prepare: brainPath => {
        const db = createUiDb(brainPath.replace(/-brain$/, ".db"));
        try { setSetting(db, "boot.backendFailures", [lastFailure, { backendId: "pi", phase: "bogus" }, "not-a-record", null]); }
        finally { db.close(); }
      },
    });
    const health = await (await t.fetch("/api/health")).json() as { status: string };
    expect(health.status).toBe("healthy");
    const status = await (await t.fetch("/api/status")).json() as { backendAvailability: { unavailable: unknown[]; lastFailures: unknown[] } };
    expect(status.backendAvailability.unavailable).toEqual([]);
    expect(status.backendAvailability.lastFailures).toEqual([lastFailure]);
  } finally { await t?.teardown(); }
});
