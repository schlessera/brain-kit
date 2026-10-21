import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attributePR, collectAttempt, deduplicate, discoverRuns, markdown, normalizeJob, resourceFromLog, seconds, stats, summarize,
  type TimingAPI, type TimingSnapshot } from "../scripts/ci-timings";
import { timingWorkflowProblems } from "../scripts/check-ci-workflows";

const sha = "a".repeat(40), tree = "b".repeat(40);
const start = "2026-07-12T10:00:00Z", finish = "2026-07-12T10:01:00Z";
const rawRun = { id: 12, run_attempt: 1, name: "CI", path: ".github/workflows/ci.yml", event: "pull_request",
  head_sha: sha, head_branch: "feat/example", created_at: start, run_started_at: start,
  status: "completed", conclusion: "success", pull_requests: [{ number: 42 }] };
function job(id = 1, name = "unit (1)") {
  return { id, run_id: 12, run_attempt: 1, name, status: "completed", conclusion: "success", started_at: start, completed_at: finish,
    labels: ["ubuntu-24.04"], steps: [{ name: "Complete unit proof", number: 1, status: "completed", conclusion: "success", started_at: start, completed_at: finish }] };
}
function snapshot(id = 12): TimingSnapshot {
  return { version: 1, repository: "example/engine", collectedAt: finish,
    run: { id, attempt: 1, workflow: "CI", path: rawRun.path, event: "pull_request", head: sha,
      createdAt: start, startedAt: start, status: "completed", conclusion: "success", prs: [42], attribution: "run payload" },
    jobs: [normalizeJob(job())], problems: [] };
}
const resource = { category: "unit", checkout: { sha, tree, parents: [sha] }, elapsedSeconds: 20,
  phases: [{ name: "suite", elapsedSeconds: 20, success: true }],
  machine: { logicalCpus: 4, totalBytes: 1000, activeCpuSeconds: 42, sampledPeakUsedBytes: 500 } };

test("queued cancellation timestamps do not become consumed runner minutes", () => {
  const queued = normalizeJob({ ...job(), conclusion: "cancelled", steps: [] });
  expect(queued.execution).toBe("unobserved");
  expect(queued.seconds).toBeNull();
  const s = snapshot(); s.run.conclusion = "cancelled"; s.jobs = [queued];
  expect(summarize([s]).cancelledAttemptRunnerSeconds).toBe(0);
  expect(summarize([s]).coverage.unobservedJobs).toBe(1);
  const running = normalizeJob({ ...job(), conclusion: "cancelled" });
  expect(running.execution).toBe("observed"); expect(running.seconds).toBe(60);
});

test("unknown and excluded durations remain distinct from measured zero", () => {
  expect(seconds(start, start)).toBe(0);
  expect(seconds(undefined, finish)).toBeNull(); expect(seconds(finish, start)).toBeNull();
  expect(normalizeJob({ ...job(), conclusion: "skipped" }).execution).toBe("excluded");
  expect(normalizeJob({ ...job(), completed_at: undefined }).seconds).toBeNull();
  expect(stats([])).toEqual({ n: 0, mean: null, median: null, p90: null });
  expect(stats([0, 10, 20, 30])).toEqual({ n: 4, mean: 15, median: 15, p90: 30 });
});

test("filtered run discovery paginates and splits GitHub's search cap", async () => {
  const calls: string[] = [];
  const api: TimingAPI = { json: async path => {
    calls.push(path);
    const range = decodeURIComponent(path.split("created=")[1]!.split("&")[0]!);
    if (range === `${start}..${finish}`) return { total_count: 1000, workflow_runs: [] };
    return { total_count: 1, workflow_runs: [{ ...rawRun, created_at: "2026-07-12T10:00:30.000Z" }] };
  }, log: async () => { throw new Error("not used"); } };
  expect((await discoverRuns(api, "ci.yml", start, finish)).map(r => r.id)).toEqual([12]);
  expect(calls.length).toBe(3);
  let pages = 0;
  api.json = async () => ({ total_count: 2, workflow_runs: [{ ...rawRun, id: ++pages, created_at: start }] });
  expect((await discoverRuns(api, "ci.yml", start, finish)).length).toBe(2);
  expect(pages).toBe(2);
});

