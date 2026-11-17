/**
 * The scheduled CI evidence reports (#2956): a daily digest and a weekly full
 * report, both generated from the durable data ref (docs/decisions/ci-evidence.md).
 * Measurement only: nothing here is an input to proof, selection or merging.
 * Every section states its own coverage, and absent data is unknown, never zero.
 */
import { resolve, join } from "node:path";
import { mkdir } from "node:fs/promises";
import { percentage, stats } from "./ci-timing-stats";
import { mergeIntervals, summarizeThroughput, type PullObservation, type WorkEvent } from "./ci-throughput";
import { mergeRedMainArchives, summarizeRedMain, type CoordinatorObservation, type RedMainArchive } from "./ci-red-main";
import { gitEpochSource, type EpochSource } from "./ci-epochs";
import { failureKey } from "./red-main";
import { archiveInputs, deduplicate, lifecycleCoverage, reservationCoverage, summarize, type ReportInputs, type TimingSnapshot } from "./ci-timings";

export const EVIDENCE_REPORT_VERSION = 1;
export type Cadence = "daily" | "weekly";
/** The artifact base name each cadence writes: `<name>.json` and `<name>.md`. */
export const REPORT_NAMES: Record<Cadence, string> = { daily: "digest", weekly: "weekly" };
/** GitHub's retention cap for a public repository's artifacts, logs and runs. */
export const RETENTION_DAYS = 90;
/** The #2934 Phase B gate, ruled on #2938. */
export const GATE = { days: 7, firstMainGreenPercent: 80 } as const;
const HOUR = 3_600_000, DAY = 86_400_000, TOP = 10;
/** The throughput report's default sensitivity scenario (`writeReport`). */
const SCENARIO = { failedPRFraction: .3, additionalPushes: 2, failedRunCostFraction: 1 };
const iso = (ms: number) => new Date(ms).toISOString();
const stamp = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value));

export interface EvidenceOptions {
  cadence: Cadence;
  /** Exclusive end of the reported window, on a whole UTC hour. */
  until: string;
  /** Generation time; decides which gaps have outlived GitHub's retention. */
  now: string;
  /** Main's first-parent history for proof-policy epochs; absent means every epoch is unknown. */
  epochSource?: EpochSource;
  archiveHead?: string | null;
}
type Status = "met" | "not met" | "unknown";
export interface GateCondition { status: Status; reason: string }
export interface GateResult {
  status: "met" | "not met"; window: { since: string; until: string };
  failing: ("epoch" | "firstMainGreen" | "incidentsAttributed")[];
  conditions: { epoch: GateCondition & { epoch: string | null; days: number | null };
    firstMainGreen: GateCondition & ReturnType<typeof percentage>;
    incidentsAttributed: GateCondition & { incidents: number[]; unattributed: number[] } };
}

/** The window a cadence reports: the UTC day, or the seven days, before `until`. */
export function reportWindow(cadence: Cadence, until: string): { since: string; until: string } {
  const end = Date.parse(until);
  if (!Number.isFinite(end) || end % HOUR) throw new Error("A report window ends on a whole UTC hour");
  return { since: iso(end - (cadence === "daily" ? DAY : GATE.days * DAY)), until: iso(end) };
}

/** Months a report needs from the archive: the gate's trailing week and the day before it. */
export const archiveSince = (until: string) => iso(Date.parse(until) - (GATE.days + 1) * DAY);

/** Memoizes commit classification, which spawns git, across the report's several throughput passes. */
function memo(source: EpochSource | undefined): EpochSource | undefined {
  if (!source || "error" in source) return source;
  const cache = new Map<string, ReturnType<typeof source.classify>>();
  return { ...source, classify(commit) {
    if (!cache.has(commit.sha)) cache.set(commit.sha, source.classify(commit));
    return cache.get(commit.sha)!;
  } };
}

/**
 * Which hours of the window some collection's creation window covered. An hour
 * no collection covered is missing; one covered only by partial collections is
 * listed, because its runs may be incomplete, but it is not a gap.
 */
