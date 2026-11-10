import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Gh } from "../issue-queue";
import { failingLines, main, summarizeChecks } from "../pr-status";
import { RECEIPT_START } from "../check-receipt";

const REPO = "schlessera/brain-kit";
const HEAD = "a".repeat(40), BASE = "b".repeat(40), OLD_BASE = "c".repeat(40), MERGE = "d".repeat(40);
const scratch: string[] = [];
afterEach(() => { for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const run = (name: string, status: string, conclusion: string | null) => ({ __typename: "CheckRun", name, status, conclusion });

describe("reading a head's checks", () => {
  test("passed, skipped, pending and failed are counted apart, and failures are named", () => {
    const summary = summarizeChecks([run("lint", "COMPLETED", "SUCCESS"), run("pack", "COMPLETED", "SKIPPED"), run("unit (1)", "IN_PROGRESS", null),
      run("layout", "COMPLETED", "FAILURE"), run("browser", "COMPLETED", "CANCELLED"), { __typename: "StatusContext", context: "deploy", state: "PENDING" }]);
    expect(summary).toEqual({ total: 6, passed: 1, skipped: 1, pending: ["unit (1)", "deploy"],
      failed: [{ name: "layout", conclusion: "failure" }, { name: "browser", conclusion: "cancelled" }], proof: "absent" });
  });

  test("no rows is not green", () => {
    expect(summarizeChecks([])).toMatchObject({ total: 0, passed: 0, proof: "absent" });
  });

  test.each([
    ["SUCCESS", "COMPLETED", "passed"], ["FAILURE", "COMPLETED", "failed"], [null, "QUEUED", "pending"],
    // A skipped or cancelled proof proves nothing.
    ["SKIPPED", "COMPLETED", "failed"], ["CANCELLED", "COMPLETED", "failed"],
  ] as const)("a proof check that ended %s is %s", (conclusion, status, expected) => {
    expect(summarizeChecks([run("proof", status, conclusion)]).proof).toBe(expected);
  });
});

describe("reading a job log", () => {
  const log = [
    "2026-07-12T09:00:00.0000000Z \u001b[32m(pass)\u001b[0m the ship > counts the oars [0.12ms]",
    "2026-07-12T09:00:01.0000000Z \u001b[31m(fail)\u001b[0m the ship > reefs the sail [4.01ms]",
    "2026-07-12T09:00:01.1000000Z error: expect(received).toBe(expected)",
    "2026-07-12T09:00:02.0000000Z 412 pass",
    "2026-07-12T09:00:03.0000000Z ##[error]Process completed with exit code 1.",
  ].join("\n");

  test("only failing lines are kept, without timestamps or colour", () => {
    expect(failingLines(log)).toEqual(["(fail) the ship > reefs the sail [4.01ms]", "error: expect(received).toBe(expected)", "##[error]Process completed with exit code 1."]);
  });

  test("a long failure is cut, and says by how much", () => {
    const many = Array.from({ length: 12 }, (_, index) => `(fail) case ${index}`).join("\n");
    expect(failingLines(many, 10)).toEqual([...Array.from({ length: 10 }, (_, index) => `(fail) case ${index}`), "(+2 more failing lines)"]);
  });
});

/** Answers the `gh` calls of one pull request; `overrides` replaces single answers. */
function github(overrides: Record<string, { code?: number; stdout: string }> = {}): Gh {
  const view = { state: "OPEN", isDraft: false, headRefOid: HEAD, baseRefName: "main", mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", reviewDecision: "",
    body: `Refs #12\n\n${RECEIPT_START}\n{}\n`, files: [{ path: "packages/ithaca/tests/oars.test.ts" }, { path: "docs/voyage.md" }],
    statusCheckRollup: [run("proof", "COMPLETED", "SUCCESS"), run("unit (1)", "COMPLETED", "SUCCESS")] };
  const answers: Record<string, { code?: number; stdout: string }> = {
    "pr view": { stdout: JSON.stringify(view) },
    "run list": { stdout: JSON.stringify([{ databaseId: 7, workflowName: "CI", event: "pull_request", attempt: 1, status: "completed", conclusion: "failure" }]) },
    [`repos/${REPO}/git/ref/heads/main`]: { stdout: `${BASE}\n` },
    [`repos/${REPO}/git/ref/pull/42/merge`]: { stdout: `${MERGE}\n` },
    [`repos/${REPO}/git/commits/${MERGE}`]: { stdout: JSON.stringify([BASE, HEAD]) },
    [`repos/${REPO}/compare/${OLD_BASE}...${BASE}`]: { stdout: JSON.stringify(["packages/ithaca/tests/oars.test.ts", "packages/pylos/src/sands.ts"]) },
    "run view": { stdout: JSON.stringify({ jobs: [{ databaseId: 70, name: "unit (1)", conclusion: "failure", steps: [{ name: "Set up", conclusion: "success" }, { name: "Run unit proof", conclusion: "failure" }] },
      { databaseId: 71, name: "lint", conclusion: "success", steps: [] }, { databaseId: 72, name: "layout", conclusion: "failure", steps: [] }] }) },
    [`repos/${REPO}/actions/jobs/70/logs`]: { stdout: "2026-07-12T09:00:01.0000000Z (fail) the ship > reefs the sail\nall quiet\n" },
    [`repos/${REPO}/actions/jobs/72/logs`]: { code: 1, stdout: "" },
    ...overrides,
  };
  return args => {
    const key = args[0] === "api" ? args.find(arg => arg.startsWith("repos/"))! : `${args[0]} ${args[1]}`;
    const answer = answers[key];
    return answer ? { code: answer.code ?? 0, stdout: answer.stdout, stderr: answer.code ? "gh: Not Found (HTTP 404)" : "" } : { code: 1, stdout: "", stderr: `unexpected gh ${args.join(" ")}` };
  };
}
async function status(gh: Gh, ...argv: string[]) {
  const out: string[] = [];
  const code = await main(["42", ...argv], { gh, out: text => out.push(text) });
  return { code, lines: out.length, json: JSON.parse(out.join("\n")) };
}

describe("one pull request's state", () => {
  test("the head, the live base, the merge commit's parents, the receipt and the proof come back in one line", async () => {
    const result = await status(github());
    expect([result.code, result.lines]).toEqual([0, 1]);
    expect(result.json).toEqual({ pr: 42, state: "OPEN", draft: false, head: HEAD, baseRef: "main", liveBase: BASE, mergeable: "MERGEABLE", mergeState: "CLEAN", review: null,
      mergeRef: { sha: MERGE, parents: [BASE, HEAD], current: true }, receipt: true, proof: "passed",
      checks: { total: 2, passed: 2, skipped: 0, pending: [], failed: [] },
      runs: [{ id: 7, workflow: "CI", event: "pull_request", attempt: 1, status: "completed", conclusion: "failure" }] });
  });

  test("a merge commit that still has the old base as its parent is not current", async () => {
    const stale = await status(github({ [`repos/${REPO}/git/commits/${MERGE}`]: { stdout: JSON.stringify([OLD_BASE, HEAD]) } }));
    expect(stale.json.mergeRef).toEqual({ sha: MERGE, parents: [OLD_BASE, HEAD], current: false });
  });

  test("a pull request with no merge commit, for example a conflicted one, reports none", async () => {
    expect((await status(github({ [`repos/${REPO}/git/ref/pull/42/merge`]: { code: 1, stdout: "" } }))).json.mergeRef).toBeNull();
  });

  test("an unchanged head and base pass the recheck", async () => {
    const result = await status(github(), "--expect-head", HEAD, "--expect-base", BASE);
    expect([result.code, result.json.unchanged, result.json.baseGained]).toEqual([0, { head: true, base: true }, undefined]);
  });

  test("a moved base fails the recheck and names what it gained and what overlaps this pull request", async () => {
    const result = await status(github(), "--expect-head", HEAD, "--expect-base", OLD_BASE);
    expect([result.code, result.json.unchanged]).toEqual([1, { head: true, base: false }]);
    expect(result.json.baseGained).toEqual({ files: 2, overlapsThisPr: ["packages/ithaca/tests/oars.test.ts"] });
  });

  test("a moved head fails the recheck", async () => {
    expect((await status(github(), "--expect-head", "e".repeat(40))).code).toBe(1);
  });
});

describe("what failed", () => {
  test("failed jobs are named with their failed steps; logs are saved and only their failing lines printed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "odysseus-pr-status-")); scratch.push(dir);
    const result = await status(github(), "--failures", "--logs", dir);
    expect(result.json).toEqual({ pr: 42, head: HEAD, failedJobs: [
      { run: 7, job: 70, name: "unit (1)", failedSteps: ["Run unit proof"], log: join(dir, "job-70.log"), failing: ["(fail) the ship > reefs the sail"] },
      { run: 7, job: 72, name: "layout", failedSteps: [], failing: ["(no log: the job did not execute; read its check-run annotations)"] }] });
    expect(readFileSync(join(dir, "job-70.log"), "utf8")).toContain("all quiet");
  });

  test("without --logs nothing is downloaded", async () => {
    const calls: string[][] = [];
    const gh = github();
    const result = await status(args => { calls.push(args); return gh(args); }, "--failures");
    expect(result.json.failedJobs.map((job: { name: string; log?: string }) => [job.name, job.log])).toEqual([["unit (1)", undefined], ["layout", undefined]]);
    expect(calls.some(args => args.join(" ").includes("/logs"))).toBe(false);
  });
});
