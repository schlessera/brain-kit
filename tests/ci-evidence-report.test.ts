import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { GitArchiveStore, publishBatch, type ArchiveKind } from "../scripts/ci-archive";
import { archiveSince, evidenceMarkdown, evidenceReport, hourRanges, type Cadence } from "../scripts/ci-evidence-report";
import { reportWorkflowProblems } from "../scripts/check-ci-workflows";
import { archiveInputs, type ReportInputs } from "../scripts/ci-timings";
import type { EpochSource } from "../scripts/ci-epochs";

const repository = "odysseus/chronicle";
const HOUR = 3_600_000, DAY = 86_400_000;
const ms = (at: string) => Date.parse(at), iso = (at: number) => new Date(at).toISOString();
const sha = (n: number) => n.toString(16).padStart(40, "0");
const UNTIL = "2026-07-13T00:00:00.000Z", NOW = "2026-07-13T03:40:00.000Z";
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

interface Delivery { number: number; merged: string; outcome: "success" | "failure"; lines: number }
/** Five deliveries in the week before the pinned date; the last one's first main run fails. */
const PRS: readonly Delivery[] = [
  { number: 41, merged: "2026-07-07T09:00:00.000Z", outcome: "success", lines: 20 },
  { number: 42, merged: "2026-07-08T09:00:00.000Z", outcome: "success", lines: 120 },
  { number: 43, merged: "2026-07-09T09:00:00.000Z", outcome: "success", lines: 30 },
  { number: 44, merged: "2026-07-10T09:00:00.000Z", outcome: "success", lines: 700 },
  { number: 45, merged: "2026-07-11T09:00:00.000Z", outcome: "failure", lines: 40 },
];
/** Creation to start for every job, by event: the runner-slot wait the report must recompute. */
const WAIT = { pull_request: 60, push: 600 } as const;
const INCIDENT = 9001, INCIDENT_OPENED = "2026-07-10T10:00:00.000Z", INCIDENT_CLEARED = "2026-07-10T11:30:00.000Z";

function run(id: number, event: "pull_request" | "push", head: string, pr: number, created: string, conclusion: string) {
  const start = iso(ms(created) + WAIT[event] * 1000), end = iso(ms(start) + 20 * 60000);
  return { version: 2, repository, collectedAt: iso(ms(created) + 2 * HOUR), run: { id, attempt: 1, workflow: "CI", path: ".github/workflows/ci.yml", event, head,
    branch: event === "push" ? "main" : `ithaca-${pr}`, headRepository: repository, createdAt: created, startedAt: created, status: "completed", conclusion,
    prs: [pr], attribution: event === "push" ? "exact merged squash SHA" : "run payload" },
    jobs: [{ id: id * 10, name: "proof", category: "proof", conclusion, labels: [], execution: "observed", createdAt: created, startedAt: start, completedAt: end,
      seconds: 1200, steps: [], resource: null, resourceProblem: null }], problems: [] };
}
const pull = (p: Delivery) => ({ version: 1, repository, number: p.number, collectedAt: iso(ms(p.merged) + HOUR), createdAt: iso(ms(p.merged) - 5 * HOUR),
  mergedAt: p.merged, closedAt: p.merged, head: sha(p.number), merge: sha(p.number + 1000), baseBranch: "main", changedFiles: 2, additions: p.lines, deletions: 0,
  timeline: [{ event: "ready_for_review", at: iso(ms(p.merged) - 3 * HOUR) }], problems: [] });
const collection = (id: string, since: string, until: string, expected: { run: number; attempts: number }[], status = "completed") => ({
  version: 1, id, repository, collectedAt: until, status, since, until, requestedRun: null, expected, resourcesRequested: false, errors: [],
  requestBudget: { limit: 200, reserve: 500, requests: 4, remaining: 900, stopped: null }, seed: null });
const failure = (test: string) => ({ test, category: "unit", reasons: ["in-affected-closure"], run: INCIDENT, sha: sha(44 + 1000), escalated: null, priorSuspectRun: null });
const redMain = (collected: string, incidents: object[], flakes: object[] = []) => ({ version: 1, repository, collectedAt: collected,
  sourceRef: "refs/heads/brain-integration-reservation", sourceHead: sha(7), since: iso(ms(collected) - 2 * DAY), incidents, flakes });
