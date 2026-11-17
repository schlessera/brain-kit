import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { summarizeThroughput, throughputMarkdown, type PullObservation, type WorkEvent } from "../scripts/ci-throughput";
import type { TimingSnapshot } from "../scripts/ci-timings";

// Proof-policy epochs (#3270, docs/decisions/ci-utility.md "Proof-system lane",
// answer 4): each proof-system squash on main opens a new epoch.
const repo = "odysseus/chronicle";
const at = (minute: number) => new Date(Date.parse("2026-07-12T10:00:00Z") + minute * 60000).toISOString();
const window = { since: at(0), until: at(60), source: "explicit test interval" };
const scenario = { failedPRFraction: .3, additionalPushes: 2, failedRunCostFraction: 1 };
const reference = { runnerSeconds: 100, elapsedSeconds: 50, samples: 1 };
const sha = (n: number) => n.toString(16).padStart(40, "0");

function pull(number: number, minute: number): PullObservation {
  return { version: 1, repository: repo, number, collectedAt: at(60), createdAt: at(minute - 30), mergedAt: at(minute), closedAt: at(minute),
    head: sha(1000 + number), merge: sha(number), baseBranch: "main", changedFiles: 1, additions: 1, deletions: 1, timeline: [], problems: [] };
}
function mainRun(number: number, minute: number, outcome: string): TimingSnapshot {
  return { version: 1, repository: repo, collectedAt: at(60), run: { id: 500 + number, attempt: 1, workflow: "CI", path: ".github/workflows/ci.yml", event: "push",
    head: sha(number), prs: [number], attribution: "exact merged squash SHA", createdAt: at(minute + 1), startedAt: at(minute + 1), status: "completed", conclusion: outcome },
    jobs: [{ id: 5000 + number, name: "integrated or exhaustive proof", category: "proof", conclusion: outcome, labels: [], execution: "observed",
      startedAt: at(minute + 1), completedAt: at(minute + 5), seconds: 240, steps: [], resource: null, resourceProblem: null }], problems: [] };
}

// Squash number, merge minute, first-main outcome. 2 and 5 change the proof system.
const deliveries: [number, number, string][] = [[1, 5, "success"], [2, 10, "success"], [3, 20, "failure"], [4, 30, "success"], [5, 40, "failure"], [6, 50, "success"]];
const pulls = deliveries.map(([n, m]) => pull(n, m)), runs = deliveries.map(([n, m, o]) => mainRun(n, m, o));
// First-parent main history, newest first: a proof-system squash 90 at -100
// precedes the window, an ordinary root commit 91 precedes that.
const history = [...[...deliveries].reverse().map(([n, m]) => ({ sha: sha(n), parents: [sha(n - 1 || 90)], at: at(m) })),
  { sha: sha(90), parents: [sha(91)], at: at(-100) }, { sha: sha(91), parents: [], at: at(-200) }];
const proofSystem = new Set([sha(2), sha(5), sha(90)]);
function source(unknown: string[] = []) {
  return { ref: "main", history, classify(commit: { sha: string; parents: string[] }) {
    if (unknown.includes(commit.sha)) return { error: "diff unavailable" };
    if (commit.parents.length !== 1) return { error: "no single parent" };
    return { proofSystem: proofSystem.has(commit.sha) };
  } };
}
const summary = (events: WorkEvent[] = [], epochSource: unknown = source()) =>
  summarizeThroughput(runs, pulls, events, window, reference, scenario, undefined, epochSource as never);

test("deliveries join the epoch opened by the latest proof-system squash at or before them, with per-epoch first-main green", () => {
  const r = summary();
  expect(r.prs.map(p => [p.number, p.epoch])).toEqual([[1, sha(90)], [2, sha(2)], [3, sha(2)], [4, sha(2)], [5, sha(5)], [6, sha(5)]]);
  expect(r.epochs!.boundaries.map(b => [b.sha, b.kind, b.at])).toEqual([[sha(90), "proof-system", at(-100)], [sha(2), "proof-system", at(10)], [sha(5), "proof-system", at(40)]]);
  expect(r.epochs!.epochs.map(e => ({ id: e.id, merges: e.merges, green: e.firstMainGreen, seconds: e.durationSeconds, current: e.current }))).toEqual([
    { id: sha(90), merges: 1, green: { numerator: 1, denominator: 1, percent: 100 }, seconds: 110 * 60, current: false },
    { id: sha(2), merges: 3, green: { numerator: 2, denominator: 3, percent: 200 / 3 }, seconds: 30 * 60, current: false },
    { id: sha(5), merges: 2, green: { numerator: 1, denominator: 2, percent: 50 }, seconds: 20 * 60, current: true }]);
  expect(r.epochs!.current).toMatchObject({ id: sha(5), start: { sha: sha(5), at: at(40), kind: "proof-system" }, days: 20 / 1440,
    firstMainGreen: { numerator: 1, denominator: 2, percent: 50 }, incidentAttribution: { status: "unknown", failedFirstMainAttempts: 1, classifiedAttempts: 0 } });
  const md = throughputMarkdown(r);
  expect(md).toContain("## Proof-policy epochs");
  expect(md).toContain(`Current epoch ${sha(5).slice(0, 12)}`);
  expect(md).toContain("incident attribution: unknown");
});

