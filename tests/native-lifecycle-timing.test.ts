import { expect, test } from "bun:test";
import type { ActivityTurnLifecycle } from "@schlessera/brain-ui-sdk/protocol";
import { backendStartupSamples, lifecycleTimingSample } from "../scripts/native-proof/lifecycle-timing.js";

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

function piStartup() {
  const source = record();
  source.openSubPhases = ["preparation", "host_probe", "worker_spawn", "first_relay_request"].map(name => ({
    phase: "backend", name, startedAt: 1100, endedAt: 1700, elapsedMs: null,
  }));
  source.openSubPhases.push(...["bootstrap_imports", "resources", "session", "initialize"].map(name => ({
    phase: "backend", name, startedAt: 1500, endedAt: 1500, elapsedMs: null, timeBase: "worker" as const, workerElapsedMs: 31,
  })));
  return lifecycleTimingSample(source)!;
}

test("the native Claude worker fixture preserves absent relay and SDK evidence", () => {
  const source = record(); source.firstRelayRequestAt = null;
  source.openSubPhases = ["host_probe", "worker_host_probe", "worker_launch"].map(name => ({
    phase: "backend", name, startedAt: 1100, endedAt: 1500, elapsedMs: null,
  }));
  const sample = lifecycleTimingSample(source)!;
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