export function collectionHours(collections: { since?: unknown; until?: unknown; status?: unknown }[], window: { since: string; until: string }) {
  const union = (rows: typeof collections) => mergeIntervals(rows.filter(c => stamp(c.since) && stamp(c.until))
    .map(c => ({ start: Date.parse(c.since as string), end: Date.parse(c.until as string) })));
  const any = union(collections), complete = union(collections.filter(c => c.status === "completed"));
  const covered = (list: { start: number; end: number }[], start: number) => list.some(i => i.start <= start && i.end >= start + HOUR);
  const missing: string[] = [], partialOnly: string[] = [];
  let expected = 0;
  for (let hour = Date.parse(window.since); hour < Date.parse(window.until); hour += HOUR) {
    expected++;
    if (!covered(any, hour)) missing.push(iso(hour));
    else if (!covered(complete, hour)) partialOnly.push(iso(hour));
  }
  return { expected, covered: expected - missing.length, missing, partialOnly };
}

interface Loaded {
  snapshots: TimingSnapshot[]; collections: any[]; pulls: PullObservation[]; events: WorkEvent[];
  redMain: RedMainArchive[]; coordinator: CoordinatorObservation[]; leases: ReturnType<typeof reservationCoverage>;
  fullRun: { runnerSeconds: number | null; elapsedSeconds: number | null; samples: number };
}

function throughputFor(data: Loaded, window: { since: string; until: string }, epochSource: EpochSource | undefined) {
  return summarizeThroughput(data.snapshots, data.pulls, data.events, { ...window, source: "scheduled evidence report window" },
    data.fullRun, SCENARIO, data.leases?.complete ? data.leases.leases : undefined, epochSource);
}

/** Red-main incidents that were open at any time in the window. */
function incidentsIn(redMain: NonNullable<ReturnType<typeof summarizeRedMain>>, since: number, until: number) {
  return redMain.incidents.filter(i => i.opened < until && (!i.cleared || i.cleared.at >= since));
}

/**
 * The #2934 Phase B gate over the trailing seven days ending at `until`: one
 * proof-policy epoch for all seven, first-main green at or above 80% of known
 * outcomes, and every red-main incident open in those days attributed. An
 * incident is attributed when a `failure-classified` event records its opening
 * run. Missing evidence makes a condition unknown, and unknown is not met.
 */
export function phaseBGate(data: Loaded, until: string, epochSource: EpochSource | undefined): GateResult {
  const window = { since: iso(Date.parse(until) - GATE.days * DAY), until };
  const throughput = throughputFor(data, window, epochSource), epochs = throughput.epochs, current = epochs?.current ?? null;
  const epoch: GateResult["conditions"]["epoch"] = { status: "unknown", reason: "", epoch: current?.id ?? null, days: current?.days ?? null };
  if (!epochs) epoch.reason = "no proof-policy history was supplied";
  else if (epochs.status !== "derived") epoch.reason = `proof-policy history unavailable: ${epochs.error}`;
  else if (!current) epoch.reason = "no main squash precedes the window end";
  else if (!current.start) epoch.reason = "no epoch boundary within the history lookback; an unbounded epoch cannot prove stability";
  else if (current.start.kind !== "proof-system") epoch.reason = "the current epoch opens at a squash whose classification is unknown";
  else if (current.days! >= GATE.days) Object.assign(epoch, { status: "met", reason: `${current.days!.toFixed(2)} days in epoch ${current.id}` });
  else Object.assign(epoch, { status: "not met", reason: `${current.days!.toFixed(2)} days in epoch ${current.id}, fewer than ${GATE.days}` });

  const green = current?.firstMainGreen ?? percentage(0, 0), hours = collectionHours(data.collections, window);
  const firstMainGreen: GateResult["conditions"]["firstMainGreen"] = { ...green, status: "unknown", reason: "" };
  if (!current) firstMainGreen.reason = "no current epoch";
  else if (hours.missing.length) firstMainGreen.reason = `${hours.missing.length} collection hours are missing, so deliveries may be uncounted`;
  else if (!green.denominator) firstMainGreen.reason = "no known first-main outcome in the epoch";
  else Object.assign(firstMainGreen, { status: green.percent! >= GATE.firstMainGreenPercent ? "met" : "not met",
    reason: `${green.numerator}/${green.denominator} first-main green (${green.percent!.toFixed(1)}%)` });

  const since = Date.parse(window.since), end = Date.parse(until);
  const red = summarizeRedMain({ archives: data.redMain, coordinator: data.coordinator, snapshots: data.snapshots, pulls: data.pulls });
  const scopes = data.redMain.filter(a => Date.parse(a.collectedAt) >= since && Date.parse(a.collectedAt) < end);
  const open = red ? incidentsIn(red, since, end).map(i => i.run) : [];
  const classified = new Set(data.events.filter(e => e.kind === "failure-classified").map(e => e.run));
  const unattributed = open.filter(run => !classified.has(run));
  const incidentsAttributed: GateResult["conditions"]["incidentsAttributed"] = { status: "unknown", reason: "", incidents: open, unattributed };
  if (!scopes.some(a => a.error === undefined)) incidentsAttributed.reason = "no red-main history was collected in the window";
  else if (scopes.some(a => a.error !== undefined)) incidentsAttributed.reason = `${scopes.filter(a => a.error !== undefined).length} red-main acquisitions failed in the window`;
  else Object.assign(incidentsAttributed, unattributed.length
    ? { status: "not met", reason: `${unattributed.length} of ${open.length} red-main incidents have no failure classification` }
    : { status: "met", reason: `${open.length} red-main incidents, all attributed` });

  const conditions = { epoch, firstMainGreen, incidentsAttributed };
  const failing = (Object.keys(conditions) as GateResult["failing"]).filter(k => conditions[k].status !== "met");
  return { status: failing.length ? "not met" : "met", window, failing, conditions };
}

