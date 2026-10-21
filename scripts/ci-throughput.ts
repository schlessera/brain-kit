/** Descriptive integration outcomes, explicit assumptions, and coordination evidence. */
import { seconds, stats, percentage } from "./ci-timing-stats";
import type { TimingAPI, TimingSnapshot } from "./ci-timings";
import type { LeaseObservation } from "./ci-coordination";

export interface PullObservation {
  version: 1; repository: string; number: number; collectedAt: string;
  createdAt: string; mergedAt: string | null; closedAt: string | null; head: string;
  merge: string | null; baseBranch: string; changedFiles: number; additions: number; deletions: number;
  timeline: { event: string; at: string }[]; problems: string[];
  mergeObject?: { sha: string; tree: string; parents: string[] };
}
export interface WorkEvent {
  version: 1; id: string; repository: string; kind: "work-started" | "work-finished" | "wait-started" | "wait-finished" | "failure-classified" | "incident" | "revert";
  at: string; worker?: string; task?: string; reason?: "reservation" | "ci" | "review" | "conflict" | "other";
  pr?: number; run?: number; attempt?: number; job?: number; relatedPR?: number;
  classification?: "product" | "test" | "infrastructure" | "stale-candidate" | "intentional-feedback";
  evidence?: string;
}
export interface Scenario { failedPRFraction: number; additionalPushes: number; failedRunCostFraction: number; failedRunElapsedFraction?: number; }
export interface AnalysisWindow { since: string; until: string; source: string; }
type Interval = { start: number; end: number };
const SHA = /^[a-f0-9]{40}$/;
const stamp = (x: unknown): x is string => typeof x === "string" && Number.isFinite(Date.parse(x));
const number = (x: unknown): x is number => Number.isSafeInteger(x) && (x as number) > 0;
const ci = (s: TimingSnapshot) => s.run.path === ".github/workflows/ci.yml";
const execution = (s: TimingSnapshot) => s.jobs.reduce((n, j) => n + (j.seconds ?? 0), 0);
function completed(s: TimingSnapshot): number | null {
  if (s.problems.length || s.run.status !== "completed") return null;
  const ends = s.jobs.filter(j => j.execution === "observed" && stamp(j.completedAt)).map(j => Date.parse(j.completedAt!));
  return ends.length ? Math.max(...ends) : null;
}
function green(s: TimingSnapshot): boolean {
  return s.run.conclusion === "success" && completed(s) !== null && s.jobs.some(j => j.category === "proof" && j.name !== "draft gates" && j.conclusion === "success");
}

