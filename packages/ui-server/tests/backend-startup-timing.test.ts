import { expect, test } from "bun:test";
import { createUiDb } from "../src/db/client.js";
import { createActivityStore } from "../src/activity/store.js";
import { createTurnLifecycle } from "../src/activity/turn-lifecycle.js";
import { serverActivityDeltaSchema } from "@schlessera/brain-ui-sdk/schemas";

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
    expect(store.lifecycle("turn-ithaca")!.subPhases!.at(-1)).toMatchObject({ name: "sdk_init", endedAt: null, elapsedMs: null });
    now = 1400; timing.received();
    now = 1500; unfinished(); timing.start("too_late")(); timing.worker("too_late", 99); timing.received();
    life.finish("success"); timing.missing("too_late");
    const record = store.lifecycle("turn-ithaca")!;
    expect(record.firstRelayRequestAt).toBe(1400);
    expect(record.backendMissingEvidence).toEqual(["first_enqueue"]);
    expect(record.subPhases).toEqual([
      { phase: "backend", name: "host_probe", startedAt: 1000, endedAt: 1100, elapsedMs: 100 },
      { phase: "backend", name: "resources", startedAt: 1100, endedAt: 1100, elapsedMs: 777, timeBase: "worker", workerElapsedMs: 777 },
      { phase: "backend", name: "sdk_init", startedAt: 1100, endedAt: null, elapsedMs: 300 },
      { phase: "backend", name: "first_relay_request", startedAt: 1000, endedAt: 1400, elapsedMs: 400 },
    ]);
    expect(record.subPhases!.filter(step => step.startedAt < 1000 || (step.endedAt ?? 1400) > 1400)).toEqual([]);
    const parsed = serverActivityDeltaSchema.parse({ type: "activity_delta", runId: "turn-ithaca", seq: 1, lifecycle: record });
    expect(parsed.lifecycle?.firstRelayRequestAt).toBe(1400);
    expect(parsed.lifecycle?.backendMissingEvidence).toEqual(["first_enqueue"]);
    expect(parsed.lifecycle?.subPhases?.[1], "BACKEND_TIMING_SURVIVES_CLIENT_VALIDATION").toEqual({
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
    expect(store.lifecycle("turn-ithaca")!.subPhases).toEqual([
      { phase: "backend", name: "worker_launch", startedAt: 1000, endedAt: null, elapsedMs: null },
    ]);
    now = 1200;
    if (outcome !== "interrupted") life.mark("failureObservedAt");
    now = 1300; life.finish(outcome);
    now = 1500; end(); life.startupTiming.received();
    const record = store.lifecycle("turn-ithaca")!;
    expect(record.firstRelayRequestAt).toBeNull();
    expect(record.backendMissingEvidence).toEqual(["prompt_recorded"]);
    expect(record.subPhases).toEqual([
      { phase: "backend", name: "worker_launch", startedAt: 1000, endedAt: null, elapsedMs: outcome === "interrupted" ? 300 : 200 },
    ]);
  } finally { db.close(); }
});