/** One report from loaded archive inputs. Deterministic for the same inputs and options. */
export function evidenceReport(inputs: ReportInputs, options: EvidenceOptions) {
  const window = reportWindow(options.cadence, options.until), since = Date.parse(window.since), until = Date.parse(window.until);
  const now = Date.parse(options.now), epochSource = memo(options.epochSource);
  if (!Number.isFinite(now)) throw new Error("Invalid report generation time");
  const all = deduplicate(inputs.snapshots), op = inputs.operational, leases = reservationCoverage(op.reservations);
  const collections = [...new Map(inputs.collections.map(c => [c.id ?? JSON.stringify(c), c])).values()];
  const baseline = summarize(all).baseline;
  const data: Loaded = { snapshots: all, collections, pulls: op.pulls, events: op.events, redMain: op.redMain, coordinator: op.coordinator, leases,
    fullRun: { runnerSeconds: baseline.runnerSeconds.median, elapsedSeconds: baseline.elapsedSeconds.median, samples: baseline.samples.length } };
  const inWindow = (at: unknown) => stamp(at) && Date.parse(at) >= since && Date.parse(at) < until;

  const throughput = throughputFor(data, window, epochSource);
  const gate = phaseBGate(data, window.until, epochSource), previousGate = phaseBGate(data, iso(until - DAY), epochSource);

  // Red-main incidents: those open in the window, and those first observed in it.
  const red = summarizeRedMain({ archives: op.redMain, coordinator: op.coordinator, snapshots: all, pulls: op.pulls });
  const firstSeen = new Map<number, number>();
  for (const archive of op.redMain) if (archive.error === undefined) for (const i of archive.incidents)
    firstSeen.set(i.run, Math.min(firstSeen.get(i.run) ?? Infinity, Date.parse(archive.collectedAt)));
  const incidents = red ? incidentsIn(red, since, until) : [];
  const newIncidents = incidents.filter(i => inWindow(iso(firstSeen.get(i.run) ?? NaN))).map(i => i.run);
  const cleared = incidents.filter(i => i.cleared && i.cleared.at < until);
  const redMain = red && {
    incidents: incidents.map(i => ({ run: i.run, incident: i.incident, firstBad: i.firstBad, openedAt: i.openedAt, clearedAt: i.clearedAt,
      timeToGreenSeconds: i.timeToGreenSeconds, categories: i.categories, fixes: i.fixes, newlyObserved: newIncidents.includes(i.run) })),
    newlyObserved: newIncidents,
    openAtEnd: incidents.filter(i => !i.cleared || i.cleared.at >= until).length,
    timeToGreenSeconds: stats(cleared.map(i => i.timeToGreenSeconds!)),
    mergesDuringRed: red.mergesDuringRed.rows.filter(m => incidents.some(i => i.run === m.incidentRun)).length,
  };

  // Failing and suspected-flaky test families, ranked by how many incidents and suspicions name them.
  const families = new Map<string, { family: string; category: string; incidents: Set<number>; runs: Set<number> }>();
  for (const i of incidents) for (const f of i.failures) {
    const key = failureKey(f), row = families.get(key) ?? { family: key, category: f.category, incidents: new Set(), runs: new Set() };
    row.incidents.add(i.run); row.runs.add(f.run); families.set(key, row);
  }
  const failing = [...families.values()].map(f => ({ family: f.family, category: f.category, incidents: f.incidents.size, runs: f.runs.size }))
    .sort((a, b) => b.incidents - a.incidents || b.runs - a.runs || (a.family < b.family ? -1 : 1));
  const suspects = op.redMain.length ? mergeRedMainArchives(op.redMain).flakes.filter(f => inWindow(iso(f.at))) : [];
  const realKeys = new Set(incidents.flatMap(i => i.failures.filter(f => f.escalated).map(failureKey)));
  const flaky = [...new Set(suspects.map(s => s.test))].map(test => {
    const rows = suspects.filter(s => s.test === test);
    return { family: test, category: rows[0]!.category, suspicions: rows.length,
      probes: Object.fromEntries(["passed", "failed", "pending", "unavailable"].map(p => [p, rows.filter(r => r.probe === p).length])),
      issues: [...new Set(rows.flatMap(r => r.issue === null ? [] : [r.issue]))].sort((a, b) => a - b),
      verdict: realKeys.has(test) ? "real" : "suspected-flake" };
  }).sort((a, b) => b.suspicions - a.suspicions || (a.family < b.family ? -1 : 1));
  const classifications = op.events.filter(e => e.kind === "failure-classified" && inWindow(e.at));

  // Runner-slot wait and local contention, over what the window itself observed.
  const windowSnapshots = all.filter(s => inWindow(s.run.createdAt));
  const wait = windowSnapshots.length ? summarize(windowSnapshots).runnerSlotWait : null;
  const contention = op.events.filter(e => /^(work|wait)-/.test(e.kind) && inWindow(e.at));

  // Coverage: missing hours, expired sources, failed acquisitions and unknowns.
  const hours = collectionHours(collections, window);
  const expired = (at: number) => at + RETENTION_DAYS * DAY < now;
  const overlapping = collections.filter(c => stamp(c.since) && stamp(c.until) && Date.parse(c.since) < until && Date.parse(c.until) > since);
  const observed = new Set(all.map(s => `${s.repository}/${s.run.id}/${s.run.attempt}`));
  const missingAttempts = [...new Set(overlapping.flatMap(c => (c.expected ?? []).flatMap((r: { run: number; attempts: number }) =>
    Array.from({ length: r.attempts }, (_, n) => `${c.repository}/${r.run}/${n + 1}`)).filter((k: string) => !observed.has(k))))].sort();
  const failed: { source: string; at: string; reason: string; expired: boolean }[] = [];
  for (const c of overlapping.filter(c => c.status !== "completed").sort((a, b) => a.collectedAt < b.collectedAt ? -1 : 1))
    failed.push({ source: `collection ${c.id}`, at: c.collectedAt, expired: expired(Date.parse(c.until)),
      reason: [c.requestBudget?.stopped ? `budget stop: ${c.requestBudget.stopped}` : "", c.seed?.error ? `seed: ${c.seed.error}` : "",
        ...(c.errors ?? []).slice(0, 3).map((e: { error: string }) => e.error)].filter(Boolean).join("; ") || `status ${c.status}` });
  const lifecycle = lifecycleCoverage(op.acquisitions.filter(a => inWindow(a.collectedAt)), op.pulls);
  for (const e of lifecycle?.errors ?? []) failed.push({ source: e.pr ? `lifecycle PR ${e.pr}` : "lifecycle discovery", at: lifecycle!.collectedAt, reason: e.problem, expired: false });
  for (const r of op.reservations.filter(r => inWindow(r.collectedAt) && r.error !== undefined))
    failed.push({ source: "reservation history", at: r.collectedAt, reason: r.error!, expired: expired(Date.parse(r.collectedAt)) });
  for (const r of op.redMain.filter(r => inWindow(r.collectedAt)))
    if (r.error !== undefined || r.coordinatorScope?.status === "partial")
      failed.push({ source: r.error !== undefined ? "red-main history" : "red-main coordinator logs", at: r.collectedAt,
        reason: r.error ?? r.coordinatorScope!.error ?? "partial", expired: expired(Date.parse(r.collectedAt)) });
  for (const c of op.coordinator.filter(c => inWindow(c.createdAt) && c.cancelled === null))
    failed.push({ source: `coordinator run ${c.run} attempt ${c.attempt}`, at: c.createdAt, reason: c.problem ?? "cancellations unknown", expired: expired(Date.parse(c.createdAt)) });

  const unknowns: { field: string; reason: string }[] = [
    { field: "escapeClasses", reason: "no archived escape-class source; acquisition is #4043" },
    { field: "reservationDemand", reason: "reservation requests and reconfirmation reasons are not archived; acquisition is #4044" },
  ];
  if (!red) unknowns.push({ field: "redMain", reason: "no red-main history in the archive" });
  if (!throughput.epochs || throughput.epochs.status !== "derived") unknowns.push({ field: "epochs", reason: throughput.epochs?.error ?? "no proof-policy history was supplied" });
  if (throughput.coverage.firstMainUnknown) unknowns.push({ field: "firstMainOutcomes", reason: `${throughput.coverage.firstMainUnknown} merged PRs have no known first-main outcome` });
  if (!contention.length) unknowns.push({ field: "localContention", reason: "no work or wait events were published in the window" });
  if (!wait) unknowns.push({ field: "runnerSlotWait", reason: "no run attempt was archived for the window" });
  else if (wait.overall.unknown) unknowns.push({ field: "runnerSlotWait", reason: `${wait.overall.unknown} jobs have no creation-to-start interval` });
  if (!leases?.complete) unknowns.push({ field: "reservation", reason: leases ? "reservation history acquisition was incomplete" : "no reservation history in the archive" });

  // Activity per UTC day; a day with a missing hour reports what was observed as a lower bound, not a count.
  const activity = [];
  for (let day = since; day < until; day += DAY) {
    const within = (at: unknown) => stamp(at) && Date.parse(at) >= day && Date.parse(at) < day + DAY;
    const missing = hours.missing.filter(h => within(h)).length;
    const runs = windowSnapshots.filter(s => within(s.run.createdAt)).length;
    const merges = op.pulls.filter(p => p.baseBranch === "main" && within(p.mergedAt)).length;
    activity.push({ day: iso(day).slice(0, 10), missingHours: missing, complete: missing === 0,
      runAttempts: missing ? null : runs, merges: missing ? null : merges, observedRunAttempts: runs, observedMerges: merges });
  }

  const gateChanged = previousGate.status !== gate.status ? { from: previousGate.status, to: gate.status } : null;
  const v = throughput.velocity, epochs = throughput.epochs;
  return {
    version: EVIDENCE_REPORT_VERSION, cadence: options.cadence, window, generatedAt: iso(now), archive: { head: options.archiveHead ?? null },
    /** Whether the daily digest is due for delivery (docs/decisions/ci-evidence.md); the weekly report is always delivered. */
    changed: newIncidents.length > 0 || gateChanged !== null || hours.missing.length > 0,
    triggers: { newIncidents, gateChanged, collectionGap: hours.missing.length > 0 },
    gate, previousGate: { status: previousGate.status, until: previousGate.window.until, failing: previousGate.failing },
    throughput: { mergedInWindow: throughput.coverage.mergedInWindow, mergedPerDay: v.mergedPerDay, firstPassGreenPerDay: v.firstPassGreenPerDay,
      firstPassGreen: v.firstPassGreen, firstMainUnknown: throughput.coverage.firstMainUnknown, firstMainOutcomes: throughput.reliability.firstMainOutcomes,
      sameCommitObservedGreen: v.sameCommitObservedGreen, runnerMinutesPerObservedGreenIntegration: v.runnerMinutesPerObservedGreenIntegration,
      createToMergeSeconds: v.createToMergeSeconds, createToGreenSeconds: v.createToGreenSeconds, mergeToGreenSeconds: v.mergeToGreenSeconds,
      sameSourceRecoveries: throughput.reliability.sameSourceRecoveries, mergePaths: throughput.reliability.mergePaths, sizeCohorts: throughput.sizeCohorts,
      reservationOccupancy: throughput.reservation?.occupiedWindow ?? null },
    epochs: epochs && epochs.status === "derived" ? epochs.epochs.map(e => ({ id: e.id, start: e.start?.at ?? null, kind: e.start?.kind ?? null,
      end: e.end, current: e.current, merges: e.merges, firstMainGreen: e.firstMainGreen })) : null,
    redMain,
    families: { failing: failing.slice(0, TOP), suspectedFlaky: flaky.slice(0, TOP),
      firstMainFailedJobCategories: throughput.reliability.firstMainFailedJobCategories,
      classifications: Object.fromEntries([...new Set(classifications.map(e => e.classification!))].sort().map(k => [k, classifications.filter(e => e.classification === k).length])) },
    escapeClasses: null,
    runnerSlotWait: wait,
    localContention: contention.length ? { events: contention.length, recordedWorkers: throughput.coverage.recordedWorkers,
      completedWorkIntervals: throughput.parallelism.completedWorkIntervals, waits: throughput.parallelism.waits,
      unmatchedEvents: throughput.coverage.unmatchedCoordinationEvents } : null,
    activity,
    coverage: { complete: hours.missing.length === 0 && failed.length === 0 && missingAttempts.length === 0,
      collectionHours: hours,
      expiredSources: { hours: hours.missing.filter(h => expired(Date.parse(h) + HOUR)), acquisitions: failed.filter(f => f.expired).length,
        note: `Gaps older than ${RETENTION_DAYS} days can no longer be recollected from GitHub.` },
      failedAcquisitions: failed, missingAttempts, unknowns },
    /** The weekly report also carries the full throughput summary it was computed from. */
    detail: options.cadence === "weekly" ? { throughput } : null,
  };
}
export type EvidenceReport = ReturnType<typeof evidenceReport>;

