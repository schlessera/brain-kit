/**
 * Read-only red-main evidence (#2953): each red-main record's lifecycle, flake
 * verdicts and triage probes, PR proof the coordinator cancelled or the hosted
 * gate refused, and squashes that landed while red. Measurement only: nothing
 * here is an input to proof, selection or merging, and absent evidence stays
 * unknown rather than zero.
 */
import { stats } from "./ci-timing-stats";
import type { PullObservation } from "./ci-throughput";
import { RESERVATION_REF } from "./integration-reservation";
import { CATEGORIES, failureKey, parseRedMain, RED_MAIN_FILE, type Category, type RedFailure, type RedMainRecord } from "./red-main";

export const RED_MAIN_ARCHIVE = "red-main.json";
/** The hosted gate's step in ci.yml's metadata job (#2942). */
export const GATE_STEP = "Refuse doomed proof while main is red";
/** The coordinator prints this line with the PR runs it cancelled. */
export const COORDINATOR_MARKER = "BRAIN_RED_MAIN ";
export const COORDINATOR_WORKFLOW = "red-main.yml";
/** The coordinator that opens a record starts before the record's server timestamp. */
const COORDINATOR_LEAD_MS = 30 * 60_000;
/** Bounds one history walk; a longer walk is an acquisition error, never a silent truncation. */
const MAX_HISTORY = 20_000;
const SHA = /^[a-f0-9]{40}$/;
const PROBES = ["pending", "passed", "failed", "unavailable"] as const;
type Probe = typeof PROBES[number];
type Escalation = "repeated-suspected-flake" | "probe-reproduced";

export interface IncidentFailure {
  test: string | null; category: Category; reasons: string[]; run: number; sha: string;
  /** Why a failure the estimator once suspected was declared real; null for a first-sight real failure. */
  escalated: Escalation | null; priorSuspectRun: number | null;
}
export interface IncidentObservation {
  /** The record's opening run, which also keys its incident issue marker. */
  run: number; opened: number; firstBad: string; firstBadHistory: { sha: string; at: number }[];
  failures: IncidentFailure[]; incident: number | null; fixes: number[];
  expedited: { pr: number; squash: string; at: number }[];
  /** Non-fix squashes the coordinator reported as landing while red. */
  reported: string[];
  cleared: { at: number; run: number | null } | null; sources: string[];
}
export interface FlakeObservation {
  test: string; category: Category; run: number; sha: string; at: number; probe: Probe; issue: number | null; sources: string[];
}
export interface RedMainArchive {
  version: 1; repository: string; collectedAt: string; sourceRef: string; sourceHead: string | null; since: string;
  incidents: IncidentObservation[]; flakes: FlakeObservation[]; error?: string;
  /** Which red hours had their coordinator logs read; absent when no collection requested them. */
  coordinatorScope?: { intervals: { since: string; until: string }[]; status: "completed" | "partial"; error: string | null };
}
/** One coordinator attempt: the PR runs it cancelled, or null when its log cannot say. */
export interface CoordinatorObservation {
  version: 1; repository: string; collectedAt: string; run: number; attempt: number; createdAt: string;
  conclusion: string | null; cancelled: number[] | null; problem: string | null;
}

const positive = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;
const time = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const testKey = (value: unknown) => typeof value === "string" && value.length <= 300 && /^[A-Za-z0-9_./@:-]+$/.test(value);
const category = (value: unknown): value is Category => CATEGORIES.includes(value as Category);
const stamp = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value));

function escalation(reasons: string[]): Pick<IncidentFailure, "escalated" | "priorSuspectRun"> {
  if (reasons.includes("repeated-suspected-flake")) {
    const prior = reasons.map(reason => /^prior-suspect-run-([1-9]\d*)$/.exec(reason)?.[1]).find(Boolean);
    return { escalated: "repeated-suspected-flake", priorSuspectRun: prior ? Number(prior) : null };
  }
  return { escalated: reasons.includes("probe-reproduced") ? "probe-reproduced" : null, priorSuspectRun: null };
}
const failure = (f: RedFailure): IncidentFailure => ({ test: f.test, category: f.category, reasons: [...f.reasons], run: f.run, sha: f.sha, ...escalation(f.reasons) });
const union = <T>(values: T[]) => [...new Set(values)];

