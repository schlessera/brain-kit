import { expect, spyOn, test } from "bun:test";
import type { ActivityTurnLifecycle } from "@schlessera/brain-ui-sdk/protocol";
import { backendStartupSamples, lifecycleTimingSample } from "../scripts/native-proof/lifecycle-timing.js";
import { createUiDb } from "../packages/ui-server/src/db/client.js";
import { createActivityStore } from "../packages/ui-server/src/activity/store.js";
import { createTurnLifecycle } from "../packages/ui-server/src/activity/turn-lifecycle.js";
import { createTurnRecorder } from "../packages/ui-server/src/activity/recorder.js";
import { promptPrefixFingerprint } from "@schlessera/brain-ui-sdk/internal";

function record(): ActivityTurnLifecycle {
  return { hostEvents: [], skippedPhases: [], lifecycleId: "lifecycle:ithaca", turnId: "ithaca", sessionId: "odysseus", backendRunId: "ithaca",
    acceptedAt: 1000, dequeuedAt: 1000, governedStartedAt: 1000, governedAcquiredAt: 1100,
    budgetStartedAt: null, budgetAdmittedAt: null, journalStartedAt: null, journalBeganAt: null,
    backendInvokedAt: 1100, firstRelayRequestAt: 1700, firstFrameAt: 1600, failureObservedAt: null, endedAt: 2000,
    outcome: "success", reason: null, totalElapsedMs: null, timeToFirstFrameMs: null, queueWaitMs: null,
    governedAdmissionMs: null, budgetAdmissionMs: null, journalBeginMs: null, backendStartupMs: null,
    backendMissingEvidence: ["mcp_connect:brain", "first_enqueue", "prompt_recorded"],
    subPhases: [
      { phase: "governed", name: "gate_acquire", startedAt: 1000, endedAt: 1100, elapsedMs: null },
    ],
    openSubPhases: [
      { phase: "backend", name: "host_probe", startedAt: 1100, endedAt: 1200, elapsedMs: null },
      { phase: "backend", name: "first_relay_request", startedAt: 1100, endedAt: 1700, elapsedMs: null },
      { phase: "backend", name: "resources", startedAt: 1500, endedAt: 1500, elapsedMs: null, timeBase: "worker", workerElapsedMs: 340 },
    ] };
}

test("native observation timing projects backend host steps, worker durations and missing SDK evidence", () => {
  const sample = lifecycleTimingSample(record())!;
  expect(sample.invocationToRelayMs).toBe(600);
  expect(sample.backendStartupMs).toBe(500);
  expect(sample.steps, "NATIVE_BACKEND_TIMING_USES_OBSERVED_CLOCK").toEqual({ "governed.gate_acquire": 100,
    "backend.host_probe": 100, "backend.resources": 340, "backend.first_relay_request": 600 });
  expect(sample.backendSteps).toHaveLength(3);
  expect(sample.backendSteps[2]).toEqual({ phase: "backend", name: "resources", startedAt: 1500, endedAt: 1500,
    elapsedMs: 340, timeBase: "worker", workerElapsedMs: 340 });
  expect(sample.backendMissingEvidence).toEqual(["mcp_connect:brain", "first_enqueue", "prompt_recorded"]);
});

function piStartup(firstFrameAt = 1600) {
  const source = record();
  source.firstFrameAt = firstFrameAt;
  source.openSubPhases = ["preparation", "host_probe", "worker_spawn", "first_relay_request"].map(name => ({
    phase: "backend", name, startedAt: 1100, endedAt: 1700, elapsedMs: null,
  }));
  source.openSubPhases.push(...["bootstrap_imports", "resources", "session", "initialize"].map(name => ({
    phase: "backend", name, startedAt: 1500, endedAt: 1500, elapsedMs: null, timeBase: "worker" as const, workerElapsedMs: 31,
  })));
  if (firstFrameAt <= 1700) source.openSubPhases.push({ phase: "backend", name: "first_backend_frame", startedAt: 1100, endedAt: firstFrameAt, elapsedMs: null });
  source.openSubPhases.sort((a, b) => a.startedAt - b.startedAt);
  return lifecycleTimingSample(source)!;
}

function claudeStartup() {
  const source = record(); source.firstRelayRequestAt = null;
  source.openSubPhases = ["host_probe", "worker_host_probe", "worker_launch"].map(name => ({
    phase: "backend", name, startedAt: 1100, endedAt: 1500, elapsedMs: null,
  }));
  source.openSubPhases.push({ phase: "backend", name: "first_backend_frame", startedAt: 1100, endedAt: 1600, elapsedMs: null });
  return lifecycleTimingSample(source, "claude_worker_fixture")!;
}