/** Consecutive whole hours as compact ranges, so a long gap reads as one line. */
export function hourRanges(hours: string[]): string[] {
  const out: string[] = [];
  let start: number | null = null, last = 0;
  const flush = () => { if (start !== null) out.push(start === last ? iso(start).slice(0, 13) + ":00Z" : `${iso(start).slice(0, 13)}:00Z–${iso(last + HOUR).slice(0, 13)}:00Z`); };
  for (const hour of hours.map(Date.parse).sort((a, b) => a - b)) {
    if (start !== null && hour === last + HOUR) { last = hour; continue; }
    flush(); start = last = hour;
  }
  flush();
  return out;
}

const pct = (p: { numerator: number; denominator: number; percent: number | null }) => p.percent === null ? `unknown (0 known)` : `${p.numerator}/${p.denominator} (${p.percent.toFixed(1)}%)`;
const minutes = (n: number | null) => n === null ? "unknown" : (n / 60).toFixed(1);
const cell = (s: string) => s.replaceAll("|", "\\|");

/**
 * The report as Markdown. `## Summary` comes first and ends at the next heading,
 * so delivery (#2957) can post it alone and link the full artifact.
 */
export function evidenceMarkdown(r: EvidenceReport): string {
  const title = r.cadence === "daily" ? `# CI evidence digest, ${r.window.since.slice(0, 10)}` : `# CI evidence weekly report, ${r.window.since.slice(0, 10)} to ${r.window.until.slice(0, 10)}`;
  const t = r.throughput, c = r.coverage, g = r.gate;
  const lines = [title, "", `Window ${r.window.since} to ${r.window.until} (UTC, end exclusive). Archive ${r.archive.head ?? "unknown"}. Generated ${r.generatedAt}.`, "",
    "## Summary", "",
    ...(c.complete ? [] : [`- **Coverage is incomplete**: ${c.collectionHours.missing.length} missing collection hours, ${c.failedAcquisitions.length} failed acquisitions, ${c.missingAttempts.length} missing run attempts. Counts below are lower bounds.`]),
    `- Phase B gate: **${g.status}**${g.failing.length ? ` (failing: ${g.failing.join(", ")})` : ""}${r.triggers.gateChanged ? `, changed from ${r.triggers.gateChanged.from}` : ""}.`,
    `- Merged PRs: ${t.mergedInWindow}; first-main green ${pct(t.firstPassGreen)}; first-pass greens/day ${t.firstPassGreenPerDay.toFixed(2)}.`,
    `- Red-main incidents open: ${r.redMain ? r.redMain.incidents.length : "unknown"}; newly observed: ${r.redMain ? r.redMain.newlyObserved.length : "unknown"}; median time to green ${minutes(r.redMain?.timeToGreenSeconds.median ?? null)} min.`,
    `- Runner-slot wait median ${minutes(r.runnerSlotWait?.overall.median ?? null)} min, p90 ${minutes(r.runnerSlotWait?.overall.p90 ?? null)} min.`,
    `- Delivery due: ${r.cadence === "weekly" ? "yes (weekly)" : r.changed ? `yes (${[r.triggers.newIncidents.length ? "new incident" : "", r.triggers.gateChanged ? "gate change" : "", r.triggers.collectionGap ? "collection gap" : ""].filter(Boolean).join(", ")})` : "no"}.`, "",
    "## Phase B gate", "",
    `Trailing ${GATE.days} days ${g.window.since} to ${g.window.until}. Previous (to ${r.previousGate.until}): ${r.previousGate.status}.`, "",
    "| Condition | Status | Evidence |", "| --- | --- | --- |",
    `| ${GATE.days} days in one proof-policy epoch | ${g.conditions.epoch.status} | ${cell(g.conditions.epoch.reason)} |`,
    `| First-main green at or above ${GATE.firstMainGreenPercent}% | ${g.conditions.firstMainGreen.status} | ${cell(g.conditions.firstMainGreen.reason)} |`,
    `| Every red-main incident attributed | ${g.conditions.incidentsAttributed.status} | ${cell(g.conditions.incidentsAttributed.reason)} |`, "",
    "## Throughput", "",
    `Merged ${t.mergedInWindow} (${t.mergedPerDay.toFixed(2)}/day); first-main outcomes ${JSON.stringify(t.firstMainOutcomes)}; same-commit observed green ${pct(t.sameCommitObservedGreen)}.`,
    `Runner-minutes per observed-green integration: ${t.runnerMinutesPerObservedGreenIntegration?.toFixed(1) ?? "unknown"}. Create to merge median ${minutes(t.createToMergeSeconds.median)} min, p90 ${minutes(t.createToMergeSeconds.p90)} min (n=${t.createToMergeSeconds.n}). Create to green median ${minutes(t.createToGreenSeconds.median)} min (n=${t.createToGreenSeconds.n}).`,
    `Merge paths: ${JSON.stringify(t.mergePaths)}. Reservation occupancy: ${t.reservationOccupancy ? pct(t.reservationOccupancy) : "unknown"}.`, "",
    "| Size cohort | PRs | First-main green |", "| --- | ---: | --- |",
    ...Object.entries(t.sizeCohorts).map(([k, v]) => `| ${k} | ${v.prs} | ${pct(v.firstMainGreen)} |`), "",
    "## First-main green per proof-policy epoch", "",
    ...(r.epochs ? ["| Epoch | Starts | Boundary | Merges | First-main green |", "| --- | --- | --- | ---: | --- |",
      ...r.epochs.map(e => `| ${e.id.slice(0, 12)}${e.current ? " (current)" : ""} | ${e.start ?? "before lookback"} | ${e.kind ?? "unbounded"} | ${e.merges} | ${pct(e.firstMainGreen)} |`)]
      : ["Proof-policy epochs are unknown: no main history was readable."]), "",
    "## Red-main incidents", "",
    ...(!r.redMain ? ["Unknown: no red-main history in the archive."] : r.redMain.incidents.length ? [
      "| Opening run | Opened | Cleared | Time to green min | Categories | New |", "| --- | --- | --- | ---: | --- | --- |",
      ...r.redMain.incidents.map(i => `| ${i.run} | ${i.openedAt} | ${i.clearedAt ?? "open"} | ${minutes(i.timeToGreenSeconds)} | ${i.categories.join(", ")} | ${i.newlyObserved ? "yes" : "no"} |`), "",
      `Open at window end: ${r.redMain.openAtEnd}. Merges while red: ${r.redMain.mergesDuringRed}.`] : ["No red-main incident was open in the window."]), "",
    "## Top failing test families", "",
    ...(r.families.failing.length ? ["| Family | Category | Incidents | Runs |", "| --- | --- | ---: | ---: |",
      ...r.families.failing.map(f => `| ${cell(f.family)} | ${f.category} | ${f.incidents} | ${f.runs} |`)] : [r.redMain ? "No failing test in a red-main incident." : "Unknown."]), "",
    `First-main failed job categories: ${JSON.stringify(r.families.firstMainFailedJobCategories)}. Failure classifications: ${JSON.stringify(r.families.classifications)}.`, "",
    "## Suspected-flaky test families", "",
    ...(r.families.suspectedFlaky.length ? ["| Family | Category | Suspicions | Probes passed / failed / pending / unavailable | Verdict |", "| --- | --- | ---: | --- | --- |",
      ...r.families.suspectedFlaky.map(f => `| ${cell(f.family)} | ${f.category} | ${f.suspicions} | ${f.probes.passed} / ${f.probes.failed} / ${f.probes.pending} / ${f.probes.unavailable} | ${f.verdict} |`)]
      : [r.redMain ? "No suspected flake in the window." : "Unknown."]), "",
    "## Escape classes", "", "Unknown: no archived escape-class source yet (#4043).", "",
    "## Runner-slot wait", "",
    ...(r.runnerSlotWait ? ["| Cohort | Known jobs | Unknown | Median min | p90 min | Max min | >5 min |", "| --- | ---: | ---: | ---: | ---: | ---: | --- |",
      ...[["overall", r.runnerSlotWait.overall] as const, ...Object.entries(r.runnerSlotWait.byEvent).map(([k, v]) => [`event/${k}`, v] as const)].map(([k, v]) =>
        `| ${k} | ${v.n} | ${v.unknown} | ${minutes(v.median)} | ${minutes(v.p90)} | ${minutes(v.max)} | ${pct(v.overFiveMinutes)} |`)] : ["Unknown: no run attempt was archived for the window."]), "",
    "## Local contention", "",
    ...(r.localContention ? [`Events ${r.localContention.events}; workers ${r.localContention.recordedWorkers}; completed work intervals ${r.localContention.completedWorkIntervals}; unmatched ${r.localContention.unmatchedEvents}.`,
      ...Object.entries(r.localContention.waits).map(([k, v]) => `- wait ${k}: n=${v.n}, median ${minutes(v.median)} min, p90 ${minutes(v.p90)} min`)]
      : ["Unknown: no work or wait events were published in the window."]), "",
    "## Activity by day", "", "| Day | Run attempts | Merges | Missing hours |", "| --- | ---: | ---: | ---: |",
    ...r.activity.map(d => `| ${d.day} | ${d.runAttempts ?? `unknown (${d.observedRunAttempts} observed)`} | ${d.merges ?? `unknown (${d.observedMerges} observed)`} | ${d.missingHours} |`), "",
    "## Coverage", "",
    `Collection hours covered: ${c.collectionHours.covered}/${c.collectionHours.expected}; covered only by partial collections: ${c.collectionHours.partialOnly.length}.`,
    ...(c.collectionHours.missing.length ? ["", "Missing collection hours (no activity is known for them):", ...hourRanges(c.collectionHours.missing).map(h => `- ${h}`)] : []),
    "", `Expired sources: ${c.expiredSources.hours.length} missing hours and ${c.expiredSources.acquisitions} failed acquisitions are past retention. ${c.expiredSources.note}`,
    "", `Failed acquisitions: ${c.failedAcquisitions.length}.`, ...c.failedAcquisitions.slice(0, 20).map(f => `- ${f.source} at ${f.at}: ${cell(f.reason)}${f.expired ? " (expired)" : ""}`),
    ...(c.failedAcquisitions.length > 20 ? [`- ${c.failedAcquisitions.length - 20} more in the JSON report`] : []),
    "", `Missing run attempts: ${c.missingAttempts.length}.`, "", "Unknown:", ...c.unknowns.map(u => `- ${u.field}: ${u.reason}`), ""];
  return lines.join("\n");
}