/** Folds record states, oldest first, into one observation per incident and suspect. */
export function observeRedMain(rows: { source: string; record: RedMainRecord }[]): Pick<RedMainArchive, "incidents" | "flakes"> {
  const incidents = new Map<number, IncidentObservation>(), flakes = new Map<string, FlakeObservation>();
  let current: number | null = null;
  for (const { source, record } of rows) {
    if (!SHA.test(source)) throw new Error("Invalid red-main source");
    const open = record.open;
    if (open) {
      let seen = incidents.get(open.run);
      if (!seen) incidents.set(open.run, seen = { run: open.run, opened: open.opened, firstBad: open.firstBad, firstBadHistory: [],
        failures: [], incident: null, fixes: [], expedited: [], reported: [], cleared: null, sources: [] });
      else if (seen.opened !== open.opened) throw new Error("Conflicting red-main history");
      if (seen.firstBadHistory.at(-1)?.sha !== open.firstBad) seen.firstBadHistory.push({ sha: open.firstBad, at: record.updated });
      seen.firstBad = open.firstBad;
      for (const f of open.failures) if (!seen.failures.some(known => failureKey(known) === failureKey(f))) seen.failures.push(failure(f));
      seen.incident = open.incident ?? seen.incident;
      seen.fixes = union([...seen.fixes, ...open.fixes]);
      for (const e of open.expedited ?? []) if (!seen.expedited.some(known => known.squash === e.squash)) seen.expedited.push({ pr: e.pr, squash: e.squash, at: e.at });
      seen.reported = union([...seen.reported, ...open.reported]);
      seen.sources.push(source);
      current = open.run;
    } else if (current !== null) {
      // Only a green main run that included the open set clears a record.
      const seen = incidents.get(current)!;
      if (record.last?.action === "clear") seen.cleared = { at: record.last.at, run: record.last.run };
      seen.sources.push(source);
      current = null;
    }
    for (const s of record.suspects) {
      const key = `${s.test}\n${s.run}`, old = flakes.get(key);
      flakes.set(key, { test: s.test, category: s.category, run: s.run, sha: s.sha, at: old?.at ?? s.at,
        probe: s.probe, issue: s.issue ?? old?.issue ?? null, sources: union([...old?.sources ?? [], source]) });
    }
  }
  return { incidents: [...incidents.values()], flakes: [...flakes.values()] };
}

/** Reads the shared coordination ref's red-main history through the local Git remote. */
export function collectRedMainHistory(repository: string, since: string, cwd = process.cwd()): RedMainArchive {
  if (!stamp(since)) throw new Error("Invalid red-main history window");
  const run = (args: string[]) => {
    const p = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe", timeout: 60000 });
    if (p.exitCode !== 0) throw new Error(`Red-main history unavailable: ${new TextDecoder().decode(p.stderr).trim()}`);
    return new TextDecoder().decode(p.stdout).trim();
  };
  const remote = run(["ls-remote", "--refs", "origin", RESERVATION_REF]).split(/\s+/)[0];
  if (!remote || !SHA.test(remote)) throw new Error("Coordination ref unavailable");
  run(["fetch", "--no-tags", "origin", remote]);
  // Only commits that changed the record; reservation writes copy it unchanged.
  const commits = run(["rev-list", "--first-parent", remote, "--", RED_MAIN_FILE]).split("\n").filter(Boolean);
  const rows: { source: string; record: RedMainRecord }[] = [];
  for (const source of commits) {
    if (rows.length >= MAX_HISTORY) throw new Error("Red-main history exceeds the collection bound; collect a narrower window");
    const record = parseRedMain(run(["show", `${source}:${RED_MAIN_FILE}`]));
    rows.push({ source, record });
    // A green state before the window bounds the walk: every incident open in the window opened after it.
    if (record.updated < Date.parse(since) && record.open === null) break;
  }
  return { version: 1, repository, collectedAt: new Date().toISOString(), sourceRef: RESERVATION_REF, sourceHead: remote, since,
    ...observeRedMain(rows.reverse()) };
}

