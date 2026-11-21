import { expect, test } from "bun:test";
import type { ActivityTurnLifecycle } from "@schlessera/brain-ui-sdk/protocol";
import { admissionTimingSample } from "../scripts/native-proof/admission-timing";

test("default observation output keeps the integration base backend samples", () => {
  const record: ActivityTurnLifecycle = { lifecycleId: "lifecycle:ithaca", turnId: "ithaca", sessionId: "ithaca", backendRunId: null,
    hostEvents: [], skippedPhases: [], acceptedAt: 1000, dequeuedAt: 1010, governedStartedAt: 1010, governedAcquiredAt: 1020,
    budgetStartedAt: null, budgetAdmittedAt: null, journalStartedAt: 1020, journalBeganAt: 1030, backendInvokedAt: 1030,
    firstRelayRequestAt: 1038, backendMissingEvidence: ["mcp_connect:brain"], firstFrameAt: 1040, failureObservedAt: null, endedAt: 1200, outcome: "success", reason: null, totalElapsedMs: null,
    timeToFirstFrameMs: null, queueWaitMs: null, governedAdmissionMs: null, budgetAdmissionMs: null, journalBeginMs: null, backendStartupMs: null,
    subPhases: [{ phase: "governed", name: "sandbox_resolve", startedAt: 1010, endedAt: 1015, elapsedMs: null }],
    openSubPhases: [{ phase: "backend", name: "host_probe", startedAt: 1030, endedAt: 1035, elapsedMs: null }, { phase: "closing", name: "journal_finish", startedAt: 1100, endedAt: 1200, elapsedMs: null }] };
  expect(admissionTimingSample(record), "INTEGRATION_BASE_BACKEND_SAMPLES_ARE_PRESERVED").toEqual({ turnId: "ithaca", backendInvokedAt: 1030, firstFrameAt: 1040, endedAt: 1200, firstRelayRequestAt: 1038, invocationToRelayMs: 8,
    governedStartedAt: 1010, governedAcquiredAt: 1020, journalStartedAt: 1020, journalBeganAt: 1030,
    admissionSteps: record.subPhases!, backendEvidenceOmitted: null,
    backendMissingEvidence: ["mcp_connect:brain"], backendSteps: [{ phase: "backend", name: "host_probe", startedAt: 1030, endedAt: 1035, elapsedMs: 5 }], queueWaitMs: 10,
    governedAdmissionMs: 10, budgetAdmissionMs: null, journalBeginMs: 10, backendStartupMs: 10, timeToFirstFrameMs: 40,
    steps: { "governed.sandbox_resolve": 5, "backend.host_probe": 5 } });
});

test("the hosted default backend startup projection excludes closing steps as on the base", async () => {
  const source = await Bun.file(new URL("../scripts/native-proof/hosted-app.test.ts", import.meta.url)).text();
  const declaration = source.slice(source.indexOf("const startupSample ="), source.indexOf("\n", source.indexOf("const startupSample =")));
  const code = new Bun.Transpiler({ loader: "ts" }).transformSync(declaration);
  const { lifecycleTimingSample } = await import("../scripts/native-proof/lifecycle-timing");
  const project = new Function("admissionTimingSample", "lifecycleTimingSample", "BACKEND", `${code}; return startupSample;`)(admissionTimingSample, lifecycleTimingSample, "pi");
  const record = { turnId: "ithaca", acceptedAt: 1000, backendInvokedAt: 1000, firstFrameAt: 1030, endedAt: 1100,
    subPhases: [], openSubPhases: [{ phase: "backend", name: "host_probe", startedAt: 1000, endedAt: 1010, elapsedMs: null },
      { phase: "closing", name: "egress_settle", startedAt: 1050, endedAt: 1100, elapsedMs: null }] } as unknown as ActivityTurnLifecycle;
  expect(project(record), "DEFAULT_BACKEND_STARTUP_RETAINS_BASE_OUTPUT").toEqual(admissionTimingSample(record));
  expect(project(record).steps).toEqual({ "backend.host_probe": 10 });
});