const incident = (cleared: string | null) => ({ run: INCIDENT, opened: ms(INCIDENT_OPENED), firstBad: sha(1044), firstBadHistory: [{ sha: sha(1044), at: ms(INCIDENT_OPENED) }],
  failures: [failure("tests/ithaca-loom.test.ts")], incident: 610, fixes: [46], expedited: [], reported: [],
  cleared: cleared ? { at: ms(cleared), run: 9003 } : null, sources: [sha(7)] });
const flake = { test: "tests/sirens-call.test.ts", category: "browser", run: 9002, sha: sha(1043), at: ms("2026-07-09T08:00:00.000Z"), probe: "passed", issue: null, sources: [sha(7)] };
const classified = { version: 1, id: "classified-9001", repository, kind: "failure-classified", at: "2026-07-10T12:00:00.000Z", run: INCIDENT, attempt: 1,
  classification: "test", evidence: `https://github.com/${repository}/actions/runs/${INCIDENT}` };
const wait = (id: string, kind: string, at: string) => ({ version: 1, id, repository, kind, at, worker: "worker-1", task: "ithaca-loom", reason: "ci" });

interface Fixture { prs?: readonly Delivery[]; gap?: string; boundary?: string; events?: object[]; red?: object[] | null }
/** The archive's records for one world, by kind. */
function world(f: Fixture = {}) {
  const prs = f.prs ?? PRS;
  const runs = prs.flatMap(p => [run(p.number * 10 + 1, "pull_request", sha(p.number), p.number, iso(ms(p.merged) - 2 * HOUR), "success"),
    run(p.number * 10 + 2, "push", sha(p.number + 1000), p.number, iso(ms(p.merged) + 60000), p.outcome)]);
  const expected = runs.map(r => ({ run: r.run.id, attempts: 1 })), start = iso(ms(UNTIL) - 10 * DAY);
  const collections = f.gap ? [collection("before-gap", start, f.gap, expected), collection("after-gap", iso(ms(f.gap) + HOUR), UNTIL, [])]
    : [collection("hourly", start, UNTIL, expected)];
  const red = f.red !== undefined ? f.red : [redMain("2026-07-05T00:00:00.000Z", []), redMain("2026-07-10T12:00:00.000Z", [incident(INCIDENT_CLEARED)], [flake])];
  const events = f.events ?? [classified, wait("wait-a", "wait-started", "2026-07-09T10:00:00.000Z"), wait("wait-b", "wait-finished", "2026-07-09T10:30:00.000Z")];
  return { runs, collections, pulls: prs.map(pull), red: red ?? [], events, enrichment: [{ version: 1, repository, collectedAt: "2026-07-11T12:00:00.000Z", expectedPRs: prs.map(p => p.number), errors: [] }] };
}
const inputs = (w: ReturnType<typeof world>): ReportInputs => ({ snapshots: w.runs as never, collections: w.collections, operational: {
  pulls: w.pulls as never, events: w.events as never, acquisitions: w.enrichment as never, reservations: [], redMain: w.red as never, coordinator: [] } });

/** Main's first-parent history: each delivery's squash and one proof-system boundary, newest first. */
function history(prs: readonly Delivery[], boundary = iso(ms(UNTIL) - 10 * DAY)): EpochSource {
  const commits = [...prs.map(p => ({ sha: sha(p.number + 1000), at: p.merged })), { sha: sha(1), at: boundary }, { sha: sha(2), at: iso(ms(boundary) - DAY) }]
    .sort((a, b) => ms(b.at) - ms(a.at));
  return { ref: "main", history: commits.map((c, i) => ({ ...c, parents: commits[i + 1] ? [commits[i + 1]!.sha] : [] })),
    classify: c => ({ proofSystem: c.sha === sha(1) }) };
}
const report = (cadence: Cadence, until: string, f: Fixture = {}) =>
  evidenceReport(inputs(world(f)), { cadence, until, now: NOW, epochSource: history(f.prs ?? PRS, f.boundary) });