/** The union of PR runs every coordinator line names; null when the attempt failed before printing one. */
export function coordinatorCancellations(log: string, conclusion: string | null): number[] | null {
  const lines = log.split("\n").filter(line => line.includes(COORDINATOR_MARKER));
  const cancelled: number[] = [];
  for (const line of lines) {
    let value: { cancelled?: unknown };
    try { value = JSON.parse(line.slice(line.indexOf(COORDINATOR_MARKER) + COORDINATOR_MARKER.length)); }
    catch { throw new Error("Invalid coordinator cancellation line"); }
    if (!Array.isArray(value?.cancelled) || !value.cancelled.every(positive)) throw new Error("Invalid coordinator cancellation line");
    cancelled.push(...value.cancelled as number[]);
  }
  // A successful attempt that printed nothing reached no cancellation; a failed one may have cancelled unseen.
  return lines.length || conclusion === "success" ? union(cancelled).sort((a, b) => a - b) : null;
}

/** Red intervals in the window, widened by the opening coordinator's lead and clamped to the window. */
export function redIntervals(archive: Pick<RedMainArchive, "incidents">, since: string, until: string): { since: string; until: string }[] {
  const lower = Date.parse(since), upper = Date.parse(until);
  const spans = archive.incidents.map(i => [Math.max(lower, i.opened - COORDINATOR_LEAD_MS), Math.min(upper, i.cleared?.at ?? upper)] as const)
    .filter(([a, b]) => a < b).sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const [a, b] of spans) {
    const last = merged.at(-1);
    if (last && a <= last[1]) last[1] = Math.max(last[1], b); else merged.push([a, b]);
  }
  return merged.map(([a, b]) => ({ since: new Date(a).toISOString(), until: new Date(b).toISOString() }));
}

interface CoordinatorAPI { json(path: string): Promise<any>; log(job: number): Promise<string>; }
/**
 * Reads coordinator attempts created while main was red. Zero requests when
 * main stayed green; an archived attempt is never fetched twice.
 */
export async function collectCoordinatorRuns(api: CoordinatorAPI, repository: string, intervals: { since: string; until: string }[],
  known: (run: number, attempt: number) => Promise<CoordinatorObservation | null>, now = () => new Date().toISOString()): Promise<CoordinatorObservation[]> {
  const out: CoordinatorObservation[] = [];
  for (const interval of intervals) {
    const query = `actions/workflows/${COORDINATOR_WORKFLOW}/runs?per_page=100&created=${encodeURIComponent(`${interval.since}..${interval.until}`)}`;
    const runs: any[] = [];
    for (let page = 1; ; page++) {
      const result = await api.json(`${query}&page=${page}`);
      if (!Number.isSafeInteger(result?.total_count) || !Array.isArray(result.workflow_runs)) throw new Error("Invalid coordinator run inventory");
      if (result.total_count >= 1000) throw new Error("Coordinator run search cap reached; collect a narrower window");
      runs.push(...result.workflow_runs);
      if (runs.length >= result.total_count) break;
      if (!result.workflow_runs.length) throw new Error("Incomplete coordinator run pagination");
    }
    for (const run of runs) {
      if (!positive(run?.id) || !positive(run.run_attempt) || !stamp(run.created_at) || run.path !== `.github/workflows/${COORDINATOR_WORKFLOW}`) throw new Error("Invalid coordinator run identity");
      if (run.status !== "completed") continue;
      for (let attempt = 1; attempt <= run.run_attempt; attempt++) {
        const previous = await known(run.id, attempt);
        if (previous && previous.problem === null) continue;
        const row: CoordinatorObservation = { version: 1, repository, collectedAt: now(), run: run.id, attempt, createdAt: run.created_at,
          conclusion: null, cancelled: null, problem: null };
        try {
          const jobs = (await api.json(`actions/runs/${run.id}/attempts/${attempt}/jobs?per_page=100`)).jobs;
          const job = Array.isArray(jobs) ? jobs.find((j: any) => j?.name === "coordinate") : undefined;
          if (!job || !positive(job.id)) throw new Error("Coordinator job unavailable");
          row.conclusion = typeof job.conclusion === "string" ? job.conclusion : null;
          // A skipped coordinator handled no main run or probe.
          row.cancelled = row.conclusion === "skipped" ? [] : coordinatorCancellations(await api.log(job.id), row.conclusion);
        } catch (error) {
          if (String(error).includes("TimingBudgetStop")) throw error;
          row.problem = String(error);
        }
        out.push(row);
      }
    }
  }
  return out;
}

