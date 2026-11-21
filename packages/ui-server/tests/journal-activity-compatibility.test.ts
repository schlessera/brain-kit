import { handleQueryActivity, type ActivityQuery } from "@schlessera/brain-ui-sdk/server";
import { runActivityQuery } from "../src/activity/query.js";
import { expect, test } from "bun:test";
import { createUiDb } from "../src/db/client.js";
import { createActivityStore } from "../src/activity/store.js";
import { createTurnLifecycle } from "../src/activity/turn-lifecycle.js";
import { createActivityRoutes } from "../src/routes/activity.js";
import { createIndexBatch } from "../src/brain/index-batch.js";
import { recordMaintenanceReceipt, startupReleaseFailure } from "../src/brain/host-maintenance-receipts.js";
import { createNativeStartupReleases } from "../src/brain/native-startup-releases.js";
import { serverActivityDeltaSchema, serverActivitySnapshotSchema, previousDeltaSchema, previousSnapshotSchema } from "./helpers/activity-schema-0-44.js";
import type { ActivityRunDetail } from "@schlessera/brain-ui-sdk/protocol";

test("previous activity schemas parse journal clocks and index/release receipts in HTTP and wire records", async () => {
  const db = createUiDb(":memory:"), store = createActivityStore(db), turnId = "odysseus-voyage";
  const at = Date.UTC(2026, 6, 12), spanId = `${turnId}:turn`;

  const lifecycle = createTurnLifecycle(store, turnId, "ithaca", at, () => {}, () => at);
  for (const name of ["startup_release_reserve", "startup_view_cleanup"]) lifecycle.timer("governed")(name)();
  for (const name of ["observe_capture", "observe_record", "observe_publish", "observe_facts", "observe_commit"]) lifecycle.timer("journal")(name)();
  const batch = createIndexBatch({ async index() {}, receipt: receipt => recordMaintenanceReceipt(store, turnId, "index_update", receipt) });
  const releases = createNativeStartupReleases(result => recordMaintenanceReceipt(store, turnId, "startup_checkpoint_release", result));
  let attempts = 0;
  try {
    batch.queue(["notes/ithaca.md"], undefined, turnId); await batch.barrier();
    const slot = await releases.reserve();
    slot.handoff(turnId, { brain: "/odysseus/brain", root: "/odysseus/checkpoint", storage: { root: "/odysseus/checkpoint", retain() {}, release() {} },
      async cleanup() { if (++attempts === 1) throw new Error("EIO"); } });
    await releases.settled(); await releases.drain();
    expect(store.getSpan(spanId), "RECEIPTS_PRECEDE_BACKEND_ROOT").toBeNull();
    expect(db.query("SELECT count(*) AS n FROM activity_events").get(), "EARLY_RECEIPTS_DURABLY_RECORDED").toEqual({ n: 3 });
    store.startSpan({ spanId, runId: turnId, name: "Odysseus voyage", kind: "turn", origin: "session", sessionId: "ithaca", startedAt: at });
    lifecycle.finish("success");
    const response = await createActivityRoutes({ db, store }).request(`/activity/runs/${turnId}`);
    expect(response.status).toBe(200);
    const detail = await response.json() as ActivityRunDetail;
    expect(detail.events?.map(event => event.eventType).sort(), "NEW_RECEIPTS_USE_EXISTING_FREE_FORM_EVENT_TYPE").toEqual(["index_update", "startup_checkpoint_release", "startup_checkpoint_release"]);
    expect(detail.lifecycle?.subPhases?.map(step => [step.phase, step.name])).toEqual([
      ["governed", "startup_release_reserve"], ["governed", "startup_view_cleanup"], ["journal", "observe_capture"], ["journal", "observe_record"],
      ["journal", "observe_publish"], ["journal", "observe_facts"], ["journal", "observe_commit"],
    ]);
    const frame = { type: "activity_snapshot", view: "run", runId: turnId, spans: detail.spans, events: detail.events,
      lifecycles: [detail.lifecycle], highWaterSeq: { [turnId]: detail.highWaterSeq } };
    expect(serverActivitySnapshotSchema.safeParse(frame).success, "PUBLISHED_044_PARSER_ACCEPTS_HTTP_RECORDS").toBe(true);
    expect(previousSnapshotSchema.safeParse(frame).success, "PREVIOUS_CLOSED_PHASE_PARSER_ACCEPTS_HTTP_RECORDS").toBe(true);
    const lifecycleFrame = { type: "activity_delta", runId: turnId, seq: 1, lifecycle: detail.lifecycle };
    expect(serverActivityDeltaSchema.safeParse(lifecycleFrame).success).toBe(true);
    expect(previousDeltaSchema.safeParse(lifecycleFrame).success, "PREVIOUS_PARSER_ACCEPTS_LIFECYCLE_DELTA").toBe(true);
    const modelText = await handleQueryActivity({ scope: "run", runId: turnId }, { queryActivity: (query: ActivityQuery) => runActivityQuery(db, store, query) } as never);
    expect(modelText, "HOST_RECEIPT_SPANS_STAY_OUT_OF_PROVIDER_CONTEXT").not.toContain("Index update");
    expect(modelText, "STARTUP_RECEIPT_SPANS_STAY_OUT_OF_PROVIDER_CONTEXT").not.toContain("Startup checkpoint release");
    for (const timing of ["startup_release_reserve", "startup_view_cleanup", "observe_capture", "observe_record", "observe_publish", "observe_facts", "observe_commit", "subPhases", "acceptedAt", "lifecycle"])
      expect(modelText, `JOURNAL_TIMING_STAYS_OUT_OF_PROVIDER_CONTEXT ${timing}`).not.toContain(timing);
    expect(JSON.parse(modelText.split("\n").slice(2, -1).join("\n")).spans.map((span: { spanId: string }) => span.spanId), "MODEL_RETAINS_ORDINARY_ACTIVITY_SPANS").toEqual([spanId]);
    expect(detail.spans!.filter(span => span.attrs?.hostMaintenanceReceipt === true), "OWNER_API_RETAINS_HOST_RECEIPTS").toHaveLength(3);
    expect(detail.events).toHaveLength(3);
    for (const event of detail.events!) {
      const delta = { type: "activity_delta", runId: turnId, seq: event.eventIndex + 2, event };
      expect(serverActivityDeltaSchema.safeParse(delta).success).toBe(true);
      expect(previousDeltaSchema.safeParse(delta).success, "PREVIOUS_PARSER_ACCEPTS_RECEIPT_DELTA").toBe(true);
    }
    const bad = structuredClone(lifecycleFrame);
    bad.lifecycle!.subPhases![0]!.phase = "closing" as never;
    expect(previousDeltaSchema.safeParse(bad).success, "LEGACY_CLOSED_ENUM_NEGATIVE_CONTROL").toBe(false);
  } finally { await releases.close(); await batch.idle(); db.close(); }
});