test("native startup host stages cannot be relabelled as worker-clock durations", () => {
  const valid = piStartup();
  const invalid = { ...valid, backendSteps: valid.backendSteps.map(step => step.name === "host_probe"
    ? { ...step, timeBase: "worker" as const, workerElapsedMs: step.elapsedMs! } : step) };
  expect(() => backendStartupSamples("pi", invalid, Array(5).fill(valid)), "NATIVE_HOST_STEPS_KEEP_HOST_CLOCK")
    .toThrow("BACKEND_TIMING_MISSING_STEPS host_probe");
});

test("native Claude worker qualification contains host steps before turn completion", () => {
  const valid = claudeStartup();
  const invalid = { ...valid, backendSteps: valid.backendSteps.map(step => step.name === "host_probe"
    ? { ...step, startedAt: 2100, endedAt: 2200, elapsedMs: 100 } : step) };
  expect(() => backendStartupSamples("claude", invalid, Array(5).fill(valid)), "CLAUDE_FIXTURE_STEPS_STAY_INSIDE_OBSERVED_STARTUP")
    .toThrow("BACKEND_TIMING_OUTSIDE_STARTUP host_probe");
});

test("Claude qualification permits worker startup after prompt_prefix opened the Activity root", async () => {
  const db = createUiDb(":memory:"), store = createActivityStore(db);
  const pinned = Date.UTC(2026, 6, 12); let now = pinned + 1100;
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  try {
    const lifecycle = createTurnLifecycle(store, "turn-ithaca", "ithaca", pinned + 1000, () => {}, () => now);
    lifecycle.mark("backendInvokedAt");
    const recorder = createTurnRecorder({ store }, { turnId: "turn-ithaca", sessionId: "ithaca", lifecycle });
    const probe = lifecycle.startupTiming.start("host_probe"); now += 20; probe();
    recorder.observeActivity({ kind: "prompt_prefix", resumed: false,
      prefix: promptPrefixFingerprint({ tools: [], system: "Odysseus records Ithaca.", gitStatusIncluded: false }) });
    expect(store.lifecycle("turn-ithaca")!.firstFrameAt).toBe(pinned + 1120);
    for (const name of ["worker_host_probe", "worker_launch"]) {
      now += 10; const end = lifecycle.startupTiming.start(name); now += 10; end();
    }
    now += 10; recorder.observeFrame({ type: "session_info", sessionId: "ithaca", isNew: true });
    now += 10; recorder.finish("success"); lifecycle.finish("success"); await recorder.settled();
    const sample = lifecycleTimingSample(store.lifecycle("turn-ithaca")!, "claude_worker_fixture")!;
    let output: ReturnType<typeof backendStartupSamples> | undefined;
    expect(() => { output = backendStartupSamples("claude", sample, Array(5).fill(sample)); },
      "CLAUDE_BOUNDARY_MUST_INCLUDE_POST_PREFIX_WORKER_STARTUP").not.toThrow();
    expect(output!.firstAfterStart?.backendSteps.find(step => step.name === "worker_launch")?.endedAt).toBe(pinned + 1160);
    expect(output!.firstAfterStart?.invocationToRelayMs).toBeNull();
  } finally { clock.mockRestore(); db.close(); }
});

test("Claude qualification requires an observed terminal bound instead of guessing from first frame", () => {
  const valid = claudeStartup();
  const source = record(); source.firstRelayRequestAt = null; source.endedAt = null;
  source.openSubPhases = valid.backendSteps;
  const pending = lifecycleTimingSample(source, "claude_worker_fixture")!;
  expect(() => backendStartupSamples("claude", pending, Array(5).fill(valid)), "CLAUDE_TERMINAL_BOUND_MUST_BE_OBSERVED")
    .toThrow("BACKEND_TIMING_BOUNDARY_MISSING");
});

for (const [name, endedAt] of [["resources", 1550], ["ithaca_extra", 1550], ["ithaca_extra", null]] as const) {
  test(`native worker duration ${name} cannot fabricate a host interval ending at ${endedAt}`, () => {
    const valid = piStartup();
    const invalid = { ...valid, backendSteps: [...valid.backendSteps.filter(step => step.name !== name), {
      phase: "backend", name, timeBase: "worker" as const, workerElapsedMs: 9, elapsedMs: 9, startedAt: 1500, endedAt,
    }] };
    expect(() => backendStartupSamples("pi", invalid, Array(5).fill(valid)), "WORKER_HOST_TIMESTAMPS_ARE_ONE_RECEIPT_POINT")
      .toThrow(`BACKEND_TIMING_WORKER_RECEIPT_POINT ${name}`);
  });
}

