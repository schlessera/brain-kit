import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectCoordinatorRuns, collectRedMainHistory, coordinatorCancellations, GATE_STEP, mergeRedMainArchives, observeRedMain, redIntervals,
  redMainMarkdown, summarizeRedMain, type CoordinatorObservation, type RedMainArchive } from "../scripts/ci-red-main";
import { normalizeJob, type TimingSnapshot } from "../scripts/ci-timings";
import { emptyReservation, GitReservationStore, reservationTransition } from "../scripts/integration-reservation";
import { addSuspect, attachIncident, classifyFailure, clearRed, declareFix, emptyRedMain, openRed, refineFirstBad, reportLanded, settleSuspect,
  type RedFailure, type RedMainRecord } from "../scripts/red-main";

const repo = "odysseus/chronicle";
const A = "a".repeat(40), B = "b".repeat(40), C = "c".repeat(40), D = "d".repeat(40);
const T0 = Date.parse("2026-07-12T10:00:00Z"), minute = 60_000;
const iso = (offset: number) => new Date(T0 + offset * minute).toISOString();
const raft = "packages/core/tests/raft.test.ts";
const real = (test: string | null, reasons = ["in-affected-closure"], run = 100, sha = B): RedFailure => ({ test, category: "unit", verdict: "real", reasons, run, sha });
const covering = (record: RedMainRecord) => ({ id: 400, conclusion: "success", included: { run: record.open!.run, firstBad: record.open!.firstBad, failures: record.open!.failures } });

/** Applies each step to the previous record, in order, as the coordinator publishes them. */
function lifecycle(steps: ((r: RedMainRecord) => RedMainRecord)[], start = emptyRedMain()): RedMainRecord[] {
  const out: RedMainRecord[] = [];
  let record = start;
  for (const step of steps) out.push(record = step(record));
  return out;
}
const sources = (records: RedMainRecord[]) => records.map((record, i) => ({ source: String(i + 1).padStart(40, "0"), record }));
function archive(records: RedMainRecord[], collectedAt = iso(200)): RedMainArchive {
  return { version: 1, repository: repo, collectedAt, sourceRef: "refs/heads/brain-integration-reservation", sourceHead: D, since: iso(-60),
    coordinatorScope: { intervals: [], status: "completed", error: null }, ...observeRedMain(sources(records)) };
}
function attempt(id: number, conclusion: string, seconds: number, event = "pull_request", extra: Partial<TimingSnapshot["run"]> = {}, steps: { name: string; conclusion: string }[] = []): TimingSnapshot {
  const job = normalizeJob({ id: id * 10, run_id: id, name: "changeset", status: "completed", conclusion, started_at: iso(0), completed_at: new Date(T0 + seconds * 1000).toISOString(),
    steps: [{ name: "Set up job", number: 1, status: "completed", conclusion: "success", started_at: iso(0), completed_at: iso(0) },
      ...steps.map((step, i) => ({ ...step, number: i + 2, status: "completed", started_at: iso(0), completed_at: iso(0) }))] });
  return { version: 1, repository: repo, collectedAt: iso(200), problems: [], jobs: [job],
    run: { id, attempt: 1, workflow: "CI", path: ".github/workflows/ci.yml", event, head: A, createdAt: iso(0), startedAt: iso(0),
      status: "completed", conclusion, prs: [42], attribution: "run payload", ...extra } };
}

/** The ruled lifecycle: opened, refined, incident filed, fix declared, a non-fix landing, cleared 90 minutes later. */
const incidentLifecycle = (start = emptyRedMain()) => lifecycle([
  r => openRed(r, { firstBad: C, run: 100, failures: [real(raft)] }, T0),
  r => refineFirstBad(r, B, 101, T0 + minute),
  r => attachIncident(r, 500, T0 + 2 * minute),
  r => declareFix(r, 8, T0 + 3 * minute),
  r => reportLanded(r, C, T0 + 4 * minute),
  r => openRed(r, { firstBad: B, run: 100, failures: [real(null, ["closure-unknown"]), real(raft)] }, T0 + 5 * minute),
  r => clearRed(r, covering(r), T0 + 90 * minute),
], start);