function git(root: string, ...args: string[]) {
  const p = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  expect(p.exitCode, new TextDecoder().decode(p.stderr)).toBe(0);
  return new TextDecoder().decode(p.stdout).trim();
}
/** Publishes the world through the archive writer to a bare remote, returning a clone that reads it. */
async function archived(w: ReturnType<typeof world>) {
  const root = mkdtempSync(join(tmpdir(), "odysseus-evidence-")); dirs.push(root);
  const remote = join(root, "remote.git"), clone = join(root, "clone");
  git(root, "init", "-q", "--bare", remote); mkdirSync(clone); git(clone, "init", "-q"); git(clone, "remote", "add", "origin", remote);
  const records = ([["run", w.runs], ["collection", w.collections], ["pull", w.pulls], ["red-main", w.red], ["event", w.events], ["enrichment", w.enrichment]] as const)
    .flatMap(([kind, rows]) => (rows as object[]).map(row => ({ kind: kind as ArchiveKind, row: row as Record<string, unknown> })));
  const published = await publishBatch(new GitArchiveStore(clone), repository, { records, refused: [], sources: [] });
  expect(published.refused).toEqual([]);
  return { root, clone };
}

test("the weekly report's numbers match a manual recomputation of the same window from the archive", async () => {
  const w = world(), { clone } = await archived(w);
  const loaded = await archiveInputs("origin", repository, archiveSince(UNTIL), UNTIL, clone);
  const r = evidenceReport(loaded, { cadence: "weekly", until: UNTIL, now: NOW, epochSource: history(PRS), archiveHead: loaded.head });
  const since = ms(UNTIL) - 7 * DAY, inWeek = (at: string) => ms(at) >= since && ms(at) < ms(UNTIL);

  // Recomputed by hand from the fixture's own definitions.
  const merged = PRS.filter(p => inWeek(p.merged)), green = merged.filter(p => p.outcome === "success");
  expect(r.window, "WEEKLY_WINDOW").toEqual({ since: iso(since), until: UNTIL });
  expect(r.throughput.mergedInWindow, "MERGED").toBe(merged.length);
  expect(r.throughput.firstPassGreen, "FIRST_MAIN_GREEN").toEqual({ numerator: green.length, denominator: merged.length, percent: 100 * green.length / merged.length });
  expect(r.throughput.mergedPerDay).toBeCloseTo(merged.length / 7, 10);
  expect(r.throughput.firstPassGreenPerDay).toBeCloseTo(green.length / 7, 10);
  expect(r.throughput.createToMergeSeconds, "CREATE_TO_MERGE").toEqual({ n: 5, mean: 5 * 3600, median: 5 * 3600, p90: 5 * 3600 });
  expect(Object.fromEntries(Object.entries(r.throughput.sizeCohorts).map(([k, v]) => [k, v.prs])))
    .toEqual({ "0-50 changed lines": 3, "51-500 changed lines": 1, "501+ changed lines": 1 });

  const waits = w.runs.filter(s => inWeek(s.run.createdAt)).map(s => WAIT[s.run.event as keyof typeof WAIT]).sort((a, b) => a - b);
  expect(r.runnerSlotWait!.overall, "RUNNER_SLOT_WAIT").toEqual({ n: waits.length, mean: waits.reduce((a, b) => a + b, 0) / waits.length,
    median: (waits[4]! + waits[5]!) / 2, p90: waits[8]!, max: 600, unknown: 0,
    overFiveMinutes: { numerator: waits.filter(s => s > 300).length, denominator: waits.length, percent: 50 } });

  expect(r.redMain!.incidents.map(i => [i.run, i.timeToGreenSeconds, i.newlyObserved]), "INCIDENT_TIME_TO_GREEN")
    .toEqual([[INCIDENT, (ms(INCIDENT_CLEARED) - ms(INCIDENT_OPENED)) / 1000, true]]);
  expect(r.redMain!.timeToGreenSeconds.median).toBe(5400);
  expect(r.families.failing, "FAILING_FAMILIES").toEqual([{ family: "tests/ithaca-loom.test.ts", category: "unit", incidents: 1, runs: 1 }]);
  expect(r.families.suspectedFlaky.map(f => [f.family, f.suspicions, f.probes.passed, f.verdict])).toEqual([["tests/sirens-call.test.ts", 1, 1, "suspected-flake"]]);
  expect(r.families.firstMainFailedJobCategories).toEqual({ proof: 1 });
  expect(r.families.classifications).toEqual({ test: 1 });
  expect(r.localContention!.waits.ci, "LOCAL_CONTENTION").toEqual({ n: 1, mean: 1800, median: 1800, p90: 1800 });
  expect(r.epochs!.map(e => [e.id, e.kind, e.merges, e.firstMainGreen.percent])).toEqual([[sha(1), "proof-system", 5, 80]]);

  const perDay = Array.from({ length: 7 }, (_, n) => iso(since + n * DAY).slice(0, 10)).map(day => ({ day,
    runs: w.runs.filter(s => s.run.createdAt.startsWith(day)).length, merges: PRS.filter(p => p.merged.startsWith(day)).length }));
  expect(r.activity.map(d => ({ day: d.day, runs: d.runAttempts, merges: d.merges })), "ACTIVITY_BY_DAY").toEqual(perDay);
  expect(r.coverage, "COMPLETE_COVERAGE").toMatchObject({ complete: true, collectionHours: { expected: 168, covered: 168, missing: [], partialOnly: [] },
    failedAcquisitions: [], missingAttempts: [] });
  expect(r.coverage.unknowns.map(u => u.field)).toEqual(["escapeClasses", "reservationDemand", "reservation"]);
  expect(r.gate.status).toBe("met");
  expect(r.detail!.throughput.prs.map(p => p.number)).toEqual(merged.map(p => p.number));
  expect(r.archive.head).toBe(git(clone, "ls-remote", "origin", "refs/heads/brain-ci-metrics").split(/\s/)[0]!);
});

