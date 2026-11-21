import type { ActivityTurnLifecycle, ActivityTurnOpenSubPhase } from "@schlessera/brain-ui-sdk/protocol";

const UNOBSERVED_CLAUDE_STEPS: readonly string[] = ["runtime_to_sdk_init", "mcp_connect:*", "first_enqueue", "prompt_recorded", "first_relay_request"];

/** Admission proof is independent of any later backend startup evidence. */
export function requireAdmissionSteps(sample: ReturnType<typeof lifecycleTimingSample>, name: string): void {
  const fail = () => { throw Error(`OBSERVATION_TIMING_ADMISSION_STEPS_RECORDED ${name}`); };
  if (!sample || sample.governedAdmissionMs === null || !Number.isFinite(sample.governedAdmissionMs) || sample.governedAdmissionMs < 0
    || sample.journalBeginMs === null || !Number.isFinite(sample.journalBeginMs) || sample.journalBeginMs < 0) fail();
  for (const phase of ["governed", "journal"]) {
    if (!Object.entries(sample!.steps).some(([key, elapsed]) => key.startsWith(`${phase}.`)
      && elapsed !== null && Number.isFinite(elapsed) && elapsed >= 0)) fail();
  }
}

/** Project the persisted raw record for --observation-timing, without joining clock origins. */
export function lifecycleTimingSample(record: ActivityTurnLifecycle | undefined, coverage: "native" | "claude_worker_fixture" = "native") {
  if (!record) return null;
  const span = (start: number | null, end: number | null): number | null => {
    const terminal = end ?? record.failureObservedAt ?? record.endedAt;
    return start === null || terminal === null ? null : Math.max(0, terminal - start);
  };
  const steps: Record<string, number | null> = {};
  const source: ActivityTurnOpenSubPhase[] = [...(record.subPhases ?? []), ...(record.openSubPhases ?? [])];
  const observed = source.filter(step => coverage !== "claude_worker_fixture" || step.phase !== "backend"
    || !(UNOBSERVED_CLAUDE_STEPS.includes(step.name) || step.name.startsWith("mcp_connect:"))).map(step => {
    const elapsedMs = step.timeBase === "worker" ? step.workerElapsedMs ?? null
      : span(step.startedAt, step.endedAt ?? (step.phase === "backend" ? record.firstRelayRequestAt ?? null : null));
    const key = `${step.phase}.${step.name}`;
    steps[key] = elapsedMs === null ? steps[key] ?? null : (steps[key] ?? 0) + elapsedMs;
    return { ...step, elapsedMs };
  });
  return { turnId: record.turnId, backendInvokedAt: record.backendInvokedAt, firstFrameAt: record.firstFrameAt, endedAt: record.endedAt, firstRelayRequestAt: record.firstRelayRequestAt ?? null,
    queueWaitMs: span(record.acceptedAt, record.dequeuedAt),
    governedAdmissionMs: span(record.governedStartedAt, record.governedAcquiredAt),
    budgetAdmissionMs: span(record.budgetStartedAt, record.budgetAdmittedAt), journalBeginMs: span(record.journalStartedAt, record.journalBeganAt),
    backendStartupMs: span(record.backendInvokedAt, record.firstFrameAt), timeToFirstFrameMs: span(record.acceptedAt, record.firstFrameAt),
    // An absent first request must not turn into a claimed receipt at failure/turn end.
    invocationToRelayMs: record.backendInvokedAt === null || record.firstRelayRequestAt == null ? null : Math.max(0, record.firstRelayRequestAt - record.backendInvokedAt),
    backendSteps: observed.filter(step => step.phase === "backend"), backendMissingEvidence: record.backendMissingEvidence ?? null, steps };
}