test("a fixture red-main lifecycle produces one incident record with its time to green", () => {
  const records = incidentLifecycle();
  // Overlapping hourly archives each see part of the same lifecycle.
  const early = archive(records.slice(0, 4), iso(30)), late = archive(records, iso(200));
  const report = summarizeRedMain({ archives: [early, late, late], coordinator: [], snapshots: [], pulls: [] })!;
  expect(report.incidents, "ONE_INCIDENT_PER_RECORD").toHaveLength(1);
  const [incident] = report.incidents;
  expect(incident!.timeToGreenSeconds, "TIME_TO_GREEN_FROM_OPEN_TO_CLEAR").toBe(90 * 60);
  expect(incident).toMatchObject({ run: 100, firstBad: B, incident: 500, fixes: [8], reported: [C], cleared: { at: T0 + 90 * minute, run: 400 },
    openedAt: iso(0), clearedAt: iso(90), categories: ["unit"] });
  expect(incident!.firstBadHistory).toEqual([{ sha: C, at: T0 }, { sha: B, at: T0 + minute }]);
  expect(incident!.failures.map(f => f.test)).toEqual([raft, null]);
  expect(report.timeToGreenSeconds).toMatchObject({ n: 1, median: 5400 });
  expect(report.openIncidents).toBe(0);
  // An archive that saw only the open record keeps the incident open, not green.
  const open = summarizeRedMain({ archives: [early], coordinator: [], snapshots: [], pulls: [] })!;
  expect(open.incidents[0]!.timeToGreenSeconds, "OPEN_INCIDENT_HAS_NO_TIME_TO_GREEN").toBeNull();
  expect(open.openIncidents).toBe(1);
  expect(redMainMarkdown(report)).toContain("| 100 | `bbbbbbbbbbbb` | 2026-07-12T10:00:00.000Z | 2026-07-12T11:30:00.000Z | 90.00 | #500 |");
});

test("a suspected flake followed by a second suspected flake on the same test shows the escalation to real", () => {
  const first = { test: raft, category: "unit" as const, signature: "timeout" as const, inClosure: false };
  const records = lifecycle([
    r => addSuspect(r, { test: raft, category: "unit", run: 100, sha: A, at: T0 }, T0),
    r => settleSuspect(r, { test: raft, run: 100 }, { issue: 600 }, T0 + minute),
    r => settleSuspect(r, { test: raft, run: 100 }, { probe: "passed" }, T0 + 20 * minute),
  ]);
  expect(classifyFailure(first, emptyRedMain(), T0).verdict).toBe("suspected-flake");
  // The same timeout outside the closure a day later: the estimator escalates it.
  const second = classifyFailure(first, records.at(-1)!, T0 + 24 * 60 * minute);
  expect(second.verdict).toBe("real");
  records.push(openRed(records.at(-1)!, { firstBad: B, run: 200, failures: [real(raft, second.reasons, 200, B)] }, T0 + 24 * 60 * minute));
  const report = summarizeRedMain({ archives: [archive(records)], coordinator: [], snapshots: [], pulls: [] })!;
  expect(report.flakes).toHaveLength(1);
  expect(report.flakes[0], "ESCALATED_TO_REAL").toMatchObject({ test: raft, suspects: 1, runs: [100], issues: [600],
    probes: { passed: 1, failed: 0, pending: 0, unavailable: 0 }, verdict: "real",
    escalations: [{ incidentRun: 200, run: 200, reason: "repeated-suspected-flake", priorSuspectRun: 100 }] });
  expect(report.incidents[0]!.failures[0]).toMatchObject({ escalated: "repeated-suspected-flake", priorSuspectRun: 100 });
  expect(redMainMarkdown(report)).toContain("| real | repeated-suspected-flake in run 200 after suspect run 100 |");
  // Without the second failure the verdict stays a suspicion.
  const single = summarizeRedMain({ archives: [archive(records.slice(0, 3))], coordinator: [], snapshots: [], pulls: [] })!;
  expect(single.flakes[0]!.verdict, "ONE_SUSPICION_IS_NOT_REAL").toBe("suspected-flake");
});

