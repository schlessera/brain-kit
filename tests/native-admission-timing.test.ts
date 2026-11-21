import { expect, test } from "bun:test";
import type { ActivityTurnLifecycle } from "@schlessera/brain-ui-sdk/protocol";
import { admissionTimingSample } from "../scripts/native-proof/admission-timing";

test("small observation output keeps its original admission-only shape", () => {
  const record: ActivityTurnLifecycle = { lifecycleId: "lifecycle:ithaca", turnId: "ithaca", sessionId: "ithaca", backendRunId: null,
    hostEvents: [], skippedPhases: [], acceptedAt: 1000, dequeuedAt: 1010, governedStartedAt: 1010, governedAcquiredAt: 1020,
    budgetStartedAt: null, budgetAdmittedAt: null, journalStartedAt: 1020, journalBeganAt: 1030, backendInvokedAt: 1030,
    firstFrameAt: 1040, failureObservedAt: null, endedAt: 1200, outcome: "success", reason: null, totalElapsedMs: null,
    timeToFirstFrameMs: null, queueWaitMs: null, governedAdmissionMs: null, budgetAdmissionMs: null, journalBeginMs: null, backendStartupMs: null,
    subPhases: [{ phase: "governed", name: "sandbox_resolve", startedAt: 1010, endedAt: 1015, elapsedMs: null }],
    openSubPhases: [{ phase: "closing", name: "journal_finish", startedAt: 1100, endedAt: 1200, elapsedMs: null }] };
  expect(admissionTimingSample(record), "SMALL_SCENARIO_OUTPUT_IS_UNCHANGED").toEqual({ turnId: "ithaca", queueWaitMs: 10,
    governedAdmissionMs: 10, budgetAdmissionMs: null, journalBeginMs: 10, backendStartupMs: 10, timeToFirstFrameMs: 40,
    steps: { "governed.sandbox_resolve": 5 } });
});