/** The first and five warm samples of the native observation fixture. */
export function backendStartupSamples(backend: "claude" | "pi", firstAfterStart: ReturnType<typeof lifecycleTimingSample>, warm: ReturnType<typeof lifecycleTimingSample>[]) {
  if (warm.length !== 5) throw Error("BACKEND_TIMING_FIVE_WARM_TURNS");
  // hosted-app-child uses a hand-driven queryFn on Claude. Its worker is
  // real, but it never runs the SDK process or sends a model request.
  const workerNames = ["bootstrap_imports", "resources", "session", "initialize"];
  const required = backend === "claude" ? ["host_probe", "worker_host_probe", "worker_launch"]
    : ["preparation", "host_probe", "worker_spawn", ...workerNames];
  for (const sample of [firstAfterStart, ...warm]) {
    if (!sample) throw Error("BACKEND_TIMING_SAMPLE_MISSING");
    if (sample.backendInvokedAt === null || sample.firstFrameAt === null) throw Error("BACKEND_TIMING_MILESTONE_MISSING");
    if (backend === "pi" && (sample.invocationToRelayMs === null || !Number.isFinite(sample.invocationToRelayMs) || sample.invocationToRelayMs < 0))
      throw Error("BACKEND_TIMING_FIRST_RELAY_RECEIPT");
    if (backend === "claude" && sample.invocationToRelayMs !== null) throw Error("CLAUDE_WORKER_FIXTURE_MUST_NOT_CLAIM_RELAY_RECEIPT");
    const missing = required.filter(name => !sample.backendSteps.some(step => step.name === name && step.endedAt !== null
      && step.elapsedMs !== null && Number.isFinite(step.elapsedMs) && step.elapsedMs >= 0
      && (workerNames.includes(name) ? step.timeBase === "worker" && step.workerElapsedMs === step.elapsedMs : step.timeBase === undefined)));
    const milestones: Array<[string, number]> = [];
    if (backend === "pi" && sample.firstRelayRequestAt !== null) milestones.push(["first_relay_request", sample.firstRelayRequestAt]);
    // Equal milliseconds do not reveal which callback ran first. The lifecycle
    // may legitimately omit the frame step when relay receipt won that race.
    if (sample.firstRelayRequestAt === null || sample.firstFrameAt < sample.firstRelayRequestAt
      || sample.backendSteps.some(step => step.name === "first_backend_frame"))
      milestones.push(["first_backend_frame", sample.firstFrameAt]);
    for (const [name, at] of milestones) {
      if (!sample.backendSteps.some(step => step.name === name && step.timeBase === undefined && step.startedAt === sample.backendInvokedAt
        && step.endedAt === at && step.elapsedMs === Math.max(0, at - sample.backendInvokedAt!))) missing.push(name);
    }
    if (missing.length) throw Error(`BACKEND_TIMING_MISSING_STEPS ${missing.join(",")}`);
    // Worker durations keep their own clock; only their host observation point
    // belongs in this bracket. Claude's shell fixture has no relay receipt;
    // prompt_prefix can open Activity before launch, so its upper bound is the
    // observed turn end, never the first Activity frame.
    const boundary = backend === "claude" ? sample.endedAt : sample.firstRelayRequestAt;
    if (boundary === null || !Number.isFinite(boundary)) throw Error("BACKEND_TIMING_BOUNDARY_MISSING");
    for (const step of sample.backendSteps) {
      if (!Number.isFinite(step.startedAt) || step.startedAt < sample.backendInvokedAt || step.startedAt > boundary
        || step.endedAt !== null && (!Number.isFinite(step.endedAt) || step.endedAt < step.startedAt || step.endedAt > boundary))
        throw Error(`BACKEND_TIMING_OUTSIDE_STARTUP ${step.name}`);
      if (step.timeBase === "worker" && step.startedAt !== step.endedAt)
        throw Error(`BACKEND_TIMING_WORKER_RECEIPT_POINT ${step.name}`);
    }
  }
  return { clock: "host epoch timestamps; timeBase=worker uses workerElapsedMs, never subtracted from host time", backend,
    coverage: backend === "claude" ? { worker: "native", sdk: "mock_query", firstRelayRequest: "not_exercised" }
      : { worker: "native", sdk: "native", firstRelayRequest: "required" },
    unobserved: backend === "claude" ? [...UNOBSERVED_CLAUDE_STEPS] : [],
    firstAfterStart, warm };
}