for (const [name, start, end] of [
  ["host_probe", 1000, 1200], ["host_probe", 1800, 1900], ["host_probe", 1600, 1800],
  ["host_probe", 1600, 1500], ["resources", 1800, 1800], ["ithaca_extra", 1800, 1900],
] as const) {
  test(`native startup rejects ${name} outside its interval (${start}, ${end})`, () => {
    const valid = piStartup();
    const steps = valid.backendSteps.filter(step => step.name !== name);
    const replacement = { phase: "backend", name, startedAt: start, endedAt: end, elapsedMs: Math.max(0, end - start),
      ...(name === "resources" ? { timeBase: "worker" as const, workerElapsedMs: 0 } : {}) };
    const invalid = { ...valid, backendSteps: [...steps, replacement] };
    expect(() => backendStartupSamples("pi", invalid, Array(5).fill(valid)), "NATIVE_STEPS_STAY_INSIDE_STARTUP_INTERVAL")
      .toThrow(`BACKEND_TIMING_OUTSIDE_STARTUP ${name}`);
  });
}

for (const receiptFirst of [true, false]) {
  test(`equal-millisecond frame/relay observations preserve actual order (receipt first=${receiptFirst})`, () => {
    const db = createUiDb(":memory:");
    try {
      const store = createActivityStore(db); let now = 1100;
      const life = createTurnLifecycle(store, "turn-ithaca", "ithaca", 1000, () => {}, () => now);
      life.mark("backendInvokedAt");
      for (const name of ["preparation", "host_probe", "worker_spawn"]) life.startupTiming.start(name)();
      for (const name of ["bootstrap_imports", "resources", "session", "initialize"]) life.startupTiming.worker(name, 31);
      now = 1700;
      if (receiptFirst) { life.startupTiming.received(); life.firstFrame("turn-ithaca"); }
      else { life.firstFrame("turn-ithaca"); life.startupTiming.received(); }
      life.finish("success");
      const sample = lifecycleTimingSample(store.lifecycle("turn-ithaca")!)!;
      expect(sample.backendSteps.filter(step => step.name === "first_backend_frame")).toHaveLength(receiptFirst ? 0 : 1);
      let output: ReturnType<typeof backendStartupSamples> | undefined;
      expect(() => { output = backendStartupSamples("pi", sample, Array(5).fill(sample)); },
        "EQUAL_MILLISECONDS_DO_NOT_PROVE_EVENT_ORDER").not.toThrow();
      expect(output!.firstAfterStart?.invocationToRelayMs).toBe(600);
      if (!receiptFirst) {
        const malformed = { ...sample, backendSteps: sample.backendSteps.map(step => step.name === "first_backend_frame" ? { ...step, startedAt: 1101 } : step) };
        expect(() => backendStartupSamples("pi", malformed, Array(5).fill(sample)), "EQUAL_MILLISECOND_PRESENT_FRAME_IS_VALIDATED")
          .toThrow("BACKEND_TIMING_MISSING_STEPS first_backend_frame");
      }
    } finally { db.close(); }
  });
}

test("the Claude worker-fixture projection never publishes inferred SDK-init durations", () => {
  const source = record(); source.firstRelayRequestAt = null;
  source.openSubPhases = [
    { phase: "backend", name: "worker_launch", startedAt: 1100, endedAt: 1200, elapsedMs: null },
    { phase: "backend", name: "runtime_to_sdk_init", startedAt: 1200, endedAt: null, elapsedMs: null },
  ];
  expect(lifecycleTimingSample(source)!.steps["backend.runtime_to_sdk_init"]).toBe(800);
  const fixture = lifecycleTimingSample(source, "claude_worker_fixture")!;
  expect(fixture.steps, "WORKER_FIXTURE_CANNOT_PUBLISH_UNOBSERVED_SDK_DURATION").toEqual({ "governed.gate_acquire": 100, "backend.worker_launch": 100 });
  expect(fixture.backendSteps.map(step => step.name)).toEqual(["worker_launch"]);
});

