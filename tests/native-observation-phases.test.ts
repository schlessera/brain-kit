/** #2915: attributing a native journal observation's hold to its steps on one clock. */
import { expect, test } from "bun:test";
import { observationPhases, summarizePhases, type ManagerSpan, type ObservationTrace } from "../scripts/native-proof/observation-phases.js";

const step = (name: string, startedAt: number, endedAt: number | null) => ({ name, startedAt, endedAt });
/** A writer's hold at 1000-1100: it waited 5 ms, took a checkpoint that queued behind a release, then a delta. */
const writer: ObservationTrace = { kind: "tool", turnId: "turn-telemachus", toolUseId: "write-1", steps: [
  step("hold", 1000, 1100), step("hold_wait", 1000, 1005), step("observe_reserve", 1005, 1006),
  step("observe_checkpoint", 1006, 1066), step("observe_delta", 1066, 1080), step("observe_metadata", 1080, 1082),
  step("observe_record", 1082, 1090), step("observe_commit", 1090, 1092),
] };
const spans: ManagerSpan[] = [
  // A release handed off by the previous observation, still holding the lock.
  { request: 1, operation: "release", phase: "lock_wait", startedAt: 990, endedAt: 990, holder: null },
  { request: 1, operation: "release", phase: "held", startedAt: 990, endedAt: 1040 },
  { request: 2, operation: "checkpoint", phase: "lock_wait", startedAt: 1007, endedAt: 1040, holder: "release" },
  { request: 2, operation: "checkpoint", phase: "held", startedAt: 1040, endedAt: 1064 },
  { request: 2, operation: "checkpoint", phase: "qualify", startedAt: 1040, endedAt: 1045 },
  { request: 2, operation: "checkpoint", phase: "intent", startedAt: 1045, endedAt: 1048 },
  { request: 2, operation: "checkpoint", phase: "snapshot", startedAt: 1048, endedAt: 1058 },
  { request: 2, operation: "checkpoint", phase: "verify", startedAt: 1058, endedAt: 1060 },
  { request: 2, operation: "checkpoint", phase: "intent", startedAt: 1060, endedAt: 1063 },
  { request: 3, operation: "delta", phase: "lock_wait", startedAt: 1067, endedAt: 1067, holder: null },
  { request: 3, operation: "delta", phase: "held", startedAt: 1067, endedAt: 1079 },
  { request: 3, operation: "delta", phase: "verify", startedAt: 1067, endedAt: 1069 },
  { request: 3, operation: "delta", phase: "send", startedAt: 1069, endedAt: 1079 },
];

test("leaves sum without the containers; each native step is broken down by its own request", () => {
  const phases = observationPhases(writer, spans);
  expect(phases.holdMs, "PHASES_HOLD").toBe(100);
  expect(phases.phases, "PHASES_LEAVES").toEqual({ hold_wait: 5, observe_reserve: 1, observe_checkpoint: 60, observe_delta: 14, observe_metadata: 2, observe_record: 8, observe_commit: 2 });
  expect(phases.attributedMs, "PHASES_ATTRIBUTED_IS_THE_LEAF_SUM").toBe(92);
  // 60 ms of checkpoint: 33 queued behind the release, 23 in spans, 1 in the manager outside them, 3 in transport.
  expect(phases.native, "PHASES_NATIVE_BREAKDOWN").toEqual({ "checkpoint.lock_wait": 33, "checkpoint.qualify": 5, "checkpoint.intent": 6, "checkpoint.snapshot": 10,
    "checkpoint.verify": 2, "checkpoint.other": 1, "checkpoint.transport": 3,
    "delta.lock_wait": 0, "delta.verify": 2, "delta.send": 10, "delta.other": 0, "delta.transport": 2 });
  expect(phases.lockWaits, "PHASES_LOCK_WAIT_NAMES_ITS_HOLDER").toEqual([{ step: "observe_checkpoint", holder: "release", ms: 33 }, { step: "observe_delta", holder: null, ms: 0 }]);
  expect(phases.clock, "PHASES_CLOCK_PROOF").toEqual({ paired: 2, unpaired: [], minStartSlackMs: 1, minEndSlackMs: 2 });
});

test("a request outside its step stays unpaired, and an unended step is reported, not counted", () => {
  // A manager clock 10 ms ahead puts the checkpoint's arrival after its step began, but the
  // control response after the step ended: the end slack turns negative.
  const late = spans.map(span => span.request === 2 ? { ...span, startedAt: span.startedAt + 10, endedAt: span.endedAt + 10 } : span);
  expect(observationPhases(writer, late).clock.minEndSlackMs, "PHASES_CLOCK_SKEW_SHOWS_IN_END_SLACK").toBe(-8);
  // 30 ms behind, it arrived before the step began: no request pairs with it.
  const early = spans.map(span => span.request === 2 ? { ...span, startedAt: span.startedAt - 30, endedAt: span.endedAt - 30 } : span);
  const unpaired = observationPhases(writer, early);
  expect(unpaired.clock.unpaired, "PHASES_UNPAIRED_STEP_REPORTED").toEqual(["observe_checkpoint:0"]);
  expect(Object.keys(unpaired.native).some(name => name.startsWith("checkpoint.")), "PHASES_UNPAIRED_STEP_HAS_NO_BREAKDOWN").toBe(false);
  const failed = observationPhases({ ...writer, steps: [...writer.steps.slice(0, 4), step("observe_delta", 1066, null)] }, spans);
  expect([failed.incomplete, "observe_delta" in failed.phases], "PHASES_UNENDED_STEP_NOT_COUNTED").toEqual([["observe_delta"], false]);
  expect(() => observationPhases({ ...writer, steps: writer.steps.slice(1) }, spans), "PHASES_REQUIRE_AN_ENDED_HOLD").toThrow("OBSERVATION_TRACE_HAS_NO_ENDED_HOLD");
});

test("summaries take medians per phase with an absent phase as zero, and cover the independently measured time", () => {
  const one = observationPhases(writer, spans);
  const two = observationPhases({ ...writer, steps: writer.steps.filter(item => item.name !== "observe_reserve") }, spans);
  const summary = summarizePhases([{ phases: one, measuredMs: 100 }, { phases: two, measuredMs: 120 }, { phases: two, measuredMs: 200 }]);
  expect(summary.phases.observe_reserve, "SUMMARY_ABSENT_PHASE_IS_ZERO").toEqual({ medianMs: 0, p95Ms: 1, present: 1 });
  expect(summary.measured, "SUMMARY_MEASURED").toEqual({ medianMs: 120, p95Ms: 200, samples: 3 });
  // 92/100, 91/120 and 91/200 of the measured time.
  expect(summary.coverage, "SUMMARY_COVERAGE_AGAINST_MEASURED").toEqual({ medianPct: 75.8, minPct: 45.5 });
  expect(summary.unattributed.medianMs, "SUMMARY_UNATTRIBUTED").toBe(29);
  expect(summary.lockWaitsBehind, "SUMMARY_LOCK_WAITS_BEHIND").toEqual({ "observe_checkpoint:release": 3 });
  expect(summary.clock, "SUMMARY_CLOCK").toEqual({ paired: 6, unpaired: [], minStartSlackMs: 1, minEndSlackMs: 2 });
});