test("attempt-specific job pagination, resource identity and missing evidence", async () => {
  const api: TimingAPI = { json: async path => {
    if (!path.includes("/jobs?")) return rawRun;
    return { total_count: 2, jobs: [job(path.endsWith("page=1") ? 1 : 2)] };
  }, log: async () => `2026-07-12T10:01:00Z BRAIN_RESOURCE_RECEIPT ${JSON.stringify(resource)}\n` };
  const s = await collectAttempt(api, "example/engine", rawRun, 1, true, finish);
  expect(s.jobs.length).toBe(2); expect(s.jobs[0]!.resource?.checkout.tree).toBe(tree);
  expect(s.run.prs).toEqual([42]); expect(s.problems).toEqual([]);
  api.log = async () => "no receipt after cancellation";
  expect((await collectAttempt(api, "example/engine", rawRun, 1, true)).jobs[0]!.resourceProblem).toContain("missing");
  await expect(collectAttempt(api, "example/engine", rawRun, 2, false)).rejects.toThrow("identity mismatch");
  api.json = async path => path.includes("/jobs?") ? { total_count: 1, jobs: [{ ...job(), run_id: 99 }] } : rawRun;
  expect((await collectAttempt(api, "example/engine", rawRun, 1, false)).problems[0]).toContain("identity mismatch");
});

test("resource parsing rejects ambiguous, invalid and wrong-category receipts", () => {
  const line = `BRAIN_RESOURCE_RECEIPT ${JSON.stringify(resource)}`;
  expect(resourceFromLog(line, "unit").elapsedSeconds).toBe(20);
  expect(() => resourceFromLog(line + "\n" + line, "unit")).toThrow("ambiguous");
  expect(() => resourceFromLog(line, "browser")).toThrow("Invalid");
  expect(() => resourceFromLog(line.replace('"elapsedSeconds":20', '"elapsedSeconds":-1'), "unit")).toThrow("Invalid");
});

test("overlapping archives deduplicate attempts and retain richer command data", () => {
  const rich = snapshot(); rich.jobs[0]!.resource = resource;
  const later = snapshot(); later.collectedAt = "2026-07-12T11:00:00Z";
  expect(deduplicate([rich, later])[0]!.jobs[0]!.resource).toEqual(resource);
  expect(summarize([rich, later]).observedRunnerSeconds).toBe(60);
  const rerun = snapshot(); rerun.run.attempt = 2; rerun.jobs[0]!.id = 2;
  expect(summarize([rich, rerun]).coverage.runAttempts).toBe(2);
  expect(summarize([rich, rerun]).observedRunnerSeconds).toBe(120);
  const bad = snapshot(); bad.run.head = tree;
  expect(() => deduplicate([rich, bad])).toThrow("Conflicting archive");
});

test("parallel elapsed time, total runner time and full-run estimates stay separate", () => {
  const pre = snapshot(); pre.jobs.push(normalizeJob(job(2, "browser (1)")));
  const post = snapshot(13); post.run.event = "push"; post.jobs = [normalizeJob(job(3))];
  const exhaustive = snapshot(14); exhaustive.run.event = "schedule"; exhaustive.run.prs = [];
  exhaustive.jobs = ["verify", "pack", "unit", "browser", "layout", "captures", "runtime", "runtime_host", "endurance"].map((c, i) => normalizeJob(job(10 + i, c)));
  const report = summarize([pre, post, exhaustive]);
  expect(report.observedRunnerSeconds).toBe(720);
  expect(report.attemptElapsedSeconds.median).toBe(60);
  expect(report.baseline.pairedObservedCIRunnerSeconds).toBe(180);
  expect(report.baseline.runnerSeconds.median).toBe(540);
  expect(report.baseline.onceBeforeAndAfterEstimate).toBe(1080);
  expect(report.categories["pull_request/unit"]?.mean).toBe(60);
  expect(summarize([pre]).baseline.onceBeforeAndAfterEstimate).toBeNull();
  expect(markdown(report)).toContain("not measured savings");
  exhaustive.jobs[0]!.execution = "excluded";
  expect(summarize([pre, exhaustive]).baseline.samples).toEqual([]);
});

