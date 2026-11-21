import { expect, test } from "bun:test";
import { createUiDb } from "../src/db/client.js";
import { createActivityStore } from "../src/activity/store.js";
import { createTurnLifecycle } from "../src/activity/turn-lifecycle.js";
import { serverActivityDeltaSchema } from "@schlessera/brain-ui-sdk/schemas";
import { z } from "zod";

// The previous SDK's closed phase schema. Its lifecycle object accepts
// unknown fields, but an unknown phase rejects the entire enclosing frame.
const previousStep = z.looseObject({ phase: z.enum(["governed", "journal"]), name: z.string(), startedAt: z.number(),
  endedAt: z.number().nullable(), elapsedMs: z.number().nullable() });
const previousLifecycle = z.looseObject({ subPhases: z.array(previousStep).optional() });

test("missing startup evidence stays bounded by count and UTF-8 bytes, including late reports", () => {
  const db = createUiDb(":memory:");
  try {
    const store = createActivityStore(db);
    const life = createTurnLifecycle(store, "turn-ithaca", "ithaca", 1000, () => {}, () => 1100);
    life.mark("backendInvokedAt"); life.startupTiming.missing("first_enqueue");
    life.startupTiming.missing("mcp_connect:" + "🦉".repeat(80));
    life.startupTiming.missing("mcp_connect:" + "ithaca".repeat(1000));
    for (let i = 0; i < 3000; i++) life.startupTiming.missing(`mcp_connect:ithaca-server-${i}`);
    life.startupTiming.received();
    for (let i = 3000; i < 6000; i++) life.startupTiming.missing(`mcp_connect:ithaca-server-${i}`);
    life.finish("success");
    const names = store.lifecycle("turn-ithaca")!.backendMissingEvidence!;
    expect(names, "MISSING_EVIDENCE_COUNT_IS_BOUNDED").toHaveLength(64);
    expect(new Set(names).size).toBe(64);
    expect(names[0]).toBe("first_enqueue");
    expect(names).toContain("additional_missing_evidence_omitted");
    expect(names.filter(name => Buffer.byteLength(name) > 256), "MISSING_EVIDENCE_BYTES_ARE_BOUNDED").toEqual([]);
  } finally { db.close(); }
});

test("the previous SDK keeps activity frames containing backend and future open phases", () => {
  const db = createUiDb(":memory:");
  try {
    const store = createActivityStore(db); let now = 1000;
    const life = createTurnLifecycle(store, "turn-ithaca", "ithaca", now, () => {}, () => now);
    life.mark("backendInvokedAt"); const end = life.startupTiming.start("host_probe"); now = 1100; end();
    life.startupTiming.received(); life.finish("success");
    const record = store.lifecycle("turn-ithaca")!;
    expect(record.openSubPhases!.map(step => step.name)).toEqual(["host_probe", "first_relay_request"]);
    const oldDelta = z.looseObject({ type: z.literal("activity_delta"), runId: z.string(), seq: z.number(), lifecycle: previousLifecycle.optional() });
    const oldSnapshot = z.looseObject({ type: z.literal("activity_snapshot"), lifecycles: z.array(previousLifecycle).optional() });
    expect(oldDelta.safeParse({ type: "activity_delta", runId: record.turnId, seq: 1, lifecycle: record }).success,
      "PREVIOUS_SDK_ACCEPTS_BACKEND_ACTIVITY_DELTA").toBe(true);
    expect(oldSnapshot.safeParse({ type: "activity_snapshot", lifecycles: [record] }).success).toBe(true);
    expect(previousLifecycle.safeParse({ subPhases: [{ phase: "backend", name: "host_probe", startedAt: 1, endedAt: 2, elapsedMs: 1 }] }).success).toBe(false);
    const future = { ...record, openSubPhases: [{ phase: "future_phase", name: "future_step", startedAt: 1000, endedAt: null, elapsedMs: null }] };
    expect(serverActivityDeltaSchema.safeParse({ type: "activity_delta", runId: record.turnId, seq: 2, lifecycle: future }).success,
      "NEW_SDK_ACCEPTS_UNKNOWN_OPEN_PHASE").toBe(true);
    expect(previousLifecycle.safeParse(future).success).toBe(true);
  } finally { db.close(); }
});

test("unknown open phases use the original pending, failure and milestone-write rules", () => {
  const db = createUiDb(":memory:");
  try {
    const store = createActivityStore(db); let now = 1000;
    const life = createTurnLifecycle(store, "turn-ithaca", "ithaca", now, () => {}, () => now);
    const end = life.timer("future_phase")("future_step");
    expect(store.lifecycle("turn-ithaca")!.openSubPhases).toEqual([]);
    life.mark("dequeuedAt");
    expect(store.lifecycle("turn-ithaca")!.openSubPhases).toEqual([
      { phase: "future_phase", name: "future_step", startedAt: 1000, endedAt: null, elapsedMs: null },
    ]);
    now = 1200; life.mark("failureObservedAt"); now = 1300; life.finish("error"); end();
    expect(store.lifecycle("turn-ithaca")!.openSubPhases).toEqual([
      { phase: "future_phase", name: "future_step", startedAt: 1000, endedAt: null, elapsedMs: 200 },
    ]);
    expect(store.lifecycle("turn-ithaca")!.subPhases).toEqual([]);
  } finally { db.close(); }
});