function validIncident(i: IncidentObservation): boolean {
  return !!i && positive(i.run) && time(i.opened) && SHA.test(i.firstBad) && Array.isArray(i.firstBadHistory) && i.firstBadHistory.length > 0 &&
    i.firstBadHistory.every(h => SHA.test(h?.sha) && time(h.at)) && Array.isArray(i.failures) && i.failures.every(f => !!f &&
      (f.test === null || testKey(f.test)) && category(f.category) && Array.isArray(f.reasons) && f.reasons.every(r => typeof r === "string") &&
      positive(f.run) && SHA.test(f.sha) && [null, "repeated-suspected-flake", "probe-reproduced"].includes(f.escalated) &&
      (f.priorSuspectRun === null || positive(f.priorSuspectRun))) &&
    (i.incident === null || positive(i.incident)) && Array.isArray(i.fixes) && i.fixes.every(positive) &&
    Array.isArray(i.expedited) && i.expedited.every(e => positive(e?.pr) && SHA.test(e.squash) && time(e.at)) &&
    Array.isArray(i.reported) && i.reported.every(sha => SHA.test(sha)) &&
    (i.cleared === null || !!i.cleared && time(i.cleared.at) && i.cleared.at >= i.opened && (i.cleared.run === null || positive(i.cleared.run))) &&
    Array.isArray(i.sources) && i.sources.every(s => SHA.test(s));
}
function validFlake(f: FlakeObservation): boolean {
  return !!f && testKey(f.test) && category(f.category) && positive(f.run) && SHA.test(f.sha) && time(f.at) && PROBES.includes(f.probe) &&
    (f.issue === null || positive(f.issue)) && Array.isArray(f.sources) && f.sources.every(s => SHA.test(s));
}

/** Joins overlapping archives: later states enrich one incident; contradictions are refused. */
export function mergeRedMainArchives(input: RedMainArchive[]) {
  const archives = [...new Map(input.map(a => [JSON.stringify(a), a])).values()].sort((a, b) => Date.parse(a.collectedAt) - Date.parse(b.collectedAt));
  const incidents = new Map<number, IncidentObservation>(), flakes = new Map<string, FlakeObservation>();
  for (const archive of archives) {
    if (archive?.version !== 1 || !stamp(archive.collectedAt) || !stamp(archive.since) || archive.sourceRef !== RESERVATION_REF ||
      !Array.isArray(archive.incidents) || !Array.isArray(archive.flakes) ||
      (archive.error === undefined ? !SHA.test(archive.sourceHead ?? "") :
        typeof archive.error !== "string" || archive.sourceHead !== null || archive.incidents.length || archive.flakes.length) ||
      !archive.incidents.every(validIncident) || !archive.flakes.every(validFlake) ||
      archive.coordinatorScope !== undefined && (!Array.isArray(archive.coordinatorScope?.intervals) ||
        !archive.coordinatorScope.intervals.every(i => stamp(i?.since) && stamp(i.until)) || !["completed", "partial"].includes(archive.coordinatorScope.status) ||
        (archive.coordinatorScope.status === "completed") !== (archive.coordinatorScope.error === null))) throw new Error("Invalid red-main archive");
    for (const row of archive.incidents) {
      const old = incidents.get(row.run);
      if (!old) { incidents.set(row.run, structuredClone(row)); continue; }
      if (old.opened !== row.opened || old.cleared && row.cleared && JSON.stringify(old.cleared) !== JSON.stringify(row.cleared) ||
        old.incident !== null && row.incident !== null && old.incident !== row.incident) throw new Error("Conflicting red-main history");
      const history = new Map([...old.firstBadHistory, ...row.firstBadHistory].map(h => [`${h.at}/${h.sha}`, h]));
      old.firstBadHistory = [...history.values()].sort((a, b) => a.at - b.at);
      old.firstBad = old.firstBadHistory.at(-1)!.sha;
      for (const f of row.failures) if (!old.failures.some(known => failureKey(known) === failureKey(f))) old.failures.push(structuredClone(f));
      old.incident ??= row.incident; old.cleared ??= row.cleared;
      old.fixes = union([...old.fixes, ...row.fixes]);
      for (const e of row.expedited) if (!old.expedited.some(known => known.squash === e.squash)) old.expedited.push(e);
      old.reported = union([...old.reported, ...row.reported]);
      old.sources = union([...old.sources, ...row.sources]);
    }
    for (const row of archive.flakes) {
      const key = `${row.test}\n${row.run}`, old = flakes.get(key);
      if (!old) { flakes.set(key, structuredClone(row)); continue; }
      if (old.sha !== row.sha || old.category !== row.category || old.probe !== "pending" && row.probe !== "pending" && old.probe !== row.probe ||
        old.issue !== null && row.issue !== null && old.issue !== row.issue) throw new Error("Conflicting flake history");
      if (old.probe === "pending") old.probe = row.probe;
      old.issue ??= row.issue; old.at = Math.min(old.at, row.at);
      old.sources = union([...old.sources, ...row.sources]);
    }
  }
  return { archives, incidents: [...incidents.values()].sort((a, b) => a.opened - b.opened || a.run - b.run),
    flakes: [...flakes.values()].sort((a, b) => a.at - b.at || a.test.localeCompare(b.test)) };
}