test("a missing collection hour is listed under coverage and never reads as zero activity", () => {
  const gap = "2026-07-10T05:00:00.000Z", r = report("daily", "2026-07-11T00:00:00.000Z", { gap });
  expect(r.coverage.collectionHours, "MISSING_HOUR_LISTED").toEqual({ expected: 24, covered: 23, missing: [gap], partialOnly: [] });
  expect(r.coverage.complete).toBe(false);
  expect(r.activity, "MISSING_HOUR_NOT_ZERO").toEqual([{ day: "2026-07-10", missingHours: 1, complete: false, runAttempts: null, merges: null,
    observedRunAttempts: 2, observedMerges: 1 }]);
  expect(r.gate.conditions.firstMainGreen, "GAP_LEAVES_GATE_UNKNOWN").toMatchObject({ status: "unknown" });
  const md = evidenceMarkdown(r);
  expect(md).toContain("- 2026-07-10T05:00Z");
  expect(md).toContain("| 2026-07-10 | unknown (2 observed) | unknown (1 observed) | 1 |");
  expect(md).toContain("**Coverage is incomplete**");
  expect(md).not.toMatch(/\| 2026-07-10 \| 0 \|/);
  expect(hourRanges([gap, "2026-07-10T06:00:00.000Z", "2026-07-10T09:00:00.000Z"])).toEqual(["2026-07-10T05:00Z–2026-07-10T07:00Z", "2026-07-10T09:00Z"]);
});

test("an hour covered only by a partial collection is listed but is not a gap", () => {
  const w = world(), r = evidenceReport({ ...inputs(w), collections: [{ ...w.collections[0]!, status: "partial", errors: [{ run: 0, attempt: 0, error: "budget" }] }] },
    { cadence: "daily", until: "2026-07-11T00:00:00.000Z", now: NOW, epochSource: history(PRS) });
  expect(r.coverage.collectionHours.missing).toEqual([]);
  expect(r.coverage.collectionHours.partialOnly).toHaveLength(24);
  expect(r.coverage.failedAcquisitions.map(f => f.source)).toEqual(["collection hourly"]);
  expect(r.triggers.collectionGap).toBe(false);
});

