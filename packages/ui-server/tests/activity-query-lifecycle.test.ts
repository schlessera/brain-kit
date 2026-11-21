import { expect, spyOn, test } from "bun:test";
import { handleQueryActivity } from "@schlessera/brain-ui-sdk/server";
import { createUiDb } from "../src/db/client.js";
import { createActivityStore } from "../src/activity/store.js";
import { createTurnLifecycle } from "../src/activity/turn-lifecycle.js";
import { runActivityQuery } from "../src/activity/query.js";
import { createActivityRoutes } from "../src/routes/activity.js";

test("query_activity never serializes current or pre-existing lifecycle diagnostics to the provider", async () => {
  const db = createUiDb(":memory:");
  const pinned = Date.UTC(2026, 6, 12), clock = spyOn(Date, "now").mockReturnValue(pinned);
  try {
    const store = createActivityStore(db); let now = pinned;
    const life = createTurnLifecycle(store, "turn-ithaca", "ithaca", now, () => {}, () => now);
    life.mark("governedStartedAt"); const gate = life.timer("governed")("ithaca-host-only-gate"); now += 10; gate(); life.mark("governedAcquiredAt");
    life.mark("backendInvokedAt"); const launch = life.startupTiming.start("ithaca-host-only-launch"); now += 10; launch();
    life.startupTiming.missing("mcp_connect:ithaca-host-only-server"); life.firstFrame("turn-ithaca"); life.startupTiming.received(); life.finish("success");
    store.startSpan({ spanId: "ithaca-root", runId: "turn-ithaca", name: "invoke_agent", kind: "turn", origin: "session", startedAt: pinned });
    store.endSpan("ithaca-root", { outcome: "success", endedAt: pinned + 50, usage: { inputTokens: 3, outputTokens: 5, costUsd: 0.02 } });
    store.rollupRun("turn-ithaca");
    const query = (scope: "recent" | "run", runId?: string) => handleQueryActivity({ scope, ...(runId ? { runId } : {}) }, {
      emit() {}, requestPermission: async () => ({ behavior: "deny" as const, message: "Ithaca permission unavailable" }),
      queryActivity: query => Promise.resolve(runActivityQuery(db, store, query)),
    });
    const assertProvider = (text: string) => {
      expect(text).toContain("turn-ithaca");
      for (const secret of ["lifecycle", "acceptedAt", "governedStartedAt", "subPhases", "openSubPhases", "firstRelayRequestAt", "backendMissingEvidence", "ithaca-host-only"])
        expect(text, `PROVIDER_ACTIVITY_EXCLUDES_HOST_LIFECYCLE ${secret}`).not.toContain(secret);
    };
    assertProvider(await query("recent"));
    assertProvider(await query("run", "turn-ithaca"));
    const ui = await createActivityRoutes({ db, store }).request("/activity/runs/turn-ithaca");
    const uiRecord = await ui.json();
    expect(uiRecord.lifecycle).toMatchObject({ acceptedAt: pinned, firstRelayRequestAt: pinned + 20 });
    expect(uiRecord.lifecycle.subPhases.map((step: { name: string }) => step.name)).toEqual(["ithaca-host-only-gate"]);
    expect(uiRecord.lifecycle.openSubPhases.map((step: { name: string }) => step.name)).toEqual(["ithaca-host-only-launch", "first_backend_frame", "first_relay_request"]);
    const pruned = store.prune({ digestFloorAt: pinned + 100, detailRetentionMs: 0, hardCeilingMs: 0, now: pinned + 100 });
    expect(pruned.runsPruned).toBe(1);
    expect(store.snapshotRun("turn-ithaca")).toBeNull();
    expect(store.lifecycle("turn-ithaca")?.backendMissingEvidence).toEqual(["mcp_connect:ithaca-host-only-server"]);
    assertProvider(await query("recent"));
    assertProvider(await query("run", "turn-ithaca"));
    const admission = createTurnLifecycle(store, "turn-loom", "ithaca", pinned, () => {}, () => pinned + 10);
    admission.mark("governedStartedAt"); admission.timer("governed")("ithaca-host-only-refusal"); admission.finish("denied");
    const onlyLifecycle = await query("run", "turn-loom");
    expect(onlyLifecycle).toContain("turn-loom");
    expect(onlyLifecycle, "PROVIDER_ACTIVITY_EXCLUDES_ENVELOPE_ONLY_LIFECYCLE").not.toContain("lifecycle");
    expect(onlyLifecycle).not.toContain("ithaca-host-only");
  } finally { clock.mockRestore(); db.close(); }
});