test("collection workflow reads trusted code with a read-only token and no candidate execution", () => {
  const workflow = readFileSync(new URL("../.github/workflows/ci-timings.yml", import.meta.url), "utf8");
  expect(workflow).toContain("ref: ${{ github.event.repository.default_branch }}");
  expect(workflow).toContain("persist-credentials: false");
  expect(workflow).not.toContain("write"); expect(workflow).not.toContain("secrets.");
  expect(workflow).not.toContain("bun install"); expect(workflow).not.toContain("workflow_run.head_sha");
  expect(workflow).toContain("retention-days: 90");
  expect(timingWorkflowProblems(workflow)).toEqual([]);
  expect(timingWorkflowProblems(workflow.replace("actions: read", "actions: write"))).toContain("ci-timings.yml: measurement token must remain read-only");
  expect(timingWorkflowProblems(workflow.replace("github.event.repository.default_branch", "github.event.pull_request.head.sha"))).toContain("ci-timings.yml: collector must check out trusted default-branch code without credentials");
  expect(timingWorkflowProblems(workflow.replace("  schedule:", "  workflow_run:\n  schedule:"))).toContain("ci-timings.yml: measurement must use scheduled/manual trusted execution only");
});

test("native report CLI persists statistics and missing-acquisition evidence offline", () => {
  const dir = mkdtempSync(join(tmpdir(), "ci-timings-"));
  try {
    writeFileSync(join(dir, "run-12-attempt-1.json"), JSON.stringify(snapshot()));
    writeFileSync(join(dir, "collection.json"), JSON.stringify({ repository: "example/engine",
      expected: [{ run: 12, attempts: 2 }], errors: [{ run: 12, attempt: 2, error: "unavailable" }], status: "completed" }));
    const child = Bun.spawnSync([process.execPath, "scripts/ci-timings.ts", "report", "--out", dir], { stdout: "pipe", stderr: "pipe" });
    expect(child.exitCode).toBe(0);
    const report = JSON.parse(readFileSync(join(dir, "summary.json"), "utf8"));
    expect(report.observedRunnerSeconds).toBe(60);
    expect(report.collectionCoverage.missingAttempts).toEqual(["example/engine/12/2"]);
    expect(report.collectionCoverage.scopes[0].errors[0].error).toBe("unavailable");
    expect(readFileSync(join(dir, "summary.md"), "utf8")).toContain("Missing discovered attempts: 1");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("job reuse across attempts is refused instead of charged twice", () => {
  const first = snapshot(), second = snapshot(); second.run.attempt = 2;
  expect(() => summarize([first, second])).toThrow("more than one attempt");
});

test("historical attribution requires an exact commit or unique repository/branch", () => {
  const s = snapshot(); s.run.prs = []; s.run.headRepository = "example/engine"; s.run.branch = "feat/example";
  const pulls = [{ number: 42, head: tree, branch: "feat/example", repository: "example/engine", merge: "c".repeat(40) }];
  attributePR(s, pulls); expect(s.run.prs).toEqual([42]); expect(s.run.attribution).toContain("historical head not independently verified");
  s.run.prs = []; attributePR(s, [...pulls, { ...pulls[0]!, number: 43 }]); expect(s.run.prs).toEqual([]);
  s.run.event = "push"; attributePR(s, pulls); expect(s.run.prs).toEqual([]);
  s.run.head = "c".repeat(40); attributePR(s, pulls); expect(s.run.prs).toEqual([42]);
  expect(s.run.attribution).toBe("exact merged squash SHA");
});

test("retained browser timing metadata stays distinct from a fresh execution or exclusion", async () => {
  const selection = { selections: Object.fromEntries(["verify", "pack", "unit", "browser", "layout", "captures", "runtime", "runtime_host", "endurance"].map(c => [c, c === "browser" ? "true" : "false"])), retained: ["browser"] };
  const api: TimingAPI = { json: async () => ({ total_count: 2, jobs: [
    { ...job(1, "browser (1)"), conclusion: "skipped", steps: [] }, job(2, "proof")] }),
    log: async () => `BRAIN_SELECTED_PROOF_RECEIPT ${JSON.stringify(selection)}` };
  const s = await collectAttempt(api, "example/engine", rawRun, 1, true, finish);
  expect(s.jobs[0]!.execution).toBe("retained"); expect(s.jobs[0]!.seconds).toBeNull();
  expect(summarize([s]).coverage.retainedJobs).toBe(1);
  expect(summarize([s]).observedRunnerSeconds).toBe(60);
});
