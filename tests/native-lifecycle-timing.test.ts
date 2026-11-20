import { expect, test } from "bun:test";
import type { ActivityTurnLifecycle } from "@schlessera/brain-ui-sdk/protocol";
import { lifecycleTimingSample } from "../scripts/native-proof/lifecycle-timing.js";

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
      { phase: "backend", name: "host_probe", startedAt: 1100, endedAt: 1200, elapsedMs: null },
      { phase: "backend", name: "resources", startedAt: 1500, endedAt: 1500, elapsedMs: null, timeBase: "worker", workerElapsedMs: 340 },
      { phase: "backend", name: "first_relay_request", startedAt: 1100, endedAt: 1700, elapsedMs: null },
    ] };
}

test("native observation timing projects backend host steps, worker durations and missing SDK evidence", () => {
  const sample = lifecycleTimingSample(record())!;
  expect(sample.invocationToRelayMs).toBe(600);
  expect(sample.backendStartupMs).toBe(500);
  expect(sample.steps, "NATIVE_BACKEND_TIMING_USES_OBSERVED_CLOCK").toEqual({ "governed.gate_acquire": 100,
    "backend.host_probe": 100, "backend.resources": 340, "backend.first_relay_request": 600 });
  expect(sample.backendSteps).toHaveLength(3);
  expect(sample.backendSteps[1]).toEqual({ phase: "backend", name: "resources", startedAt: 1500, endedAt: 1500,
    elapsedMs: 340, timeBase: "worker", workerElapsedMs: 340 });
  expect(sample.backendMissingEvidence).toEqual(["mcp_connect:brain", "first_enqueue", "prompt_recorded"]);
});

test("native timing never infers relay receipt from failure or backfills historical evidence", () => {
  const failed = record(); failed.firstRelayRequestAt = null; failed.failureObservedAt = 1600;
  failed.subPhases = [{ phase: "backend", name: "worker_launch", startedAt: 1200, endedAt: null, elapsedMs: null }];
  expect(lifecycleTimingSample(failed)).toMatchObject({ invocationToRelayMs: null, steps: { "backend.worker_launch": 400 } });
  const historical = record(); delete historical.firstRelayRequestAt; delete historical.backendMissingEvidence; delete historical.subPhases;
  expect(lifecycleTimingSample(historical)).toMatchObject({ invocationToRelayMs: null, backendSteps: [], backendMissingEvidence: null });
  expect(lifecycleTimingSample(undefined)).toBeNull();
});
