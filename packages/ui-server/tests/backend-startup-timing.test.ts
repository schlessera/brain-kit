import { expect, spyOn, test } from "bun:test";
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

test("lifecycle observations retain elapsed time and startup ordering across wall-clock corrections", () => {
  const db = createUiDb(":memory:"); let wall = 1000, mono = 0;
  const date = spyOn(Date, "now").mockImplementation(() => wall);
  const tick = spyOn(performance, "now").mockImplementation(() => mono);
  try {
    const store = createActivityStore(db), life = createTurnLifecycle(store, "ithaca-clock", "ithaca", 1000, () => {});
    life.mark("governedStartedAt"); mono = 10; wall = 1010; const governed = life.timer("governed")("gate");
    mono = 40; wall = 920; governed(); life.mark("governedAcquiredAt");
    mono = 50; wall = 930; life.mark("backendInvokedAt");
    mono = 100; wall = 1100; const probe = life.startupTiming.start("host_probe");
    mono = 150; wall = 1020; probe();
    mono = 160; wall = 1030; life.startupTiming.worker("resources", 9);
    mono = 165; wall = 1_000_000; life.firstFrame("ithaca-clock");
    mono = 170; wall = 1040; life.startupTiming.received();
    mono = 200; wall = 900; life.finish("success");
    const record = store.lifecycle("ithaca-clock")!;
    expect(record, "LIFECYCLE_USES_ONE_MONOTONIC_EPOCH_BASIS").toMatchObject({ backendInvokedAt: 1050, firstFrameAt: 1165,
      firstRelayRequestAt: 1170, endedAt: 1200, totalElapsedMs: 200, governedAdmissionMs: 40 });
    expect(record.subPhases).toEqual([{ phase: "governed", name: "gate", startedAt: 1010, endedAt: 1040, elapsedMs: 30 }]);
    expect(record.openSubPhases!.find(step => step.name === "host_probe")).toMatchObject({ startedAt: 1100, endedAt: 1150, elapsedMs: 50 });
    expect(record.openSubPhases!.find(step => step.name === "resources")).toMatchObject({ startedAt: 1160, endedAt: 1160, elapsedMs: 9 });
  } finally { tick.mockRestore(); date.mockRestore(); db.close(); }
});

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
    const record = store.lifecycle("turn-ithaca")!, names = record.backendMissingEvidence!;
    expect(names.length, "MISSING_EVIDENCE_COUNT_IS_BOUNDED").toBeLessThanOrEqual(8);
    expect(Buffer.byteLength(JSON.stringify(names)), "MISSING_EVIDENCE_BYTES_ARE_BOUNDED").toBeLessThanOrEqual(256);
    expect(names[0]).toBe("first_enqueue");
    expect(record.backendEvidenceOmitted! + names.length, "OMITTED_DIAGNOSTIC_COUNT_IS_EXACT").toBe(6003);
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

test("backend steps have independent count and encoded-byte caps with exact omitted observations", () => {
  const db = createUiDb(":memory:"), store = createActivityStore(db);
  try {
    const life = createTurnLifecycle(store, "ithaca-bounded-steps", "ithaca", 1000, () => {}, () => 1100);
    life.mark("backendInvokedAt");
    for (let i = 0; i < 1000; i++) life.startupTiming.start(`worker-${i}`)();
    life.startupTiming.start("帆".repeat(100))();
    life.startupTiming.missing("mcp_connect:additional_servers_omitted", 100);
    life.finish("success");
    const record = store.lifecycle("ithaca-bounded-steps")!, steps = record.openSubPhases!.filter(step => step.phase === "backend");
    expect(steps.length, "BACKEND_STEP_COUNT_IS_BOUNDED").toBeLessThanOrEqual(16);
    expect(Buffer.byteLength(JSON.stringify(steps)), "BACKEND_STEP_BYTES_ARE_BOUNDED").toBeLessThanOrEqual(2048);
    expect(record.backendEvidenceOmitted! + steps.length, "OMITTED_BACKEND_COUNT_IS_EXACT").toBe(1101);
    expect(record.backendMissingEvidence, "COUNTS_PRESERVE_MISSING_EVIDENCE_NOTE").toContain("mcp_connect:additional_servers_omitted");
  } finally { db.close(); }
});