test("the gate is met exactly when all three conditions hold, and names each failing condition", () => {
  const met = report("weekly", UNTIL);
  expect(met.gate, "GATE_MET").toMatchObject({ status: "met", failing: [] });
  expect(met.gate.conditions.firstMainGreen, "EIGHTY_PERCENT_IS_MET").toMatchObject({ status: "met", numerator: 4, denominator: 5 });

  // All green, so only the epoch's age can fail.
  const young = report("weekly", UNTIL, { boundary: iso(ms(UNTIL) - 3 * DAY), prs: PRS.map(p => ({ ...p, outcome: "success" })) });
  expect(young.gate, "EPOCH_TOO_YOUNG").toMatchObject({ status: "not met", failing: ["epoch"] });
  expect(young.gate.conditions.epoch.reason).toBe(`3.00 days in epoch ${sha(1)}, fewer than 7`);

  const red = report("weekly", UNTIL, { prs: PRS.map((p, n) => n < 2 ? { ...p, outcome: "failure" } : p) });
  expect(red.gate, "FIRST_MAIN_BELOW_EIGHTY").toMatchObject({ status: "not met", failing: ["firstMainGreen"] });
  expect(red.gate.conditions.firstMainGreen.reason).toBe("2/5 first-main green (40.0%)");

  const unattributed = report("weekly", UNTIL, { events: [] });
  expect(unattributed.gate, "INCIDENT_UNATTRIBUTED").toMatchObject({ status: "not met", failing: ["incidentsAttributed"] });
  expect(unattributed.gate.conditions.incidentsAttributed).toMatchObject({ status: "not met", incidents: [INCIDENT], unattributed: [INCIDENT] });

  const unknown = report("weekly", UNTIL, { red: null });
  expect(unknown.gate, "NO_RED_MAIN_HISTORY_IS_NOT_MET").toMatchObject({ status: "not met", failing: ["incidentsAttributed"] });
  expect(unknown.gate.conditions.incidentsAttributed.status).toBe("unknown");

  const noHistory = evidenceReport(inputs(world()), { cadence: "weekly", until: UNTIL, now: NOW });
  expect(noHistory.gate.failing, "NO_HISTORY_IS_NOT_MET").toEqual(["epoch", "firstMainGreen"]);
  expect(noHistory.gate.conditions.epoch).toMatchObject({ status: "unknown", reason: "no proof-policy history was supplied" });
});

test("the digest's changed flag is true for each trigger and false otherwise", () => {
  const quiet = report("daily", "2026-07-13T00:00:00.000Z");
  expect([quiet.changed, quiet.triggers], "UNCHANGED_DAY").toEqual([false, { newIncidents: [], gateChanged: null, collectionGap: false }]);

  const incidentDay = report("daily", "2026-07-11T00:00:00.000Z");
  expect([incidentDay.changed, incidentDay.triggers], "NEW_INCIDENT").toEqual([true, { newIncidents: [INCIDENT], gateChanged: null, collectionGap: false }]);

  // The same incident, still open and observed again the next day, is not new.
  const again = [redMain("2026-07-05T00:00:00.000Z", []), redMain("2026-07-10T12:00:00.000Z", [incident(null)]), redMain("2026-07-11T12:00:00.000Z", [incident(null)])];
  const reobserved = report("daily", "2026-07-12T00:00:00.000Z", { red: again });
  expect(reobserved.redMain!.incidents.map(i => [i.run, i.newlyObserved]), "REOBSERVED_NOT_NEW").toEqual([[INCIDENT, false]]);
  expect([reobserved.changed, reobserved.triggers], "REOBSERVED_INCIDENT_UNCHANGED").toEqual([false, { newIncidents: [], gateChanged: null, collectionGap: false }]);

  const matured = report("daily", "2026-07-12T00:00:00.000Z", { boundary: "2026-07-04T12:00:00.000Z" });
  expect([matured.changed, matured.triggers], "GATE_CHANGE").toEqual([true, { newIncidents: [], gateChanged: { from: "not met", to: "met" }, collectionGap: false }]);

  // Without main's history the gate is not met on either day, so the gap is the only trigger.
  const gap = evidenceReport(inputs(world({ gap: "2026-07-12T20:00:00.000Z" })), { cadence: "daily", until: "2026-07-13T00:00:00.000Z", now: NOW });
  expect([gap.changed, gap.triggers], "COLLECTION_GAP").toEqual([true, { newIncidents: [], gateChanged: null, collectionGap: true }]);
});