test("a squash whose classification cannot be computed is an unknown epoch boundary, never a continuation", () => {
  const r = summary([], source([sha(4)]));
  expect(r.prs.map(p => p.epoch)).toEqual([sha(90), sha(2), sha(2), sha(4), sha(5), sha(5)]);
  expect(r.epochs!.boundaries.find(b => b.sha === sha(4))).toEqual({ sha: sha(4), at: at(30), kind: "unknown", error: "diff unavailable" });
  expect(r.epochs!.epochs.find(e => e.id === sha(2))!.firstMainGreen).toEqual({ numerator: 1, denominator: 2, percent: 50 });
  const current = summary([], source([sha(6)])).epochs!.current!;
  expect(current).toMatchObject({ id: sha(6), start: { kind: "unknown" } });
});

test("missing history leaves every epoch unknown, and a squash outside history is unassigned", () => {
  const unavailable = summary([], { ref: "main", error: "no such ref" });
  expect(unavailable.prs.every(p => p.epoch === null)).toBe(true);
  expect(unavailable.epochs).toMatchObject({ status: "unavailable", error: "no such ref", current: null, unassigned: [1, 2, 3, 4, 5, 6] });
  const partial = summary([], { ...source(), history: history.filter(c => c.sha !== sha(3)) });
  expect(partial.prs.find(p => p.number === 3)!.epoch).toBeNull();
  expect(partial.epochs!.unassigned).toEqual([3]);
  expect(summarizeThroughput(runs, pulls, [], window, reference, scenario).epochs).toBeNull();
});

test("no boundary within the lookback leaves the earliest epoch's start unknown", () => {
  const r = summary([], { ...source(), history: history.slice(0, 6) });
  expect(r.prs[0]!.epoch).toBe("unbounded");
  expect(r.epochs!.epochs[0]).toMatchObject({ id: "unbounded", start: null, durationSeconds: null });
});

test("recorded failure classifications for the current epoch's failed first-main attempts are reported, not inferred", () => {
  const classified: WorkEvent = { version: 1, id: "c5", repository: repo, kind: "failure-classified", at: at(55), run: 505, attempt: 1,
    classification: "test", evidence: `https://github.com/${repo}/issues/7` };
  expect(summary([classified]).epochs!.current!.incidentAttribution).toMatchObject({ status: "recorded", failedFirstMainAttempts: 1, classifiedAttempts: 1 });
});

test("the git history source classifies first-parent squashes with the proof-system path set", async () => {
  const { gitEpochSource } = await import("../scripts/ci-epochs");
  const dir = mkdtempSync(join(tmpdir(), "odysseus-epochs-"));
  const env = { ...process.env, GIT_AUTHOR_NAME: "Penelope", GIT_AUTHOR_EMAIL: "penelope@example.invalid", GIT_COMMITTER_NAME: "Penelope",
    GIT_COMMITTER_EMAIL: "penelope@example.invalid", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CEILING_DIRECTORIES: tmpdir() };
  const git = (...args: string[]) => {
    const r = Bun.spawnSync(["git", ...args], { cwd: dir, env, stdout: "pipe", stderr: "pipe" });
    expect(r.exitCode).toBe(0);
    return r.stdout.toString().trim();
  };
  try {
    git("init", "-q", "-b", "main");
    const commit = (file: string, minute: number, content = String(minute)) => {
      mkdirSync(dirname(join(dir, file)), { recursive: true });
      writeFileSync(join(dir, file), content);
      git("add", file);
      const r = Bun.spawnSync(["git", "commit", "-q", "-m", file], { cwd: dir, env: { ...env, GIT_COMMITTER_DATE: at(minute), GIT_AUTHOR_DATE: at(minute) } });
      expect(r.exitCode).toBe(0);
      return git("rev-parse", "HEAD");
    };
    const root = commit("README.md", -10), product = commit("notes.md", 5);
    const proof = commit("scripts/ci-loom.ts", 10);
    const s = gitEpochSource(dir, "main");
    if ("error" in s) throw new Error(s.error);
    expect(s.history).toEqual([{ sha: proof, parents: [product], at: at(10) }, { sha: product, parents: [root], at: at(5) }, { sha: root, parents: [], at: at(-10) }]);
    expect(s.classify(s.history[0]!)).toEqual({ proofSystem: true });
    expect(s.classify(s.history[1]!)).toEqual({ proofSystem: false });
    expect(s.classify(s.history[2]!)).toEqual({ error: "root commit has no parent to compare" });
    // The path set in force at merge decides, not the current one.
    commit("scripts/proof-system-paths.json", 12, JSON.stringify({ paths: ["notes/**"], timeoutCheckScope: ["**/*.test.*"] }));
    const set = commit("notes/ledger.md", 15), loom = commit("scripts/ci-loom.ts", 20);
    const later = gitEpochSource(dir, "main");
    if ("error" in later) throw new Error(later.error);
    expect(later.classify(later.history[1]!)).toEqual({ proofSystem: true });
    expect(later.history[1]!.sha).toBe(set);
    expect(later.classify(later.history[0]!)).toEqual({ proofSystem: false });
    expect(later.history[0]!.sha).toBe(loom);
    expect(gitEpochSource(dir, "no-such-ref")).toMatchObject({ ref: "no-such-ref", error: expect.stringContaining("no-such-ref") });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
