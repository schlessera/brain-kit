import { expect, test } from "bun:test";
import { emptyRedMain, openRed, type RedFailure } from "../scripts/red-main";
import { expeditedProblems, expeditedTests, fixProbeTitle, probeReceipt, PROBE_RECEIPT, type ProbeEvidence } from "../scripts/red-main-expedite";

const NOW = Date.parse("2026-07-12T00:00:00Z"), BASE = "b".repeat(40), HEAD = "c".repeat(40);
const failure = (test: string | null, category: RedFailure["category"] = "unit"): RedFailure =>
  ({ test, category, verdict: "real", reasons: ["in-affected-closure"], run: 11, sha: BASE });
const TESTS = ["tests/raft.test.ts"];
const probe = (run: number, sha: string, exitCode: number, tests = TESTS, absent: string[] = []): ProbeEvidence =>
  ({ run, status: "completed", conclusion: exitCode ? "failure" : "success", receipt: { purpose: "fix", sha, tests, absent, exitCode } });
const feedback = { run: 91, cadence: "confirmation", changeset: "success", verify: "success" };
const valid = { tests: TESTS, base: BASE, head: HEAD, deleted: [], baseProbe: probe(301, BASE, 1), headProbe: probe(302, HEAD, 0), feedback };

test("expedited proof requires the failing tests red on the bad base and green on the fix head", () => {
  expect(expeditedProblems(valid)).toEqual([]);
  expect(expeditedProblems({ ...valid, baseProbe: probe(301, BASE, 0) }).join(), "BASE_NOT_SHOWN_RED_REFUSED").toContain("not shown red on the bad base");
  expect(expeditedProblems({ ...valid, headProbe: probe(302, HEAD, 1) }).join(), "HEAD_NOT_SHOWN_GREEN_REFUSED").toContain("not shown green on the fix head");
  expect(expeditedProblems({ ...valid, baseProbe: probe(301, HEAD, 1) }).join()).toContain("no receipt for the bad base");
  expect(expeditedProblems({ ...valid, baseProbe: probe(301, BASE, 1, ["tests/other.test.ts"]) }).join()).toContain("did not run every failing test file");
  expect(expeditedProblems({ ...valid, baseProbe: null, headProbe: { run: 302, status: "in_progress", conclusion: null, receipt: null } })).toHaveLength(2);
});

test("a targeted revert may delete the failing test file it reverts; any other absence refuses", () => {
  const revert = { ...valid, headProbe: probe(302, HEAD, 0, [], TESTS) };
  expect(expeditedProblems({ ...revert, deleted: TESTS }), "REVERT_ACCEPTED_AS_DECLARED_FIX").toEqual([]);
  expect(expeditedProblems(revert).join()).toContain("absent at the fix head without the fix deleting them");
});

test("affected fast invariants must pass on a non-draft exact-head run", () => {
  expect(expeditedProblems({ ...valid, feedback: { ...feedback, verify: "skipped" } })).toEqual([]);
  expect(expeditedProblems({ ...valid, feedback: { ...feedback, verify: "failure" } }).join()).toContain("fast invariants did not pass");
  expect(expeditedProblems({ ...valid, feedback: { ...feedback, cadence: "draft" } }).join()).toContain("selects no fast invariants");
  expect(expeditedProblems({ ...valid, feedback: null }).join()).toContain("no hosted CI run at the fix head");
});

test("only the open record's run, with test-file failures, can be expedited", () => {
  const red = openRed(emptyRedMain(), { firstBad: BASE, run: 11, failures: [failure("tests/raft.test.ts"), failure("tests/raft.test.ts")] }, NOW);
  expect(expeditedTests(red, 11)).toEqual(TESTS);
  expect(() => expeditedTests(red, 12)).toThrow("does not match the open red-main record's run 11");
  expect(() => expeditedTests(emptyRedMain(), 11)).toThrow("Main is not red");
  const category = openRed(emptyRedMain(), { firstBad: BASE, run: 11, failures: [failure("tests/raft.test.ts"), failure(null, "browser")] }, NOW);
  expect(() => expeditedTests(category, 11), "CATEGORY_LEVEL_FAILURE_REFUSED").toThrow("Category-level red failures (browser)");
});

test("probe receipts are single, structured lines", () => {
  const line = `${PROBE_RECEIPT} ${JSON.stringify({ purpose: "fix", sha: BASE, tests: TESTS, absent: [], exitCode: 1 })}`;
  expect(probeReceipt(`2026-07-12T00:00:00Z ${line}\n`)).toEqual({ purpose: "fix", sha: BASE, tests: TESTS, absent: [], exitCode: 1 });
  expect(probeReceipt(`${line}\n${line}`)).toBeNull();
  expect(probeReceipt("no receipt")).toBeNull();
  expect(fixProbeTitle(11, BASE)).toBe(`red-main probe fix 11 ${BASE}`);
});
