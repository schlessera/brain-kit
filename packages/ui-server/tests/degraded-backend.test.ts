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
