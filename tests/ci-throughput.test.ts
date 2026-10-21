import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectPullObservation, concurrency, summarizeThroughput, validateWorkEvent, type PullObservation, type WorkEvent } from "../scripts/ci-throughput";
import { attachTimingEvidence, type TimingSnapshot } from "../scripts/ci-timings";
import { collectReservationHistory, reservationObservations } from "../scripts/ci-coordination";
import { emptyReservation, reservationTransition, GitReservationStore } from "../scripts/integration-reservation";

const repo = "odysseus/chronicle", head = "a".repeat(40), base = "b".repeat(40), tree = "c".repeat(40), merge = "d".repeat(40);
const at = (minute: number) => new Date(Date.parse("2026-07-12T10:00:00Z") + minute * 60000).toISOString();
const window = { since: at(0), until: at(60), source: "explicit test interval" };
const scenario = { failedPRFraction: .3, additionalPushes: 2, failedRunCostFraction: 1 };
const reference = { runnerSeconds: 100, elapsedSeconds: 50, samples: 1 };
function pull(): PullObservation {
  return { version: 1, repository: repo, number: 42, collectedAt: at(60), createdAt: at(-60), mergedAt: at(10), closedAt: at(10), head, merge,
    baseBranch: "main", changedFiles: 2, additions: 5, deletions: 5, timeline: [{ event: "ready_for_review", at: at(3) }], problems: [],
    mergeObject: { sha: merge, tree, parents: [base] } };
}
function run(id: number, event: string, start: number, end: number, outcome = "success"): TimingSnapshot {
  return { version: 1, repository: repo, collectedAt: at(60), run: { id, attempt: 1, workflow: "CI", path: ".github/workflows/ci.yml", event,
    head: event === "push" ? merge : head, prs: [42], attribution: "run payload", createdAt: at(start), startedAt: at(start), status: "completed", conclusion: outcome },
    jobs: [{ id: id * 10, name: event === "push" ? "integrated or exhaustive proof" : "proof", category: "proof", conclusion: outcome,
      labels: [], execution: "observed", startedAt: at(start), completedAt: at(end), seconds: (end - start) * 60, steps: [], resource: null, resourceProblem: null }], problems: [] };
}

test("first main failure and same-source recovery are counted without claiming a regression or flake", () => {
  const pre = run(1, "pull_request", 4, 8), first = run(2, "push", 10, 12, "failure"), retry = run(2, "push", 13, 15); retry.run.attempt = 2;
  pre.candidate = { head, base, checkout: { sha: "e".repeat(40), tree, parents: [base, head] } };
  const r = summarizeThroughput([pre, first, retry], [pull()], [], window, reference, scenario);
  expect(r.velocity.firstPassGreen).toEqual({ numerator: 0, denominator: 1, percent: 0 });
  expect(r.velocity.sameCommitObservedGreen.percent).toBe(100);
  expect(r.reliability.sameSourceRecoveries).toBe(1);
  expect(r.reliability.preGreenMainNonGreen.percent).toBe(100);
  expect(r.velocity.mergeToGreenSeconds.median).toBe(300);
  expect(r.velocity).toMatchObject({ createToGreenSeconds: { median: 4500 } });
  expect(r.velocity.readyToMergeSeconds.median).toBe(420);
  expect(r.velocity.gateToMergeSeconds.median).toBe(120);
  expect(r.evidence.squashComparedToRecordedReceipt.matches).toBe(1);
  expect(r.evidence.independentlyValidatedFullGuarantees).toBeNull();
  expect(r.reliability.incidentRate).toBeNull();
  expect(r.scenario.equivalentFullRunsPerPR).toBe(2.6);
  expect(r.scenario.estimatedRunnerSeconds).toBe(260);
  expect(r.scenario.estimatedSavingPercent).toBeLessThan(0);
});

test("missing and unconfirmed main proof cannot count as first-pass success", () => {
  const pre = run(1, "pull_request", 4, 8), main = run(2, "push", 10, 12);
  main.jobs[0]!.name = "unit (1)"; main.jobs[0]!.category = "unit";
  const missing = summarizeThroughput([pre], [pull()], [], window, reference, scenario);
  expect(missing.velocity.firstPassGreen.percent).toBeNull(); expect(missing.coverage.firstMainUnknown).toBe(1);
  const unconfirmed = summarizeThroughput([pre, main], [pull()], [], window, reference, scenario);
  expect(unconfirmed.prs[0]!.firstMainOutcome).toBe("unconfirmed-success");
  expect(unconfirmed.velocity.firstPassGreen.numerator).toBe(0);
  expect(unconfirmed.velocity.mergeToGreenSeconds.n).toBe(0);
  main.run.attempt = 2;
  expect(summarizeThroughput([pre, main], [pull()], [], window, reference, scenario).coverage.firstMainUnknown).toBe(1);
  main.run.attempt = 1;
  pre.run.head = "f".repeat(40);
  main.jobs[0]!.name = "integrated or exhaustive proof"; main.jobs[0]!.category = "proof";
  expect(summarizeThroughput([pre, main], [pull()], [], window, reference, scenario).prs[0]!.priorGreenAggregate).toBe(false);
});