/** Only public operational references and opaque coordination IDs are retained. */
export function validateWorkEvent(value: unknown): WorkEvent {
  const e = value as WorkEvent;
  const allowed = new Set(["version", "id", "repository", "kind", "at", "worker", "task", "reason", "pr", "run", "attempt", "job", "relatedPR", "classification", "evidence"]);
  if (!e || typeof e !== "object" || Object.keys(e).some(k => !allowed.has(k)) || e.version !== 1 ||
    typeof e.id !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(e.id) || !/^[\w.-]+\/[\w.-]+$/.test(e.repository) || !stamp(e.at) ||
    !["work-started", "work-finished", "wait-started", "wait-finished", "failure-classified", "incident", "revert"].includes(e.kind)) throw new Error("Invalid coordination event");
  for (const field of ["pr", "run", "attempt", "job", "relatedPR"] as const) if (e[field] !== undefined && !number(e[field])) throw new Error(`Invalid event ${field}`);
  if (/^(work|wait)-/.test(e.kind)) {
    if (![e.worker, e.task].every(x => typeof x === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(x))) throw new Error("Opaque worker/task IDs required");
    if (e.kind.startsWith("wait-") && !["reservation", "ci", "review", "conflict", "other"].includes(e.reason ?? "")) throw new Error("Wait reason required");
  } else {
    if (typeof e.evidence !== "string" || !e.evidence.startsWith(`https://github.com/${e.repository}/`) ||
      !/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/(?:issues|pull|actions\/runs)\/\d+(?:[/?#][^\s]*)?$/.test(e.evidence)) throw new Error("Public repository evidence required");
    if (e.kind === "failure-classified" && (!number(e.run) || !number(e.attempt) ||
      !["product", "test", "infrastructure", "stale-candidate", "intentional-feedback"].includes(e.classification ?? ""))) throw new Error("Run/attempt and failure classification required");
    if (["incident", "revert"].includes(e.kind) && !number(e.pr)) throw new Error("Affected PR required");
  }
  return Object.fromEntries([...allowed].filter(k => (e as unknown as Record<string, unknown>)[k] !== undefined)
    .map(k => [k, (e as unknown as Record<string, unknown>)[k]])) as unknown as WorkEvent;
}

/** Record lifecycle/size without authors, titles, bodies or deployment context. */
export async function collectPullObservation(api: TimingAPI, repository: string, pr: number, now = new Date().toISOString()): Promise<PullObservation> {
  const p = await api.json(`pulls/${pr}`);
  if (p.number !== pr || p.base?.repo?.full_name !== repository || !SHA.test(p.head?.sha) || !stamp(p.created_at) ||
    ![p.changed_files, p.additions, p.deletions].every(x => Number.isSafeInteger(x) && x >= 0)) throw new Error("Invalid PR lifecycle identity");
  const row: PullObservation = { version: 1, repository, number: pr, collectedAt: now, createdAt: p.created_at,
    mergedAt: p.merged_at ?? null, closedAt: p.closed_at ?? null, head: p.head.sha, merge: p.merged_at ? p.merge_commit_sha : null,
    baseBranch: p.base.ref, changedFiles: p.changed_files, additions: p.additions, deletions: p.deletions, timeline: [], problems: [] };
  try {
    for (let page = 1; ; page++) {
      const events = await api.json(`issues/${pr}/timeline?per_page=100&page=${page}`);
      if (!Array.isArray(events)) throw new Error("Invalid PR timeline");
      for (const e of events) if (["ready_for_review", "convert_to_draft", "converted_to_draft", "reopened", "closed", "merged"].includes(e.event) && stamp(e.created_at)) row.timeline.push({ event: e.event, at: e.created_at });
      if (events.length < 100) break;
    }
  } catch (e) { row.problems.push(`Timeline unavailable: ${String(e)}`); }
  if (row.merge) {
    try {
      const object = await api.json(`git/commits/${row.merge}`);
      if (object.sha !== row.merge || !SHA.test(object.tree?.sha) || !Array.isArray(object.parents) || object.parents.some((p: any) => !SHA.test(p.sha))) throw new Error("Invalid immutable squash identity");
      row.mergeObject = { sha: object.sha, tree: object.tree.sha, parents: object.parents.map((p: any) => p.sha) };
    } catch (e) { row.problems.push(`Squash identity unavailable: ${String(e)}`); }
  }
  return row;
}

export function mergeIntervals(input: Interval[]): Interval[] {
  const result: Interval[] = [];
  for (const i of input.filter(i => Number.isFinite(i.start) && Number.isFinite(i.end) && i.end > i.start).sort((a, b) => a.start - b.start)) {
    const last = result.at(-1);
    if (last && i.start <= last.end) last.end = Math.max(last.end, i.end);
    else result.push({ ...i });
  }
  return result;
}
/** Time-weighted occupancy, with end-exclusive intervals and an explicit window. */
export function concurrency(input: Interval[], window: AnalysisWindow) {
  const since = Date.parse(window.since), until = Date.parse(window.until), changes = new Map<number, number>();
  let used = 0, active = 0, overlap = 0, peak = 0, current = 0, previous = since;
  for (const i of input) {
    const start = Math.max(since, i.start), end = Math.min(until, i.end);
    if (!(end > start)) continue;
    changes.set(start, (changes.get(start) ?? 0) + 1); changes.set(end, (changes.get(end) ?? 0) - 1);
  }
  for (const [time, change] of [...changes].sort(([a], [b]) => a - b)) {
    const duration = (time - previous) / 1000;
    used += current * duration; if (current) active += duration; if (current > 1) overlap += duration;
    current += change; peak = Math.max(peak, current); previous = time;
  }
  return { intervals: input.length, peak, summedSeconds: used, activeWallSeconds: active,
    averageWhileActive: active ? used / active : null, averageAcrossWindow: until > since ? used / ((until - since) / 1000) : null,
    overlappingActiveTime: percentage(overlap, active) };
}

export function summarizeThroughput(snapshots: TimingSnapshot[], pulls: PullObservation[], events: WorkEvent[], window: AnalysisWindow,
  fullRun: { runnerSeconds: number | null; elapsedSeconds: number | null; samples: number }, scenario: Scenario, leases?: LeaseObservation[]) {
  const since = Date.parse(window.since), until = Date.parse(window.until);
  if (!Number.isFinite(since) || !Number.isFinite(until) || until <= since) throw new Error("Throughput needs a positive analysis window");
  if (![scenario.failedPRFraction, scenario.failedRunCostFraction].every(x => Number.isFinite(x) && x >= 0 && x <= 1) ||
    !Number.isFinite(scenario.additionalPushes) || scenario.additionalPushes < 0 ||
    (scenario.failedRunElapsedFraction !== undefined && (!Number.isFinite(scenario.failedRunElapsedFraction) || scenario.failedRunElapsedFraction < 0 || scenario.failedRunElapsedFraction > 1))) throw new Error("Invalid full-proof scenario");
  if (new Set([...snapshots.map(s => s.repository), ...pulls.map(p => p.repository), ...events.map(e => e.repository)]).size > 1) throw new Error("Throughput requires one repository");
  const rows = snapshots.filter(ci), inWindow = (time: number) => time >= since && time < until;
  const seenEvents = new Map<string, WorkEvent>();
  for (const raw of events) {
    const e = validateWorkEvent(raw), old = seenEvents.get(e.id);
    if (old && JSON.stringify(old) !== JSON.stringify(e)) throw new Error("Conflicting coordination event ID");
    seenEvents.set(e.id, e);
  }
  events = [...seenEvents.values()].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const delivered = pulls.filter(p => p.mergedAt && inWindow(Date.parse(p.mergedAt)) && p.baseBranch === "main");
  const ordered = (values: TimingSnapshot[]) => [...values].sort((a, b) => Date.parse(a.run.createdAt) - Date.parse(b.run.createdAt) || a.run.id - b.run.id || a.run.attempt - b.run.attempt);
  const prRows = delivered.map(p => {
    const mergeAt = Date.parse(p.mergedAt!), pre = rows.filter(s => s.run.event === "pull_request" && s.run.prs.length === 1 && s.run.prs[0] === p.number && Date.parse(s.run.createdAt) <= mergeAt);
    const main = ordered(rows.filter(s => s.run.event === "push" && s.run.head === p.merge));
    const first = main[0], firstComplete = first && first.run.attempt === 1 && first.run.status === "completed" && !first.problems.length;
    const postGreen = main.filter(green).sort((a, b) => completed(a)! - completed(b)!)[0];
    const preGreen = pre.filter(s => green(s) && s.run.head === p.head && completed(s)! <= mergeAt).sort((a, b) => completed(b)! - completed(a)!)[0];
    const transition = p.problems.some(e => e.startsWith("Timeline")) ? undefined : p.timeline.filter(e =>
      ["ready_for_review", "convert_to_draft", "converted_to_draft"].includes(e.event) && Date.parse(e.at) <= mergeAt).sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0];
    const ready = transition?.event === "ready_for_review" ? transition : undefined;
    const firstOutcome = !first || !firstComplete ? "unknown" : green(first) ? "success" : first.run.conclusion === "success" ? "unconfirmed-success" : first.run.conclusion ?? "unknown";
    const equivalence = !preGreen?.candidate || !p.mergeObject ? "unknown" :
      p.mergeObject.parents.length === 1 && p.mergeObject.parents[0] === preGreen.candidate.base && p.mergeObject.tree === preGreen.candidate.checkout.tree ? "matches-recorded-receipt" : "differs-from-recorded-receipt";
    return { number: p.number, mergedAt: p.mergedAt!, changedFiles: p.changedFiles, changedLines: p.additions + p.deletions,
      preAttempts: pre.length, observedHeads: new Set(pre.map(s => s.run.head)).size, postAttempts: main.length,
      firstMainOutcome: firstOutcome, firstMain: first ? { run: first.run.id, attempt: first.run.attempt } : null,
      firstMainFailedJobs: first?.jobs.filter(j => j.conclusion === "failure").map(j => ({ id: j.id, category: j.category })) ?? [],
      sameSourceRecovery: firstOutcome !== "unknown" && firstOutcome !== "success" && !!postGreen,
      priorGreenAggregate: !!preGreen, greenBeforeNonGreenMain: !!preGreen && !["success", "unknown"].includes(firstOutcome),
      createToMergeSeconds: seconds(p.createdAt, p.mergedAt), readyToMergeSeconds: seconds(ready?.at, p.mergedAt),
      gateToMergeSeconds: preGreen ? seconds(new Date(completed(preGreen)!).toISOString(), p.mergedAt) : null,
      mergeToGreenSeconds: postGreen ? seconds(p.mergedAt, new Date(completed(postGreen)!).toISOString()) : null,
      observedRunnerSeconds: [...pre, ...main].reduce((n, s) => n + execution(s), 0),
      equivalence, incidents: events.filter(e => ["incident", "revert"].includes(e.kind) && e.pr === p.number).map(e => e.id) };
  });
  const firstKnown = prRows.filter(p => p.firstMainOutcome !== "unknown"), firstGreen = prRows.filter(p => p.firstMainOutcome === "success");
  const eventual = prRows.filter(p => p.mergeToGreenSeconds !== null), paired = prRows.filter(p => p.preAttempts && p.postAttempts);
  const jobIntervals = rows.flatMap(s => s.jobs.filter(j => j.execution === "observed" && stamp(j.startedAt) && stamp(j.completedAt))
    .map(j => ({ start: Date.parse(j.startedAt!), end: Date.parse(j.completedAt!) })));
  const byPR = new Map<number, Interval[]>();
  for (const s of rows) if (s.run.event === "pull_request" && s.run.prs.length === 1 && completed(s) !== null && stamp(s.run.startedAt)) {
    const id = s.run.prs[0]!, list = byPR.get(id) ?? []; list.push({ start: Date.parse(s.run.startedAt!), end: completed(s)! }); byPR.set(id, list);
  }
  const work: Interval[] = [], workByWorker = new Map<string, Interval[]>();
  const waits: Record<string, number[]> = {}, open = new Map<string, WorkEvent>(); let unmatched = 0;
  for (const e of events) if (/^(work|wait)-/.test(e.kind)) {
    const key = `${e.worker}/${e.task}/${e.kind.split("-")[0]}/${e.reason ?? ""}`;
    if (e.kind.endsWith("started")) { if (open.has(key)) unmatched++; open.set(key, e); }
    else {
      const start = open.get(key); open.delete(key);
      if (!start) { unmatched++; continue; }
      const interval = { start: Date.parse(start.at), end: Date.parse(e.at) };
      if (e.kind === "work-finished") {
        work.push(interval); const list = workByWorker.get(e.worker!) ?? []; list.push(interval); workByWorker.set(e.worker!, list);
      }
      else (waits[e.reason!] ??= []).push((interval.end - interval.start) / 1000);
    }
  }
  unmatched += open.size;
  const delays: number[] = [], categories = new Set(["verify", "pack", "unit", "browser", "layout", "captures", "runtime", "runtime_host", "endurance"]);
  for (const s of rows) {
    const metadata = s.jobs.find(j => j.category === "changeset" && j.execution === "observed" && stamp(j.completedAt));
    if (!metadata) continue;
    for (const j of s.jobs) if (categories.has(j.category) && j.execution === "observed") {
      const delay = seconds(metadata.completedAt, j.startedAt); if (delay !== null) delays.push(delay);
    }
  }
  const equivalentRuns = 2 + scenario.failedPRFraction * scenario.additionalPushes * scenario.failedRunCostFraction;
  const elapsedFraction = scenario.failedRunElapsedFraction ?? scenario.failedRunCostFraction;
  const equivalentElapsedRuns = 2 + scenario.failedPRFraction * scenario.additionalPushes * elapsedFraction;
  const estimate = fullRun.runnerSeconds === null ? null : paired.length * equivalentRuns * fullRun.runnerSeconds;
  const actual = paired.reduce((n, p) => n + p.observedRunnerSeconds, 0);
  const failed = rows.filter(s => s.run.conclusion === "failure"), classified = new Set(events.filter(e => e.kind === "failure-classified").map(e => `${e.run}/${e.attempt}`));
  const reservationIntervals = (leases ?? []).map(l => ({ start: l.acquired, end: Math.min(l.expires, l.cap, l.endedAt ?? Infinity) }));
  const reservations = leases ? concurrency(mergeIntervals(reservationIntervals), window) : null;
  let candidateJobSeconds = 0;
  for (const l of leases ?? []) {
    const start = Math.max(since, l.acquired), end = Math.min(until, l.expires, l.cap, l.endedAt ?? Infinity);
    const intervals = rows.filter(s => s.run.event === "pull_request" && s.run.head === l.head && s.run.prs.includes(l.pr)).flatMap(s =>
      s.jobs.filter(j => j.execution === "observed" && stamp(j.startedAt) && stamp(j.completedAt)).map(j =>
        ({ start: Math.max(start, Date.parse(j.startedAt!)), end: Math.min(end, Date.parse(j.completedAt!)) })));
    candidateJobSeconds += mergeIntervals(intervals).reduce((n, i) => n + (i.end - i.start) / 1000, 0);
  }
  const durations = (key: "createToMergeSeconds" | "readyToMergeSeconds" | "gateToMergeSeconds" | "mergeToGreenSeconds") => stats(prRows.flatMap(p => p[key] === null ? [] : [p[key]!]));
  const categoriesFailed = [...new Set(prRows.flatMap(p => p.firstMainFailedJobs.map(j => j.category)))];
  return { objective: "Increase first-pass green integrations per day while preserving required proof and monitoring post-merge recovery/incident outcomes", window,
    coverage: { lifecyclePRs: pulls.length, lifecycleProblems: pulls.filter(p => p.problems.length).map(p => ({ pr: p.number, problems: p.problems })),
      mergedInWindow: delivered.length, firstMainUnknown: prRows.length - firstKnown.length, pairedCostPRs: paired.length,
      unmatchedCoordinationEvents: unmatched, recordedWorkers: workByWorker.size },
    velocity: { mergedPerDay: delivered.length / ((until - since) / 86400000), firstPassGreenPerDay: firstGreen.length / ((until - since) / 86400000),
      firstPassGreen: percentage(firstGreen.length, firstKnown.length), sameCommitObservedGreen: percentage(eventual.length, delivered.length),
      runnerMinutesPerObservedGreenIntegration: eventual.length ? prRows.reduce((n, p) => n + p.observedRunnerSeconds, 0) / 60 / eventual.length : null,
      createToMergeSeconds: durations("createToMergeSeconds"), readyToMergeSeconds: durations("readyToMergeSeconds"),
      gateToMergeSeconds: durations("gateToMergeSeconds"), mergeToGreenSeconds: durations("mergeToGreenSeconds") },
    reliability: { firstMainOutcomes: Object.fromEntries([...new Set(prRows.map(p => p.firstMainOutcome))].map(k => [k, prRows.filter(p => p.firstMainOutcome === k).length])),
      sameSourceRecoveries: prRows.filter(p => p.sameSourceRecovery).length,
      firstMainFailedJobCategories: Object.fromEntries(categoriesFailed.map(c => [c, prRows.filter(p => p.firstMainFailedJobs.some(j => j.category === c)).length])),
      preGreenMainNonGreen: percentage(prRows.filter(p => p.greenBeforeNonGreenMain).length, prRows.filter(p => p.priorGreenAggregate && p.firstMainOutcome !== "unknown").length),
      classifiedFailedAttempts: percentage(failed.filter(s => classified.has(`${s.run.id}/${s.run.attempt}`)).length, failed.length),
      classificationRecords: events.filter(e => e.kind === "failure-classified").map(e => ({ id: e.id, run: e.run, attempt: e.attempt, job: e.job, classification: e.classification, evidence: e.evidence })),
      explicitIncidentOrRevertRecords: events.filter(e => ["incident", "revert"].includes(e.kind)).length,
      incidentRate: null, note: "No incident records does not establish no incidents. Green-main discordance is not a diagnosed escaped defect; same-source recovery is not a diagnosed flaky test." },
    parallelism: { ciJobs: concurrency(jobIntervals, window), distinctPRVerification: concurrency([...byPR.values()].flatMap(mergeIntervals), window),
      recordedWorkers: workByWorker.size ? concurrency([...workByWorker.values()].flatMap(mergeIntervals), window) : null,
      completedWorkIntervals: work.length, dependencyToJobStartSeconds: stats(delays), waits: Object.fromEntries(Object.entries(waits).map(([k, v]) => [k, stats(v)])),
      note: "Job concurrency is not agent concurrency; observed dependency-to-start delay includes dispatch/queue, not a measured runner-capacity limit." },
    reservation: reservations ? { ...reservations, leases: leases!.length,
      occupiedWindow: percentage(reservations.activeWallSeconds, (until - since) / 1000),
      withoutObservedCandidateJobSeconds: Math.max(0, reservations.activeWallSeconds - candidateJobSeconds),
      note: "Authorized reservation lifetime comes from append-only Git history, including protocol-inferred expiry. Time without observed jobs includes queue, admission, merge/verification and missing execution observations; it is not proven waste or caller wait." } : null,
    evidence: { contextualCadence: percentage(rows.filter(s => s.context).length, rows.length), finalCandidateReceipts: percentage(prRows.filter(p => p.equivalence !== "unknown").length, prRows.length),
      evidenceProblems: rows.filter(s => s.evidenceProblem).map(s => ({ run: s.run.id, attempt: s.run.attempt, problem: s.evidenceProblem })),
      squashComparedToRecordedReceipt: { matches: prRows.filter(p => p.equivalence === "matches-recorded-receipt").length, differs: prRows.filter(p => p.equivalence === "differs-from-recorded-receipt").length, unknown: prRows.filter(p => p.equivalence === "unknown").length },
      independentlyValidatedFullGuarantees: null, note: "Receipt/aggregate observations are not independent validation of all selected job checkouts, retained inputs, branch rules or correctness. Existing merge gates remain authoritative." },
    scenario: { assumptions: scenario, baselineSamples: fullRun.samples, pairedPRs: paired.length, equivalentFullRunsPerPR: equivalentRuns,
      failedRunElapsedFractionUsed: elapsedFraction,
      estimatedRunnerSeconds: estimate, observedRunnerSeconds: actual,
      estimatedSavingPercent: estimate && estimate > 0 ? 100 * (estimate - actual) / estimate : null,
      estimatedSerialTestElapsedPerPR: fullRun.elapsedSeconds === null ? null : equivalentElapsedRuns * fullRun.elapsedSeconds,
      causalWallTimeSaving: null, causalReliabilityChange: null,
      note: "Runner and elapsed fractions are sensitivity assumptions (elapsed defaults to runner fraction); alternate queueing, task mix, partial failures and agent scheduling need matched experiments." },
    sizeCohorts: Object.fromEntries([["0-50 changed lines", 0, 50], ["51-500 changed lines", 51, 500], ["501+ changed lines", 501, Infinity]].map(([name, low, high]) => {
      const group = prRows.filter(p => p.changedLines >= Number(low) && p.changedLines <= Number(high));
      return [String(name), { prs: group.length, firstMainGreen: percentage(group.filter(p => p.firstMainOutcome === "success").length,
        group.filter(p => p.firstMainOutcome !== "unknown").length), createToMergeSeconds: stats(group.flatMap(p => p.createToMergeSeconds === null ? [] : [p.createToMergeSeconds])) }];
    })),
    prs: prRows };
}

export function throughputMarkdown(r: ReturnType<typeof summarizeThroughput>): string {
  const format = (x: number | null) => x === null ? "unknown" : x.toFixed(2);
  return ["## Reliable integration throughput", "", r.objective + ".", "",
    `Window: ${r.window.since} to ${r.window.until} (${r.window.source}).`,
    `Merged PR/day: ${format(r.velocity.mergedPerDay)}; first-pass green integrations/day: ${format(r.velocity.firstPassGreenPerDay)}.`,
    `First main-push green: ${r.velocity.firstPassGreen.numerator}/${r.velocity.firstPassGreen.denominator} (${format(r.velocity.firstPassGreen.percent)}%); unknown first-main outcomes: ${r.coverage.firstMainUnknown}.`,
    `Observed runner-minutes per observed-green integration: ${format(r.velocity.runnerMinutesPerObservedGreenIntegration)}.`,
    `Post-merge first outcomes: ${JSON.stringify(r.reliability.firstMainOutcomes)}; same-source recoveries: ${r.reliability.sameSourceRecoveries}.`,
    `Pre-green / main-nongreen: ${r.reliability.preGreenMainNonGreen.numerator}/${r.reliability.preGreenMainNonGreen.denominator} (${format(r.reliability.preGreenMainNonGreen.percent)}%). This is discordance, not a diagnosed regression rate.`, "",
    "| Elapsed interval | Samples | Mean min | Median min | p90 min |", "| --- | ---: | ---: | ---: | ---: |",
    ...["createToMergeSeconds", "readyToMergeSeconds", "gateToMergeSeconds", "mergeToGreenSeconds"].map(k => {
      const d = r.velocity[k as "createToMergeSeconds"];
      return `| ${k} | ${d.n} | ${format(d.mean === null ? null : d.mean / 60)} | ${format(d.median === null ? null : d.median / 60)} | ${format(d.p90 === null ? null : d.p90 / 60)} |`;
    }), "", `Peak observed CI jobs: ${r.parallelism.ciJobs.peak}; peak distinct PR verification intervals: ${r.parallelism.distinctPRVerification.peak}. Worker concurrency: ${r.parallelism.recordedWorkers ? r.parallelism.recordedWorkers.peak : "unknown (no complete worker records)"}.`,
    `Reservation occupied wall-seconds: ${r.reservation ? format(r.reservation.activeWallSeconds) : "unknown"}; caller reservation wait remains unknown without wait records.`,
    `Final candidate receipt / immutable squash comparisons: ${JSON.stringify(r.evidence.squashComparedToRecordedReceipt)}. Differences require contextual review; unknown is not equivalent.`,
    `Scenario: ${JSON.stringify(r.scenario.assumptions)}; equivalent full runs/PR ${format(r.scenario.equivalentFullRunsPerPR)}; estimated compute saving ${format(r.scenario.estimatedSavingPercent)}%.`,
    "Causal wall-time and reliability improvements remain unknown. Guarantee satisfaction requires the existing independent proof/merge validation; these rates do not replace it.", ""].join("\n");
}