test("runner minutes saved by cancellation and refusal are reported with unknowns counted separately", () => {
  const records = incidentLifecycle();
  const coordinator: CoordinatorObservation[] = [
    { version: 1, repository: repo, collectedAt: iso(200), run: 900, attempt: 1, createdAt: iso(0), conclusion: "success", cancelled: [300, 301, 302], problem: null },
    { version: 1, repository: repo, collectedAt: iso(200), run: 901, attempt: 1, createdAt: iso(10), conclusion: "failure", cancelled: null, problem: null },
  ];
  const snapshots = [
    attempt(300, "cancelled", 120),
    // A later rerun of the cancelled run is not the attempt that was stopped.
    attempt(300, "success", 750, "pull_request", { attempt: 2 }),
    // The cancel arrived after this run finished: nothing was saved.
    attempt(302, "failure", 400),
    attempt(310, "failure", 30, "pull_request", {}, [{ name: GATE_STEP, conclusion: "failure" }]),
    attempt(320, "success", 600), attempt(321, "success", 900),
  ];
  const report = summarizeRedMain({ archives: [archive(records)], coordinator, snapshots, pulls: [] })!;
  expect(report.savingReference).toMatchObject({ samples: 3, runnerSeconds: 750 });
  expect(report.cancellations, "CANCELLED_SAVINGS_AND_UNKNOWNS").toMatchObject({ count: 3, consumedRunnerSeconds: 520, estimatedSavedRunnerSeconds: 630,
    unknownConsumed: 1, unknownSaved: 1 });
  expect(report.cancellations.runs.map(r => [r.run, r.estimatedSavedRunnerSeconds])).toEqual([[300, 630], [301, null], [302, 0]]);
  expect(report.refusals, "REFUSED_BY_GATE").toMatchObject({ count: 1, consumedRunnerSeconds: 30, estimatedSavedRunnerSeconds: 720, unknownSaved: 0 });
  expect(report.acquisition.coordinatorUnknown, "FAILED_COORDINATOR_LOG_IS_UNKNOWN").toEqual([{ run: 901, attempt: 1, problem: null }]);
  expect(report.acquisition.complete).toBe(false);
  const md = redMainMarkdown(report);
  expect(md).toContain("Cancelled by the coordinator: 3 runs; consumed runner minutes 8.67 (unknown for 1); estimated saved runner minutes 10.50 (unknown for 1).");
  expect(md).toContain("Refused by the hosted gate: 1 runs;");
  // Without a successful reference attempt, saving is unknown rather than zero.
  const unreferenced = summarizeRedMain({ archives: [archive(records)], coordinator, snapshots: snapshots.filter(s => s.run.conclusion !== "success"), pulls: [] })!;
  expect(unreferenced.cancellations.unknownSaved, "NO_REFERENCE_IS_UNKNOWN").toBe(2);
  expect(unreferenced.refusals.estimatedSavedRunnerSeconds).toBe(0);
  expect(unreferenced.refusals.unknownSaved).toBe(1);
});

test("a merge during red appears in the report with its PR number", () => {
  const records = incidentLifecycle();
  const squash = attempt(410, "success", 60, "push", { head: C, prs: [7], attribution: "exact merged squash SHA" });
  const report = summarizeRedMain({ archives: [archive(records)], coordinator: [], snapshots: [squash], pulls: [] })!;
  expect(report.mergesDuringRed, "MERGE_DURING_RED_HAS_PR").toEqual({ count: 1, unknownPR: 0, rows: [{ incidentRun: 100, incident: 500, sha: C, pr: 7 }] });
  expect(redMainMarkdown(report)).toContain("| `cccccccccccc` | #7 | 100 |");
  // A PR observation's exact squash identifies it too; nothing at all leaves it unknown.
  expect(summarizeRedMain({ archives: [archive(records)], coordinator: [], snapshots: [], pulls: [{ number: 9, merge: C }] })!.mergesDuringRed.rows[0]!.pr).toBe(9);
  expect(summarizeRedMain({ archives: [archive(records)], coordinator: [], snapshots: [], pulls: [] })!.mergesDuringRed.unknownPR).toBe(1);
});