/** The structural subset of a timing snapshot this report reads. */
interface Attempt {
  run: { id: number; attempt: number; path: string; event: string; head: string; status: string; conclusion: string | null; prs: number[]; attribution: string };
  jobs: { category: string; seconds: number | null; steps: { name: string; conclusion: string | null }[] }[];
  problems: string[];
}
const CI_PATH = ".github/workflows/ci.yml";
const consumed = (s: Attempt) => s.jobs.reduce((sum, job) => sum + (job.seconds ?? 0), 0);
export const gateRefused = (s: Attempt) => s.run.path === CI_PATH && s.run.event === "pull_request" &&
  s.jobs.some(j => j.category === "changeset" && j.steps.some(step => step.name === GATE_STEP && step.conclusion === "failure"));

function stopped(rows: { run: number; attempt: Attempt | null; stopped: boolean }[], reference: number | null) {
  const out = rows.map(({ run, attempt, stopped }) => {
    const known = !!attempt && attempt.run.status === "completed" && !attempt.problems.length;
    const spent = known ? consumed(attempt!) : null;
    // Proof that finished anyway saved nothing; an unmeasured run or reference is unknown, never zero.
    const saved = spent === null ? null : !stopped ? 0 : reference === null ? null : Math.max(0, reference - spent);
    return { run, attempt: attempt?.run.attempt ?? null, prs: attempt?.run.prs ?? [], conclusion: attempt?.run.conclusion ?? null,
      consumedRunnerSeconds: spent, estimatedSavedRunnerSeconds: saved };
  });
  return { runs: out, count: out.length,
    consumedRunnerSeconds: out.reduce((sum, r) => sum + (r.consumedRunnerSeconds ?? 0), 0),
    estimatedSavedRunnerSeconds: out.reduce((sum, r) => sum + (r.estimatedSavedRunnerSeconds ?? 0), 0),
    unknownConsumed: out.filter(r => r.consumedRunnerSeconds === null).length,
    unknownSaved: out.filter(r => r.estimatedSavedRunnerSeconds === null).length };
}