test("concurrency is time-weighted, clipped, and does not multiply adjacent intervals", () => {
  const r = concurrency([{ start: Date.parse(at(-10)), end: Date.parse(at(20)) },
    { start: Date.parse(at(10)), end: Date.parse(at(30)) }, { start: Date.parse(at(30)), end: Date.parse(at(40)) }], window);
  expect(r.peak).toBe(2); expect(r.activeWallSeconds).toBe(2400);
  expect(r.summedSeconds).toBe(3000); expect(r.averageWhileActive).toBe(1.25);
  expect(r.overlappingActiveTime.percent).toBe(25);
  expect(r.averageAcrossWindow).toBeCloseTo(5 / 6);
});

test("worker records stay separate from CI overlap and repeated tasks do not duplicate workers", () => {
  const event = (id: string, kind: WorkEvent["kind"], minute: number, worker: string, task: string): WorkEvent => ({ version: 1, id, repository: repo, kind, at: at(minute), worker, task });
  const events = [event("a", "work-started", 0, "w1", "t1"), event("b", "work-started", 5, "w1", "t2"),
    event("c", "work-started", 10, "w2", "t3"), event("d", "work-finished", 20, "w1", "t1"),
    event("e", "work-finished", 25, "w1", "t2"), event("f", "work-finished", 30, "w2", "t3")];
  const r = summarizeThroughput([], [pull()], events, window, reference, scenario);
  expect(r.parallelism.recordedWorkers?.peak).toBe(2);
  expect(r.parallelism.recordedWorkers?.summedSeconds).toBe(2700);
  expect(r.parallelism.ciJobs.peak).toBe(0);
  expect(summarizeThroughput([], [pull()], [], window, reference, scenario).parallelism.recordedWorkers).toBeNull();
  expect(summarizeThroughput([], [pull()], events.slice(0, 1), window, reference, scenario).coverage.unmatchedCoordinationEvents).toBe(1);
});

test("lifecycle enrichment paginates, strips personal content and attributes immutable squash data", async () => {
  let pages = 0;
  const api = { json: async (path: string) => {
    if (path === "pulls/42") return { number: 42, base: { repo: { full_name: repo }, ref: "main" }, head: { sha: head }, created_at: at(0), merged_at: at(10), merge_commit_sha: merge, changed_files: 2, additions: 5, deletions: 1, title: "not retained" };
    if (path.startsWith("git/commits")) return { sha: merge, tree: { sha: tree }, parents: [{ sha: base }] };
    pages++; return pages === 1 ? Array.from({ length: 100 }, () => ({ event: "commented", body: "not retained" })) : [{ event: "ready_for_review", created_at: at(5) }];
  }, log: async () => "" };
  const p = await collectPullObservation(api, repo, 42, at(60));
  expect(p.timeline).toEqual([{ event: "ready_for_review", at: at(5) }]); expect(pages).toBe(2);
  expect(JSON.stringify(p)).not.toContain("not retained"); expect(p.mergeObject?.tree).toBe(tree);
});

test("scope, failed-run cost sensitivity and draft transitions preserve unknowns", () => {
  const p = pull(), pre = run(1, "pull_request", 4, 8), main = run(2, "push", 10, 12);
  p.timeline.push({ event: "converted_to_draft", at: at(9) });
  const r = summarizeThroughput([pre, main], [p], [], window, reference, { ...scenario, failedRunCostFraction: .5 });
  expect(r.scenario.equivalentFullRunsPerPR).toBe(2.3);
  expect(summarizeThroughput([pre, main], [p], [], window, reference, { ...scenario, failedRunElapsedFraction: .5 }).scenario.estimatedSerialTestElapsedPerPR).toBeCloseTo(115);
  expect(r.velocity.readyToMergeSeconds.n).toBe(0);
  p.mergedAt = at(60);
  expect(summarizeThroughput([pre, main], [p], [], window, reference, scenario).coverage.mergedInWindow).toBe(0);
  expect(() => summarizeThroughput([], [], [], window, reference, { ...scenario, failedPRFraction: 2 })).toThrow("Invalid full-proof");
});