test("late-observed milestone intervals remain in start order", () => {
  const db = createUiDb(":memory:");
  try {
    const store = createActivityStore(db); let now = 1000;
    const life = createTurnLifecycle(store, "turn-ithaca", "ithaca", now, () => {}, () => now);
    life.mark("backendInvokedAt"); const probed = life.startupTiming.start("host_probe"); now = 1050; probed();
    const launched = life.startupTiming.start("worker_launch"); now = 1150; launched();
    now = 1200; life.firstFrame(null); now = 1400; life.startupTiming.received(); life.finish("success");
    const record = store.lifecycle("turn-ithaca")!;
    const steps = record.openSubPhases ?? record.subPhases!;
    expect(steps.map(step => step.startedAt), "MILESTONE_INTERVALS_STAY_IN_START_ORDER").toEqual([1000, 1000, 1000, 1050]);
    expect(steps.map(step => step.name)).toEqual(["host_probe", "first_backend_frame", "first_relay_request", "worker_launch"]);
  } finally { db.close(); }
});

test("first-frame step and milestone share one clock observation", () => {
  const db = createUiDb(":memory:");
  try {
    const store = createActivityStore(db); let now = 1000;
    const life = createTurnLifecycle(store, "turn-ithaca", "ithaca", now, () => {}, () => now++);
    life.mark("backendInvokedAt"); life.firstFrame(null); life.finish("success");
    const record = store.lifecycle("turn-ithaca")!;
    const step = (record.openSubPhases ?? record.subPhases!).find(step => step.name === "first_backend_frame")!;
    expect(step.endedAt, "FIRST_FRAME_USES_ONE_CLOCK_OBSERVATION").toBe(record.firstFrameAt);
    expect(step.elapsedMs).toBe(record.backendStartupMs);
    expect(record.firstFrameAt).toBe(1001);
  } finally { db.close(); }
});

test("backend steps stay in invocation-to-relay and keep worker durations on their own clock", () => {
  const db = createUiDb(":memory:");
  try {
    const store = createActivityStore(db); let now = 1000;
    const life = createTurnLifecycle(store, "turn-ithaca", "ithaca", now, () => {}, () => now);
    const timing = life.startupTiming;
    timing.start("before_invocation")(); timing.received(); timing.worker("before_invocation", 13);
    life.mark("backendInvokedAt");
    const probe = timing.start("host_probe"); now = 1100; probe(); probe();
    timing.worker("resources", 777); timing.worker("invalid", NaN); timing.worker("invalid", -1);
    timing.missing("first_enqueue"); timing.missing("first_enqueue");
    const unfinished = timing.start("sdk_init");
    life.mark("dequeuedAt");
    expect(store.lifecycle("turn-ithaca")!.openSubPhases!.at(-1)).toMatchObject({ name: "sdk_init", endedAt: null, elapsedMs: null });
    now = 1400; timing.received();
    now = 1500; unfinished(); timing.start("too_late")(); timing.worker("too_late", 99); timing.received();
    life.finish("success"); timing.missing("too_late");
    const record = store.lifecycle("turn-ithaca")!;
    expect(record.firstRelayRequestAt).toBe(1400);
    expect(record.backendMissingEvidence).toEqual(["first_enqueue"]);
    expect(record.openSubPhases).toEqual([
      { phase: "backend", name: "host_probe", startedAt: 1000, endedAt: 1100, elapsedMs: 100 },
      { phase: "backend", name: "first_relay_request", startedAt: 1000, endedAt: 1400, elapsedMs: 400 },
      { phase: "backend", name: "resources", startedAt: 1100, endedAt: 1100, elapsedMs: 777, timeBase: "worker", workerElapsedMs: 777 },
      { phase: "backend", name: "sdk_init", startedAt: 1100, endedAt: null, elapsedMs: 300 },
    ]);
    expect(record.openSubPhases!.filter(step => step.startedAt < 1000 || (step.endedAt ?? 1400) > 1400)).toEqual([]);
    const parsed = serverActivityDeltaSchema.parse({ type: "activity_delta", runId: "turn-ithaca", seq: 1, lifecycle: record });
    expect(parsed.lifecycle?.firstRelayRequestAt).toBe(1400);
    expect(parsed.lifecycle?.backendMissingEvidence).toEqual(["first_enqueue"]);
    expect(parsed.lifecycle?.openSubPhases?.[2], "BACKEND_TIMING_SURVIVES_CLIENT_VALIDATION").toEqual({
      phase: "backend", name: "resources", startedAt: 1100, endedAt: 1100, elapsedMs: 777, timeBase: "worker", workerElapsedMs: 777,
    });
  } finally { db.close(); }
});

for (const outcome of ["error", "cancelled", "denied", "interrupted"] as const) test(`unfinished backend steps retain ${outcome} boundaries and unknown evidence`, () => {
  const db = createUiDb(":memory:");
  try {
    const store = createActivityStore(db); let now = 1000;
    const life = createTurnLifecycle(store, "turn-ithaca", "ithaca", now, () => {}, () => now);
    life.mark("backendInvokedAt");
    const end = life.startupTiming.start("worker_launch");
    life.startupTiming.missing("prompt_recorded");
    life.mark("dequeuedAt");
    expect(store.lifecycle("turn-ithaca")!.openSubPhases).toEqual([
      { phase: "backend", name: "worker_launch", startedAt: 1000, endedAt: null, elapsedMs: null },
    ]);
    now = 1200;
    if (outcome !== "interrupted") life.mark("failureObservedAt");
    now = 1300; life.finish(outcome);
    now = 1500; end(); life.startupTiming.received();
    const record = store.lifecycle("turn-ithaca")!;
    expect(record.firstRelayRequestAt).toBeNull();
    expect(record.backendMissingEvidence).toEqual(["prompt_recorded"]);
    expect(record.openSubPhases).toEqual([
      { phase: "backend", name: "worker_launch", startedAt: 1000, endedAt: null, elapsedMs: outcome === "interrupted" ? 300 : 200 },
    ]);
  } finally { db.close(); }
});