export interface RedMainInputs {
  archives: RedMainArchive[]; coordinator: CoordinatorObservation[]; snapshots: Attempt[]; pulls: Pick<PullObservation, "number" | "merge">[];
}
export function summarizeRedMain({ archives, coordinator, snapshots, pulls }: RedMainInputs) {
  if (!archives.length) return null;
  const { archives: scopes, incidents, flakes } = mergeRedMainArchives(archives);
  for (const c of coordinator) if (c?.version !== 1 || !positive(c.run) || !positive(c.attempt) || !stamp(c.createdAt) ||
    !(c.cancelled === null || Array.isArray(c.cancelled) && c.cancelled.every(positive)) || !(c.problem === null || typeof c.problem === "string")) throw new Error("Invalid coordinator observation");
  const attempts = [...new Map(coordinator.map(c => [`${c.run}/${c.attempt}`, c])).values()];
  const ci = snapshots.filter(s => s.run.path === CI_PATH);
  // The cancelled attempt when there is one: a later rerun of the same run is not the proof that was stopped.
  const stoppedAttempt = (run: number) => ci.filter(s => s.run.id === run)
    .sort((a, b) => Number(b.run.conclusion === "cancelled") - Number(a.run.conclusion === "cancelled") || b.run.attempt - a.run.attempt)[0] ?? null;
  // Estimate reference: what a PR CI attempt costs when it is left to finish green.
  const samples = ci.filter(s => s.run.event === "pull_request" && s.run.status === "completed" && s.run.conclusion === "success" && !s.problems.length).map(consumed);
  const reference = stats(samples).median;
  const cancelledRuns = union(attempts.flatMap(c => c.cancelled ?? [])).sort((a, b) => a - b);
  const cancellations = stopped(cancelledRuns.map(run => { const a = stoppedAttempt(run); return { run, attempt: a, stopped: a?.run.conclusion === "cancelled" }; }), reference);
  const refusedAttempts = ci.filter(gateRefused).sort((a, b) => a.run.id - b.run.id || a.run.attempt - b.run.attempt);
  const refusals = stopped(refusedAttempts.map(a => ({ run: a.run.id, attempt: a, stopped: true })), reference);
  const prFor = (sha: string) => {
    const exact = ci.filter(s => s.run.event === "push" && s.run.head === sha && s.run.attribution === "exact merged squash SHA").flatMap(s => s.run.prs);
    const numbers = union([...exact, ...pulls.filter(p => p.merge === sha).map(p => p.number)]);
    return numbers.length === 1 ? numbers[0]! : null;
  };
  const merges = incidents.flatMap(i => i.reported.map(sha => ({ incidentRun: i.run, incident: i.incident, sha, pr: prFor(sha) })));
  const rows = incidents.map(i => ({ ...i, openedAt: new Date(i.opened).toISOString(), clearedAt: i.cleared ? new Date(i.cleared.at).toISOString() : null,
    timeToGreenSeconds: i.cleared ? (i.cleared.at - i.opened) / 1000 : null, categories: union(i.failures.map(f => f.category)).sort() }));
  const tests = union(flakes.map(f => f.test));
  const escalations = incidents.flatMap(i => i.failures.filter(f => f.escalated).map(f => ({ test: failureKey(f), incidentRun: i.run, run: f.run, reason: f.escalated!, priorSuspectRun: f.priorSuspectRun })));
  const flakeRows = union([...tests, ...escalations.map(e => e.test)]).map(test => {
    const suspects = flakes.filter(f => f.test === test), raised = escalations.filter(e => e.test === test);
    return { test, category: suspects[0]?.category ?? incidents.flatMap(i => i.failures).find(f => failureKey(f) === test)!.category,
      suspects: suspects.length, runs: suspects.map(s => s.run),
      probes: Object.fromEntries(PROBES.map(p => [p, suspects.filter(s => s.probe === p).length])) as Record<Probe, number>,
      issues: union(suspects.flatMap(s => s.issue === null ? [] : [s.issue])), verdict: raised.length ? "real" as const : "suspected-flake" as const, escalations: raised };
  });
  const unknownLogs = attempts.filter(c => c.cancelled === null);
  // Red hours whose coordinator logs were never read leave cancellations unknown, not zero.
  const unread = incidents.length ? scopes.filter(a => a.error === undefined && a.coordinatorScope?.status !== "completed") : [];
  return {
    acquisition: { complete: scopes.every(a => a.error === undefined) && !unknownLogs.length && !unread.length,
      scopes: scopes.map(({ repository, collectedAt, since, sourceRef, sourceHead, error, coordinatorScope }) =>
        ({ repository, collectedAt, since, sourceRef, sourceHead, error, coordinatorScope: coordinatorScope ?? null })),
      coordinatorScopesUnread: unread.length,
      coordinatorAttempts: attempts.length,
      coordinatorUnknown: unknownLogs.map(c => ({ run: c.run, attempt: c.attempt, problem: c.problem })) },
    incidents: rows, openIncidents: rows.filter(r => !r.cleared).length,
    timeToGreenSeconds: stats(rows.flatMap(r => r.timeToGreenSeconds === null ? [] : [r.timeToGreenSeconds])),
    flakes: flakeRows,
    cancellations, refusals,
    savingReference: { label: "Median observed runner time of successful PR CI attempts in this archive; an estimate, not measured savings",
      samples: samples.length, runnerSeconds: reference },
    mergesDuringRed: { count: merges.length, unknownPR: merges.filter(m => m.pr === null).length, rows: merges },
  };
}