test("startup failure diagnostics retain every required cleanup field", async () => {
  let diagnostic: ReturnType<typeof startupReleaseFailure> | undefined;
  const releases = createNativeStartupReleases(result => { if (result.outcome === "retry") diagnostic = startupReleaseFailure(result); });
  let attempts = 0;
  const slot = await releases.reserve();
  slot.handoff("voyage", { brain: "/odysseus/brain", root: "/odysseus/checkpoint", storage: { root: "/odysseus/checkpoint", retain() {}, release() {} }, async cleanup() { if (++attempts === 1) throw new TypeError("EIO"); } });
  try {
    await releases.settled();
    expect(diagnostic, "STARTUP_DIAGNOSTIC_CONTRACT").toMatchObject({ kind: "checkpoint_release_retry", scope: "startup_checkpoint", checkpointId: "checkpoint", errorClass: "TypeError", retrying: true, cause: "TypeError: EIO" });
    expect(Number.isFinite(diagnostic?.at), "STARTUP_FAILURE_HAS_TIMESTAMP").toBe(true);
    expect(diagnostic!.at).toBeGreaterThan(0);
    await releases.drain();
  } finally { await releases.close(); }
});

test("a resumed session receives its early maintenance receipt before any root span", async () => {
  const { createActivityStream } = await import("../src/activity/stream.js");
  const db = createUiDb(":memory:"), store = createActivityStore(db), stream = createActivityStream(store), frames: { type: string; event?: { eventType: string } }[] = [];
  const ws = { readyState: 1, send(value: string) { frames.push(JSON.parse(value)); }, close() {} };
  try {
    createTurnLifecycle(store, "voyage", "ithaca", Date.now(), () => {});
    stream.handleSubscribe(ws as never, { type: "activity_subscribe", view: "session", sessionId: "ithaca" }, "athena");
    frames.length = 0;
    await recordMaintenanceReceipt(store, "voyage", "startup_checkpoint_release", { turnId: "voyage", checkpointId: "checkpoint", durationMs: 5, attempt: 1, outcome: "released", at: Date.now() });
    stream.pump();
    expect(store.getSpan("voyage:turn")).toBeNull();
    expect(frames.some(frame => frame.event?.eventType === "startup_checkpoint_release"), "EARLY_RECEIPT_REACHES_RESUMED_SESSION_SUBSCRIBER").toBe(true);
  } finally { stream.close(); db.close(); }
});