for (const name of ["first_backend_frame", "first_relay_request"]) {
  test(`native Pi startup proof rejects a missing ${name} step even with the observed timestamp`, () => {
    const sample = { ...piStartup(), backendInvokedAt: 1100, firstFrameAt: 1600, firstRelayRequestAt: 1700 };
    expect(backendStartupSamples("pi", sample, Array(5).fill(sample)).firstAfterStart?.invocationToRelayMs).toBe(600);
    const missing = { ...sample, backendSteps: sample.backendSteps.filter(step => step.name !== name) };
    expect(() => backendStartupSamples("pi", sample, [sample, sample, missing, sample, sample]), "PI_NATIVE_REQUIRES_MILESTONE_STEPS")
      .toThrow(`BACKEND_TIMING_MISSING_STEPS ${name}`);
  });
  for (const endpoint of ["startedAt", "endedAt"] as const) {
    test(`native Pi startup proof rejects ${name} with a mismatched ${endpoint}`, () => {
      const sample = piStartup();
      const mismatched = { ...sample, backendSteps: sample.backendSteps.map(step => step.name === name
        ? { ...step, [endpoint]: step[endpoint]! + 1 } : step) };
      expect(() => backendStartupSamples("pi", mismatched, Array(5).fill(sample)), "PI_NATIVE_MILESTONES_MATCH_OBSERVED_TIMESTAMPS")
        .toThrow(`BACKEND_TIMING_MISSING_STEPS ${name}`);
    });
  }
}

test("a Pi first frame observed after the relay has no startup-bracket step", () => {
  const sample = piStartup(1800);
  expect(sample.backendSteps.filter(step => step.name === "first_backend_frame")).toEqual([]);
  expect(backendStartupSamples("pi", sample, Array(5).fill(sample)).firstAfterStart?.backendStartupMs).toBe(700);
});

test("the native Claude worker fixture preserves absent relay and SDK evidence", () => {
  const sample = claudeStartup();
  const output = backendStartupSamples("claude", sample, Array(5).fill(sample));
  expect(output.firstAfterStart?.invocationToRelayMs).toBeNull();
  expect(output.warm.map(row => row?.invocationToRelayMs)).toEqual([null, null, null, null, null]);
  expect(output.coverage, "CLAUDE_WORKER_FIXTURE_DOES_NOT_CLAIM_MODEL_STARTUP").toEqual({ worker: "native", sdk: "mock_query", firstRelayRequest: "not_exercised" });
});

test("native startup proof rejects a relay receipt without a startup breakdown", () => {
  const source = record(); source.openSubPhases = source.openSubPhases!.filter(step => step.name === "first_relay_request");
  const sample = lifecycleTimingSample(source)!;
  expect(() => backendStartupSamples("pi", sample, Array(5).fill(sample)), "NATIVE_STARTUP_BREAKDOWN_CANNOT_BE_ONLY_A_RECEIPT")
    .toThrow("BACKEND_TIMING_MISSING_STEPS");
});

for (const name of ["preparation", "host_probe", "worker_spawn", "bootstrap_imports", "resources", "session", "initialize"]) {
  test(`native Pi startup proof requires ${name} evidence on every warm sample`, () => {
    const sample = piStartup();
    expect(backendStartupSamples("pi", sample, Array(5).fill(sample)).firstAfterStart?.invocationToRelayMs).toBe(600);
    const missing = { ...sample, backendSteps: sample.backendSteps.filter(step => step.name !== name) };
    expect(() => backendStartupSamples("pi", sample, [sample, sample, missing, sample, sample]), "NATIVE_STARTUP_REQUIRES_EACH_PHASE")
      .toThrow(`BACKEND_TIMING_MISSING_STEPS ${name}`);
  });
}

test("native timing never infers relay receipt from failure or backfills historical evidence", () => {
  const failed = record(); failed.subPhases = []; failed.firstRelayRequestAt = null; failed.failureObservedAt = 1600;
  failed.openSubPhases = [{ phase: "backend", name: "worker_launch", startedAt: 1200, endedAt: null, elapsedMs: null }];
  expect(lifecycleTimingSample(failed)).toMatchObject({ invocationToRelayMs: null, steps: { "backend.worker_launch": 400 } });
  const historical = record(); delete historical.firstRelayRequestAt; delete historical.backendMissingEvidence; delete historical.subPhases; delete historical.openSubPhases;
  expect(lifecycleTimingSample(historical)).toMatchObject({ invocationToRelayMs: null, backendSteps: [], backendMissingEvidence: null });
  expect(lifecycleTimingSample(undefined)).toBeNull();
});