export function redMainMarkdown(report: ReturnType<typeof summarizeRedMain>): string {
  if (!report) return "\n## Red-main incidents\n\nRed-main evidence is unknown: no red-main history archive was collected.\n";
  const minutes = (n: number | null) => n === null ? "unknown" : (n / 60).toFixed(2);
  const iso = (n: string | null) => n ?? "open";
  const cell = (s: string) => s.replaceAll("|", "\\|");
  const gaps = report.acquisition.scopes.filter(s => s.error !== undefined).length;
  const stop = (label: string, s: typeof report.cancellations) => `${label}: ${s.count} runs; consumed runner minutes ${minutes(s.consumedRunnerSeconds)}` +
    ` (unknown for ${s.unknownConsumed}); estimated saved runner minutes ${minutes(s.estimatedSavedRunnerSeconds)} (unknown for ${s.unknownSaved}).`;
  return ["", "## Red-main incidents", "",
    `History scopes: ${report.acquisition.scopes.length}; acquisition gaps: ${gaps}; scopes without coordinator logs: ${report.acquisition.coordinatorScopesUnread}; coordinator attempts read: ${report.acquisition.coordinatorAttempts}; with unknown cancellations: ${report.acquisition.coordinatorUnknown.length}.`, "",
    ...(report.incidents.length ? ["| Opening run | First bad | Opened | Cleared | Time to green min | Incident | Failing tests and categories | Fixes |",
      "| ---: | --- | --- | --- | ---: | --- | --- | --- |",
      ...report.incidents.map(i => `| ${i.run} | \`${i.firstBad.slice(0, 12)}\` | ${i.openedAt} | ${iso(i.clearedAt)} | ${minutes(i.timeToGreenSeconds)} | ${i.incident === null ? "pending" : `#${i.incident}`} | ${cell(i.failures.map(f => `${f.test ?? f.category} (${f.category}${f.escalated ? `, escalated: ${f.escalated}` : ""})`).join("; "))} | ${i.fixes.map(n => `#${n}`).join(", ") || "none"} |`), ""]
      : ["No red-main incident in the collected history.", ""]),
    `Time to green: median ${minutes(report.timeToGreenSeconds.median)} min, p90 ${minutes(report.timeToGreenSeconds.p90)} min over ${report.timeToGreenSeconds.n} cleared incidents; still open: ${report.openIncidents}.`, "",
    "### Flake verdicts", "",
    ...(report.flakes.length ? ["| Test | Suspected | Probes passed / failed / pending / unavailable | Verdict | Escalation |", "| --- | ---: | --- | --- | --- |",
      ...report.flakes.map(f => `| ${cell(f.test)} | ${f.suspects} | ${f.probes.passed} / ${f.probes.failed} / ${f.probes.pending} / ${f.probes.unavailable} | ${f.verdict} | ${f.escalations.map(e => `${e.reason} in run ${e.run}${e.priorSuspectRun ? ` after suspect run ${e.priorSuspectRun}` : ""}`).join("; ") || "none"} |`), ""]
      : ["No suspected flake in the collected history.", ""]),
    "### Proof stopped while red", "",
    stop("Cancelled by the coordinator", report.cancellations),
    stop("Refused by the hosted gate", report.refusals),
    `${report.savingReference.label}: ${minutes(report.savingReference.runnerSeconds)} min from ${report.savingReference.samples} attempts.`, "",
    "### Merges during red", "",
    ...(report.mergesDuringRed.rows.length ? ["| Squash | PR | Incident run |", "| --- | --- | ---: |",
      ...report.mergesDuringRed.rows.map(m => `| \`${m.sha.slice(0, 12)}\` | ${m.pr === null ? "unknown" : `#${m.pr}`} | ${m.incidentRun} |`), ""]
      : ["No non-fix squash was reported landing while red.", ""]),
  ].join("\n");
}