test("absent or failed red-main acquisition reads as unknown, never as a quiet main", () => {
  expect(summarizeRedMain({ archives: [], coordinator: [], snapshots: [], pulls: [] })).toBeNull();
  expect(redMainMarkdown(null)).toContain("Red-main evidence is unknown");
  const failed: RedMainArchive = { version: 1, repository: repo, collectedAt: iso(0), sourceRef: "refs/heads/brain-integration-reservation",
    sourceHead: null, since: iso(-60), incidents: [], flakes: [], error: "Coordination ref unavailable" };
  expect(summarizeRedMain({ archives: [failed], coordinator: [], snapshots: [], pulls: [] })!.acquisition.complete).toBe(false);
  // History read but the red hours' coordinator logs not: cancellations stay unknown.
  const unread = { ...archive(incidentLifecycle()), coordinatorScope: { intervals: [], status: "partial" as const, error: "TimingBudgetStop: request limit" } };
  expect(summarizeRedMain({ archives: [unread], coordinator: [], snapshots: [], pulls: [] })!.acquisition, "UNREAD_COORDINATOR_LOGS_ARE_A_GAP").toMatchObject({ complete: false, coordinatorScopesUnread: 1 });
  const conflicting = archive(incidentLifecycle());
  conflicting.incidents[0]!.opened += 1;
  expect(() => mergeRedMainArchives([archive(incidentLifecycle()), conflicting])).toThrow("Conflicting red-main history");
  expect(() => mergeRedMainArchives([{ ...failed, incidents: archive(incidentLifecycle()).incidents }])).toThrow("Invalid red-main archive");
});

test("coordinator lines name cancellations; a failed attempt without one is unknown", () => {
  expect(coordinatorCancellations("x BRAIN_RED_MAIN {\"firstBad\":\"b\",\"incident\":5,\"cancelled\":[3,1]}\ny BRAIN_RED_MAIN {\"cancelled\":[3]}", "success")).toEqual([1, 3]);
  expect(coordinatorCancellations("BRAIN_RED_MAIN_INCLUDED {}\nnothing", "success"), "QUIET_SUCCESS_CANCELLED_NOTHING").toEqual([]);
  expect(coordinatorCancellations("nothing", "failure"), "FAILED_BEFORE_PRINTING_IS_UNKNOWN").toBeNull();
  expect(() => coordinatorCancellations("BRAIN_RED_MAIN {\"cancelled\":[\"x\"]}", "success")).toThrow("Invalid coordinator cancellation line");
});

test("coordinator logs are read only for red hours and never twice", async () => {
  const calls: string[] = [];
  const api = {
    async json(path: string) {
      calls.push(path);
      if (path.includes("red-main.yml/runs")) return { total_count: 2, workflow_runs: [
        { id: 900, run_attempt: 1, created_at: iso(5), status: "completed", path: ".github/workflows/red-main.yml" },
        { id: 901, run_attempt: 1, created_at: iso(6), status: "completed", path: ".github/workflows/red-main.yml" }] };
      const jobs = /runs\/(\d+)\/attempts/.exec(path);
      if (jobs) return { jobs: [{ id: Number(jobs[1]) * 10, name: "coordinate", conclusion: "success" }] };
      throw new Error(`Unexpected offline API ${path}`);
    },
    async log(job: number) { calls.push(`log ${job}`); return `BRAIN_RED_MAIN {"cancelled":[${job + 1}]}`; },
  };
  const history = archive(incidentLifecycle());
  // Main stayed green outside the incident: no request at all.
  expect(await collectCoordinatorRuns(api, repo, redIntervals(history, iso(100), iso(200)), async () => null), "GREEN_HOURS_COST_NOTHING").toEqual([]);
  expect(calls).toEqual([]);
  const intervals = redIntervals(history, iso(-60), iso(200));
  expect(intervals).toEqual([{ since: iso(-30), until: iso(90) }]);
  const known = async (run: number) => run === 900 ? { problem: null } as CoordinatorObservation : null;
  const rows = await collectCoordinatorRuns(api, repo, intervals, known, () => iso(200));
  expect(rows, "ARCHIVED_ATTEMPT_NOT_REFETCHED").toEqual([{ version: 1, repository: repo, collectedAt: iso(200), run: 901, attempt: 1, createdAt: iso(6),
    conclusion: "success", cancelled: [9011], problem: null }]);
  expect(calls.filter(c => c.startsWith("log"))).toEqual(["log 9010"]);
  const stop = { ...api, async log(): Promise<string> { throw Object.assign(new Error("request limit"), { name: "TimingBudgetStop" }); } };
  await expect(collectCoordinatorRuns(stop, repo, intervals, async () => null), "BUDGET_STOP_IS_NOT_A_PER_RUN_PROBLEM").rejects.toThrow("request limit");
});

