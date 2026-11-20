import type { ActivityTurnLifecycle, ActivityTurnOpenSubPhase } from "@schlessera/brain-ui-sdk/protocol";

/** Project the persisted raw record for --observation-timing, without joining clock origins. */
export function lifecycleTimingSample(record: ActivityTurnLifecycle | undefined) {
  if (!record) return null;
  const span = (start: number | null, end: number | null): number | null => {
    const terminal = end ?? record.failureObservedAt ?? record.endedAt;
    return start === null || terminal === null ? null : Math.max(0, terminal - start);
  };
  const steps: Record<string, number | null> = {};
  const source: ActivityTurnOpenSubPhase[] = [...(record.subPhases ?? []), ...(record.openSubPhases ?? [])];
  const observed = source.map(step => {
    const elapsedMs = step.timeBase === "worker" ? step.workerElapsedMs ?? null
      : span(step.startedAt, step.endedAt ?? (step.phase === "backend" ? record.firstRelayRequestAt ?? null : null));
    const key = `${step.phase}.${step.name}`;
    steps[key] = elapsedMs === null ? steps[key] ?? null : (steps[key] ?? 0) + elapsedMs;
    return { ...step, elapsedMs };
  });
  return { turnId: record.turnId, queueWaitMs: span(record.acceptedAt, record.dequeuedAt),
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
    const missing = required.filter(name => !sample.backendSteps.some(step => step.name === name && step.endedAt !== null
      && step.elapsedMs !== null && Number.isFinite(step.elapsedMs) && step.elapsedMs >= 0
      && (!workerNames.includes(name) || step.timeBase === "worker" && step.workerElapsedMs === step.elapsedMs)));
    if (missing.length) throw Error(`BACKEND_TIMING_MISSING_STEPS ${missing.join(",")}`);
    if (backend === "pi" && (sample.invocationToRelayMs === null || !Number.isFinite(sample.invocationToRelayMs) || sample.invocationToRelayMs < 0))
      throw Error("BACKEND_TIMING_FIRST_RELAY_RECEIPT");
    if (backend === "claude" && sample.invocationToRelayMs !== null) throw Error("CLAUDE_WORKER_FIXTURE_MUST_NOT_CLAIM_RELAY_RECEIPT");
  }
  return { clock: "host epoch timestamps; timeBase=worker uses workerElapsedMs, never subtracted from host time", backend,
    coverage: backend === "claude" ? { worker: "native", sdk: "mock_query", firstRelayRequest: "not_exercised" }
      : { worker: "native", sdk: "native", firstRelayRequest: "required" },
    unobserved: backend === "claude" ? ["runtime_to_sdk_init", "mcp_connect:*", "first_enqueue", "prompt_recorded", "first_relay_request"] : [],
    firstAfterStart, warm };
}