test("backend byte limits apply independently before their count limits", () => {
  const db = createUiDb(":memory:"), store = createActivityStore(db), pinned = Date.UTC(2026, 6, 12);
  try {
    const life = createTurnLifecycle(store, "ithaca-bounded-bytes", "ithaca", pinned, () => {}, () => pinned);
    life.mark("backendInvokedAt");
    for (let i = 0; i < 8; i++) life.startupTiming.missing(`mcp_connect:${i}-${"x".repeat(70)}`);
    for (let i = 0; i < 16; i++) life.startupTiming.start(`probe-${i}-${"x".repeat(80)}`)();
    life.finish("success");
    const record = store.lifecycle("ithaca-bounded-bytes")!, steps = record.openSubPhases!, names = record.backendMissingEvidence!;
    expect(Buffer.byteLength(JSON.stringify(names)), "DIAGNOSTIC_BYTE_LIMIT_IS_INDEPENDENT").toBeLessThanOrEqual(256);
    expect(Buffer.byteLength(JSON.stringify(steps)), "BACKEND_STEP_BYTE_LIMIT_IS_INDEPENDENT").toBeLessThanOrEqual(2048);
    expect(names.length).toBeLessThan(8); expect(steps.length).toBeLessThan(16);
    expect(record.backendEvidenceOmitted! + names.length + steps.length).toBe(24);
  } finally { db.close(); }
});

test("reading pre-cap backend records bounds additions without changing admission or other open phases", () => {
  const db = createUiDb(":memory:"), store = createActivityStore(db);
  try {
    const life = createTurnLifecycle(store, "ithaca-pre-cap", "ithaca", 1000, () => {}, () => 1100); life.finish("success");
    const old = store.lifecycle("ithaca-pre-cap")!; delete old.backendEvidenceOmitted;
    old.subPhases = [{ phase: "journal", name: "begin", startedAt: 1000, endedAt: 1100, elapsedMs: 100 }];
    const closing = { phase: "closing", name: "finish", startedAt: 1100, endedAt: 1100, elapsedMs: 0 };
    old.openSubPhases = [closing, ...Array.from({ length: 100 }, (_, i) => ({ phase: "backend", name: `worker-${i}`, startedAt: 1000, endedAt: 1100, elapsedMs: 100 }))];
    old.backendMissingEvidence = Array.from({ length: 100 }, (_, i) => `mcp_connect:${i}-${"x".repeat(190)}`);
    db.query("UPDATE activity_turn_lifecycles SET record = ? WHERE turn_id = ?").run(JSON.stringify(old), old.turnId);
    const current = store.lifecycle(old.turnId)!;
    expect(current.subPhases).toEqual(old.subPhases);
    expect(current.openSubPhases!.find(step => step.phase === "closing")).toEqual(closing);
    const backend = current.openSubPhases!.filter(step => step.phase === "backend");
    expect(backend.length, "HISTORICAL_BACKEND_EVIDENCE_IS_BOUNDED").toBeLessThanOrEqual(16);
    expect(current.backendMissingEvidence).toEqual([]);
    expect(current.backendEvidenceOmitted! + backend.length).toBe(200);
    expect(store.lifecycle(old.turnId)).toEqual(current);
  } finally { db.close(); }
});

test("diagnostic count limits apply independently before the byte limit", () => {
  const db = createUiDb(":memory:"), store = createActivityStore(db);
  try {
    const life = createTurnLifecycle(store, "ithaca-diagnostic-count", "ithaca", 1000, () => {}, () => 1100);
    life.mark("backendInvokedAt");
    for (let i = 0; i < 50; i++) life.startupTiming.missing(`d${i}`);
    life.finish("success");
    const record = store.lifecycle("ithaca-diagnostic-count")!;
    expect(record.backendMissingEvidence, "DIAGNOSTIC_COUNT_LIMIT_IS_INDEPENDENT").toHaveLength(8);
    expect(record.backendEvidenceOmitted).toBe(42);
  } finally { db.close(); }
});
