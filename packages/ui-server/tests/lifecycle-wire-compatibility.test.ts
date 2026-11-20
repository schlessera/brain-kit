import { expect, test } from "bun:test";
import { z } from "zod";
import { serverActivitySnapshotSchema, serverActivityDeltaSchema } from "@schlessera/brain-ui-sdk/schemas";
import { createUiDb } from "../src/db/client";
import { createActivityStore } from "../src/activity/store";
import { createTurnLifecycle } from "../src/activity/turn-lifecycle";

// Verbatim lifecycle parser from the published-shape base 134c0eee9.
// The envelope's other fields have not changed; retain those actual schemas.
const id = z.string().min(1).max(256);
const previousLifecycleSchema = z.looseObject({
  hostEvents: z.array(z.looseObject({principalId: id, kind: z.enum(["turn_cancelled", "ask_user_cancelled", "principal_revoked", "follow_up"]), observedAt: z.number()})),
  skippedPhases: z.array(z.enum(["governed", "budget", "journal"])),
  lifecycleId: id, turnId: id, sessionId: id.nullable(), backendRunId: id.nullable(),
  acceptedAt: z.number(),
  dequeuedAt: z.number().nullable(),
  governedStartedAt: z.number().nullable(),
  governedAcquiredAt: z.number().nullable(),
  budgetStartedAt: z.number().nullable(),
  budgetAdmittedAt: z.number().nullable(),
  journalStartedAt: z.number().nullable(),
  journalBeganAt: z.number().nullable(),
  backendInvokedAt: z.number().nullable(),
  firstFrameAt: z.number().nullable(),
  failureObservedAt: z.number().nullable(),
  endedAt: z.number().nullable(),
  totalElapsedMs: z.number().nullable(),
  timeToFirstFrameMs: z.number().nullable(),
  queueWaitMs: z.number().nullable(),
  governedAdmissionMs: z.number().nullable(),
  budgetAdmissionMs: z.number().nullable(),
  journalBeginMs: z.number().nullable(),
  backendStartupMs: z.number().nullable(),
  subPhases: z.array(z.looseObject({ phase: z.enum(["governed", "journal"]), name: z.string(), startedAt: z.number(),
    endedAt: z.number().nullable(), elapsedMs: z.number().nullable() })).optional(),
  outcome: z.enum(["success", "error", "timeout", "cancelled", "denied", "interrupted"]).nullable(), reason: z.string().nullable(),
});
const previousDeltaSchema = serverActivityDeltaSchema.extend({ lifecycle: previousLifecycleSchema.optional() });
const previousSnapshotSchema = serverActivitySnapshotSchema.extend({ lifecycles: z.array(previousLifecycleSchema).optional() });

test("published activity schemas accept closing steps and other additive host evidence", () => {
  const db = createUiDb(":memory:");
  try {
    const store = createActivityStore(db); let now = 1000;
    const life = createTurnLifecycle(store, "turn-ithaca", "ithaca", now, () => {}, () => now, { buildRevision: "ithaca+4278" });
    const admitted = life.timer("governed")("gate_acquire"); now = 1100; admitted();
    life.hold({ holdId: "hold-ithaca", cause: "tool", causeTurnId: "turn-ithaca", toolUseId: "shell-1",
      requestedAt: 1100, stoppedAt: 1101, resumedAt: 1102, changedPaths: 1, otherTurnsStopped: 1, inferenceInFlight: true });
    const closed = life.timer("closing")("journal_finish"); now = 1200; closed();
    life.finish("success"); now = 1300; life.mark("recorderSettledAt"); life.mark("idleEmittedAt");
    const record = store.lifecycle("turn-ithaca")!;
    const delta = { type: "activity_delta", runId: "turn-ithaca", seq: 1, lifecycle: record };
    const snapshot = { type: "activity_snapshot", view: "session", sessionId: "ithaca", spans: [], events: [], highWaterSeq: {}, lifecycles: [record] };
    expect(previousDeltaSchema.safeParse(delta).success, "PUBLISHED_DELTA_ACCEPTS_NEW_HOST_EVIDENCE").toBe(true);
    expect(previousSnapshotSchema.safeParse(snapshot).success, "PUBLISHED_SNAPSHOT_ACCEPTS_NEW_HOST_EVIDENCE").toBe(true);
    expect(record.subPhases?.map(step => step.phase)).toEqual(["governed"]);
    expect(record.openSubPhases).toEqual([{ phase: "closing", name: "journal_finish", startedAt: 1100, endedAt: 1200, elapsedMs: 100 }]);
    const future = { ...record, openSubPhases: [...(record.openSubPhases ?? []), { phase: "future_phase", name: "future_step", startedAt: 1200, endedAt: null, elapsedMs: null }] };
    expect(serverActivityDeltaSchema.parse({ ...delta, lifecycle: future }).lifecycle?.openSubPhases?.at(-1)?.phase).toBe("future_phase");
    expect(serverActivitySnapshotSchema.parse({ ...snapshot, lifecycles: [future] }).lifecycles?.[0]?.openSubPhases?.at(-1)?.phase).toBe("future_phase");
  } finally { db.close(); }
});