test("candidate log evidence is head-bound and never becomes a full guarantee", () => {
  const s = run(1, "pull_request", 0, 1);
  const marker = `BRAIN_CANDIDATE_RECEIPT ${JSON.stringify({ head, base, checkout: { sha: "e".repeat(40), tree, parents: [base, head] } })}`;
  attachTimingEvidence(s, marker); expect(s.candidate?.base).toBe(base);
  expect(() => attachTimingEvidence(s, marker + "\n" + marker)).toThrow("Ambiguous");
  expect(() => attachTimingEvidence(s, marker.replaceAll(head, "f".repeat(40)))).toThrow("head mismatch");
});

test("reservation history preserves expiry/release without identities or revocation text", () => {
  const candidate = { repository: `https://github.com/${repo}`, pr: 42, head, base };
  const acquired = reservationTransition(emptyReservation(), { kind: "acquire", candidate, id: "1".repeat(32) }, 1, Date.parse(at(0)));
  const renewed = reservationTransition(acquired, { kind: "renew", id: acquired.active!.id }, 1, Date.parse(at(4)));
  const released = reservationTransition(renewed, { kind: "release", id: acquired.active!.id }, 1, Date.parse(at(6)));
  const leases = reservationObservations(repo, [released, renewed, acquired].map((state, i) => ({ source: String(i + 1).repeat(40), state })));
  expect(leases.length).toBe(1); expect(leases[0]!.endedAt).toBe(Date.parse(at(6)));
  expect(JSON.stringify(leases)).not.toContain("actor");
  const r = summarizeThroughput([], [pull()], [], window, reference, scenario, leases);
  expect(r.reservation?.activeWallSeconds).toBe(360);
  expect(r.reservation?.occupiedWindow.percent).toBe(10);
  expect(r.reservation?.withoutObservedCandidateJobSeconds).toBe(360);
});

test("native reservation collection reads an explicitly local offline Git remote", () => {
  const dir = mkdtempSync(join(tmpdir(), "ci-reservations-")), cwd = process.cwd();
  const git = (args: string[]) => { const p = Bun.spawnSync(["git", ...args], { cwd: dir, stdout: "pipe", stderr: "pipe" }); expect(p.exitCode).toBe(0); };
  try {
    git(["init", "--bare", "remote.git"]); git(["init", "work"]);
    const work = join(dir, "work");
    const setup = Bun.spawnSync(["git", "remote", "add", "origin", join(dir, "remote.git")], { cwd: work }); expect(setup.exitCode).toBe(0);
    const store = new GitReservationStore(work);
    const state = reservationTransition(emptyReservation(), { kind: "acquire", candidate: { repository: `https://github.com/${repo}`, pr: 42, head, base }, id: "2".repeat(32) }, 1, Date.parse(at(0)));
    expect(store.publish({ oid: null, state: emptyReservation() }, state)).toBe(true);
    // The production collector uses Git argv against this local remote only.
    process.chdir(work);
    const history = collectReservationHistory(repo, at(0));
    expect(history.leases.length).toBe(1); expect(history.leases[0]!.pr).toBe(42);
  } finally { process.chdir(cwd); rmSync(dir, { recursive: true, force: true }); }
});

test("native event recording is append-only and refuses arbitrary personal fields", () => {
  const dir = mkdtempSync(join(tmpdir(), "ci-work-events-")), input = join(dir, "input.json");
  try {
    const event: WorkEvent = { version: 1, id: "odysseus-task", repository: repo, kind: "work-started", at: at(0), worker: "w1", task: "t1" };
    writeFileSync(input, JSON.stringify(event));
    const invoke = () => Bun.spawnSync([process.execPath, "scripts/ci-timings.ts", "record", "--repo", repo, "--event", input, "--out", dir], { stdout: "pipe", stderr: "pipe" });
    expect(invoke().exitCode).toBe(0);
    expect(JSON.parse(readFileSync(join(dir, "event-odysseus-task.json"), "utf8")).worker).toBe("w1");
    writeFileSync(input, JSON.stringify(Object.fromEntries(Object.entries(event).reverse()))); expect(invoke().exitCode).toBe(0);
    writeFileSync(input, JSON.stringify({ ...event, at: at(1) })); expect(invoke().exitCode).toBe(1);
    expect(() => validateWorkEvent({ ...event, prompt: "forbidden" })).toThrow("Invalid coordination");
    expect(() => validateWorkEvent({ ...event, kind: "failure-classified", run: 1, attempt: 1, classification: "product" })).toThrow("evidence");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