test("native history collection walks the shared coordination ref from an offline local remote", () => {
  const dir = mkdtempSync(join(tmpdir(), "ci-red-main-"));
  const git = (args: string[], cwd = dir) => { const p = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" }); expect(p.exitCode).toBe(0); };
  try {
    git(["init", "--bare", "remote.git"]); git(["init", "work"]);
    const work = join(dir, "work");
    git(["remote", "add", "origin", join(dir, "remote.git")], work);
    const store = new GitReservationStore(work);
    const lease = reservationTransition(emptyReservation(), { kind: "acquire", id: "2".repeat(32),
      candidate: { repository: `https://github.com/${repo}`, pr: 42, head: A, base: B } }, 1, T0 - 300 * minute);
    expect(store.publish({ oid: null, state: emptyReservation() }, lease)).toBe(true);
    // An earlier incident, cleared before the window, bounds the walk.
    const earlier = openRed(emptyRedMain(), { firstBad: A, run: 50, failures: [real(raft, ["in-affected-closure"], 50, A)] }, T0 - 200 * minute);
    expect(store.publishRedMain(store.read(), earlier)).toBe(true);
    expect(store.publishRedMain(store.read(), clearRed(earlier, { ...covering(earlier), id: 60 }, T0 - 150 * minute))).toBe(true);
    for (const [step, next] of incidentLifecycle(store.read().redMain).entries()) {
      expect(store.publishRedMain(store.read(), next)).toBe(true);
      // A reservation write between record writes copies the record unchanged.
      if (step === 2) expect(store.publish(store.read(), reservationTransition(store.read().state, { kind: "release", id: "2".repeat(32) }, 1, T0 + 2 * minute + 1))).toBe(true);
    }
    const history = collectRedMainHistory(repo, iso(-60), work);
    expect(history.error).toBeUndefined();
    expect(history.incidents.map(i => i.run), "EARLIER_INCIDENT_OUTSIDE_WINDOW").toEqual([100]);
    expect(history.incidents[0]).toMatchObject({ opened: T0, firstBad: B, incident: 500, fixes: [8], reported: [C], cleared: { at: T0 + 90 * minute, run: 400 } });
    // One source per record write, not per reservation write.
    expect(history.incidents[0]!.sources).toHaveLength(7);
    const wide = collectRedMainHistory(repo, iso(-400), work);
    expect(wide.incidents.map(i => i.run)).toEqual([50, 100]);
    expect(wide.incidents[0]!.cleared).toEqual({ at: T0 - 150 * minute, run: 60 });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("native report writes the red-main section from downloaded archives", () => {
  const dir = mkdtempSync(join(tmpdir(), "ci-red-main-report-"));
  try {
    writeFileSync(join(dir, "red-main.json"), JSON.stringify(archive(incidentLifecycle())));
    writeFileSync(join(dir, "coordinator-900-attempt-1.json"), JSON.stringify({ version: 1, repository: repo, collectedAt: iso(200), run: 900, attempt: 1,
      createdAt: iso(0), conclusion: "success", cancelled: [300], problem: null }));
    writeFileSync(join(dir, "run-300-attempt-1.json"), JSON.stringify(attempt(300, "cancelled", 120)));
    writeFileSync(join(dir, "run-320-attempt-1.json"), JSON.stringify(attempt(320, "success", 600)));
    writeFileSync(join(dir, "run-410-attempt-1.json"), JSON.stringify(attempt(410, "success", 60, "push", { head: C, prs: [7], attribution: "exact merged squash SHA" })));
    const child = Bun.spawnSync([process.execPath, "scripts/ci-timings.ts", "report", "--out", dir], { stdout: "pipe", stderr: "pipe" });
    expect(new TextDecoder().decode(child.stderr)).toBe("");
    expect(child.exitCode).toBe(0);
    const report = JSON.parse(readFileSync(join(dir, "summary.json"), "utf8"));
    expect(report.redMain.incidents[0].timeToGreenSeconds).toBe(5400);
    expect(report.redMain.cancellations).toMatchObject({ count: 1, estimatedSavedRunnerSeconds: 480 });
    expect(report.redMain.mergesDuringRed.rows[0].pr).toBe(7);
    const md = readFileSync(join(dir, "summary.md"), "utf8");
    expect(md).toContain("## Red-main incidents");
    expect(md).toContain("| `cccccccccccc` | #7 | 100 |");
    rmSync(join(dir, "red-main.json"));
    expect(Bun.spawnSync([process.execPath, "scripts/ci-timings.ts", "report", "--out", dir]).exitCode).toBe(0);
    expect(JSON.parse(readFileSync(join(dir, "summary.json"), "utf8")).redMain, "NO_ARCHIVE_IS_UNKNOWN").toBeNull();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