if (import.meta.main) {
  try {
    const args = process.argv.slice(2), options = new Map<string, string>();
    while (args.length) {
      const flag = args.shift()!;
      if (!["--cadence", "--from-archive", "--until", "--repo", "--history", "--out"].includes(flag) || !args.length || options.has(flag)) throw new Error(`Invalid option ${flag}`);
      options.set(flag, args.shift()!);
    }
    const cadence = options.get("--cadence") as Cadence;
    if (!(cadence in REPORT_NAMES) || !options.has("--from-archive")) throw new Error("usage: bun scripts/ci-evidence-report.ts --cadence daily|weekly --from-archive REMOTE [--until ISO] [--history REF] [--repo owner/repo] [--out DIR]");
    const repository = options.get("--repo") ?? "schlessera/brain-kit";
    if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error("Invalid repository");
    const now = new Date().toISOString(), until = options.get("--until") ?? iso(Math.floor(Date.parse(now) / DAY) * DAY);
    reportWindow(cadence, until);
    // Shared archive loading joins legacy monthly and daily run attempts once.
    const inputs = await archiveInputs(options.get("--from-archive")!, repository, archiveSince(until), until);
    const report = evidenceReport(inputs, { cadence, until, now, archiveHead: inputs.head,
      epochSource: gitEpochSource(process.cwd(), options.get("--history") ?? "origin/main") });
    const dir = resolve(options.get("--out") ?? "tmp/ci-evidence"), name = REPORT_NAMES[cadence];
    await mkdir(dir, { recursive: true });
    await Bun.write(join(dir, `${name}.json`), JSON.stringify(report, null, 2) + "\n");
    await Bun.write(join(dir, `${name}.md`), evidenceMarkdown(report));
    console.log(JSON.stringify({ report: join(dir, `${name}.json`), cadence, window: report.window, changed: report.changed, gate: report.gate.status, coverageComplete: report.coverage.complete }));
  } catch (error) { console.error(error); process.exitCode = 1; }
}