test("the CLI writes the stable digest files from the archive and refuses a window off the hour", async () => {
  const { root, clone } = await archived(world());
  const script = resolve(import.meta.dir, "../scripts/ci-evidence-report.ts"), out = join(root, "out");
  const cli = (...args: string[]) => {
    const child = Bun.spawnSync([process.execPath, script, "--repo", repository, "--from-archive", "origin", "--out", out, ...args], { cwd: clone, stdout: "pipe", stderr: "pipe" });
    return { code: child.exitCode, out: new TextDecoder().decode(child.stdout), err: new TextDecoder().decode(child.stderr) };
  };
  const daily = cli("--cadence", "daily", "--until", "2026-07-11T00:00:00Z", "--history", "main");
  expect(daily.code, daily.err).toBe(0);
  expect(JSON.parse(daily.out)).toMatchObject({ cadence: "daily", changed: true, gate: "not met" });
  const digest = JSON.parse(readFileSync(join(out, "digest.json"), "utf8"));
  expect(digest.triggers.newIncidents, "CLI_READS_ARCHIVE").toEqual([INCIDENT]);
  expect(digest.gate.conditions.epoch.status, "UNREADABLE_HISTORY_UNKNOWN").toBe("unknown");
  expect(readFileSync(join(out, "digest.md"), "utf8")).toStartWith("# CI evidence digest, 2026-07-10\n");
  const off = cli("--cadence", "weekly", "--until", "2026-07-11T00:30:00Z");
  expect(off.code, "OFF_HOUR_REFUSED").toBe(1);
  expect(off.err).toContain("A report window ends on a whole UTC hour");
});

test("only trusted read-only scheduled execution generates the reports", () => {
  const workflow = readFileSync(resolve(import.meta.dir, "../.github/workflows/ci-evidence-report.yml"), "utf8");
  expect(reportWorkflowProblems(workflow)).toEqual([]);
  const problem = (text: string) => reportWorkflowProblems(text);
  expect(problem(workflow.replace("      contents: read", "      contents: write")), "REPORT_JOB_READ_ONLY")
    .toContain("ci-evidence-report.yml: the report job may only read contents");
  expect(problem(workflow.replace("      contents: read", "      contents: read\n      issues: write")))
    .toContain("ci-evidence-report.yml: the report job may only read contents");
  expect(problem(workflow.replace("permissions: {}", "permissions:\n  contents: read")))
    .toContain("ci-evidence-report.yml: workflow token must grant nothing");
  expect(problem(workflow.replace("  schedule:", "  pull_request:\n  schedule:")))
    .toContain("ci-evidence-report.yml: reports must use scheduled/manual trusted execution only");
  expect(problem(workflow.replace("fetch-depth: 0", "fetch-depth: 1")))
    .toContain("ci-evidence-report.yml: reports must check out trusted default-branch code with full history");
  expect(problem(workflow.replace("retention-days: 90", "retention-days: 30")))
    .toContain("ci-evidence-report.yml: the report artifacts must always be uploaded for 90 days");
  expect(problem(workflow.replace('"37 3 * * *"', '"37 * * * *"'))).toContain("ci-evidence-report.yml: reports must run once a day");
  expect(problem(workflow.replace("--from-archive origin --out tmp/ci-evidence\n          if", "--from-archive origin --out tmp/ci-evidence\n          bun install\n          if")))
    .toContain("ci-evidence-report.yml: report scripts must not interpolate events or install dependencies");
});
