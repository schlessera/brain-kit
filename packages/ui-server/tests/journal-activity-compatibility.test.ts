import { expect, test } from "bun:test";
import { createUiDb } from "../src/db/client.js";
import { createActivityStore } from "../src/activity/store.js";
import { createTurnLifecycle } from "../src/activity/turn-lifecycle.js";
import { createActivityRoutes } from "../src/routes/activity.js";
import { createIndexBatch } from "../src/brain/index-batch.js";
import { createNativeStartupReleases } from "../src/brain/native-startup-releases.js";
import { serverActivityDeltaSchema, serverActivitySnapshotSchema, previousDeltaSchema, previousSnapshotSchema } from "./helpers/activity-schema-0-44.js";
import type { ActivityRunDetail } from "@schlessera/brain-ui-sdk/protocol";

test("previous activity schemas parse journal clocks and index/release receipts in HTTP and wire records", async () => {
  const db = createUiDb(":memory:"), store = createActivityStore(db), turnId = "odysseus-voyage";
  const at = Date.UTC(2026, 6, 12), spanId = `${turnId}:turn`;
  store.startSpan({ spanId, runId: turnId, name: "Odysseus voyage", kind: "turn", origin: "session", sessionId: "ithaca", startedAt: at });
  const lifecycle = createTurnLifecycle(store, turnId, "ithaca", at, () => {}, () => at);
  for (const name of ["startup_release_reserve", "startup_view_cleanup"]) lifecycle.timer("governed")(name)();
  for (const name of ["observe_capture", "observe_record", "observe_publish", "observe_facts", "observe_commit"]) lifecycle.timer("journal")(name)();
  const batch = createIndexBatch({ async index() {}, receipt: receipt => { store.appendEvent(spanId, "index_update", receipt, at); } });
  const releases = createNativeStartupReleases(result => { store.appendEvent(spanId, "startup_checkpoint_release", result, at); });
  let attempts = 0;
  try {
    batch.queue(["notes/ithaca.md"], undefined, turnId); await batch.barrier();
    const slot = await releases.reserve();
    slot.handoff(turnId, { brain: "/odysseus/brain", root: "/odysseus/checkpoint", storage: { root: "/odysseus/checkpoint", retain() {}, release() {} },
      async cleanup() { if (++attempts === 1) throw new Error("EIO"); } });
    await releases.settled(); await releases.drain();
    lifecycle.finish("success");
    const response = await createActivityRoutes({ db, store }).request(`/activity/runs/${turnId}`);
    expect(response.status).toBe(200);
    const detail = await response.json() as ActivityRunDetail;
    expect(detail.events?.map(event => event.eventType), "NEW_RECEIPTS_USE_EXISTING_FREE_FORM_EVENT_TYPE").toEqual(["index_update", "startup_checkpoint_release", "startup_checkpoint_release"]);
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
