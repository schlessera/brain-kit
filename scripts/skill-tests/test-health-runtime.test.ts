import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseJunit, parseProofCases, type CaseResult } from "../test-health/junit";
import { measure, median, runsFor } from "../test-health/measure";
import { mutate, patchFiles, worktreePatch } from "../test-health/mutate";
import { bunRunner, type RunOutput, type RunRequest, type TestRunner } from "../test-health/runner";

const scratch: string[] = [];
afterEach(() => { for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const ENV = { ...process.env, GIT_AUTHOR_NAME: "Odysseus", GIT_AUTHOR_EMAIL: "odysseus@example.invalid",
  GIT_COMMITTER_NAME: "Odysseus", GIT_COMMITTER_EMAIL: "odysseus@example.invalid", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe", env: ENV });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
  return result.stdout.toString();
}

const OARS = "tests/oars.test.ts";
const SOURCE = 'export function oars(ship: string): number {\n  return ship === "Odysseus" ? 12 : 0;\n}\n';
const TEST = [
  'import { describe, expect, test } from "bun:test";',
  'import { oars } from "../src/oars";',
  'describe("the ship", () => {',
  '  test("counts the oars", () => { expect(oars("Odysseus")).toBe(12); });',
  '  test("has oars", () => { expect(oars("Odysseus")).toBeDefined(); });',
  '  test("rows", () => { oars("Odysseus"); });',
  "});",
  "",
].join("\n");

/** A committed repository with one source file and its test, and a runner that really runs `bun test` in it. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "odysseus-test-health-"));
  scratch.push(root);
  const write = (file: string, text: string) => { mkdirSync(dirname(join(root, file)), { recursive: true }); writeFileSync(join(root, file), text); };
  git(root, "init", "-q", "-b", "main");
  write("src/oars.ts", SOURCE);
  write(OARS, TEST);
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "the ship");
  return { root, write, runner: bunRunner(root, join(root, ".scratch"), ["bun", "test"]) };
}

describe("reading Bun's JUnit report", () => {
  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<testsuites name="bun test" tests="5" assertions="3" failures="1" skipped="2" time="0.012">',
    '  <testsuite name="tests/oars.test.ts" file="tests/oars.test.ts" tests="5" assertions="3" failures="1" skipped="2" time="0.007" hostname="ithaca">',
    '    <testsuite name="the ship" file="tests/oars.test.ts" line="2" tests="4" assertions="2" failures="1" skipped="2" time="0" hostname="ithaca">',
    '      <testcase name="counts the oars" classname="the ship" time="0.000015" file="tests/oars.test.ts" line="3" assertions="1" />',
    '      <testcase name="rows &amp; &lt;steers&gt;" classname="the ship" time="0.000641" file="tests/oars.test.ts" line="4" assertions="1">',
    '        <failure type="AssertionError" message="Expected: 12&#10;Received: 11">AssertionError: at tests/oars.test.ts:4:47</failure>',
    "      </testcase>",
    '      <testcase name="passes the sirens" classname="the ship" time="0" file="tests/oars.test.ts" line="5" assertions="0">',
    "        <skipped />",
    "      </testcase>",
    "    </testsuite>",
    '    <testcase name="lands" classname="" time="0.005309" file="tests/oars.test.ts" line="8" assertions="0" />',
    "  </testsuite>",
    "</testsuites>",
  ].join("\n");

  test("a case is named by its describe path, with its state, duration and assertion count", () => {
    expect(parseJunit(xml)).toEqual([
      { file: OARS, name: "the ship > counts the oars", state: "passed", ms: 0.015, assertions: 1 },
      { file: OARS, name: "the ship > rows & <steers>", state: "failed", ms: 0.641, assertions: 1, message: "Expected: 12\nReceived: 11" },
      { file: OARS, name: "the ship > passes the sirens", state: "skipped", ms: 0, assertions: 0 },
      { file: OARS, name: "lands", state: "passed", ms: 5.309, assertions: 0 },
    ]);
  });

  test("the machine's hostname is never part of a result", () => {
    expect(JSON.stringify(parseJunit(xml))).not.toContain("ithaca");
  });

  test("the browser case report keeps skipped cases and their project file", () => {
    const report = JSON.stringify({ version: 1, modules: [{ project: "ui-react-layout", file: "packages/ithaca/tests/browser/harbour.layout.tsx", state: "passed",
      cases: [{ id: "1", name: "harbour > moors", state: "passed", durationMs: 812.4 }, { id: "2", name: "harbour > storm", state: "skipped", durationMs: null }] }] });
    expect(parseProofCases(report).map(entry => [entry.name, entry.state, entry.ms])).toEqual([["harbour > moors", "passed", 812.4], ["harbour > storm", "skipped", null]]);
  });
});

describe("measuring repeated runs", () => {
  const pass = (ms = 100, cases: CaseResult[] = []): RunOutput => ({ exitCode: 0, wallMs: ms, cases, output: "" });
  const fail = (name = "counts the oars"): RunOutput =>
    ({ exitCode: 1, wallMs: 100, cases: [{ file: OARS, name, state: "failed", ms: 1, assertions: 1, message: "Expected: 12" }], output: "" });
  /** A runner that answers from a script keyed by what the request asks for. */
  const scripted = (answer: (request: RunRequest, call: number) => RunOutput): TestRunner & { calls: RunRequest[] } => {
    const calls: RunRequest[] = [];
    return Object.assign(async (request: RunRequest) => { calls.push(request); return answer(request, calls.length); }, { calls });
  };
  const verdict = async (runner: TestRunner, options = {}) =>
    (await measure({ files: [OARS], runner, runs: 4, startLoad: () => () => {}, now: new Date("2026-07-12T00:00:00Z"), ...options })).files[0]!;

  test("always green is stable, with timings from the repeat runs only", async () => {
    const runner = scripted((_request, call) => pass(call * 10));
    const result = await verdict(runner, { shuffle: true });
    expect([result.verdict, result.runs, result.failures, result.medianMs, result.minMs, result.maxMs]).toEqual(["stable", 8, 0, 25, 10, 40]);
    expect(runner.calls.map(call => call.seed)).toEqual([undefined, undefined, undefined, undefined, 1, 2, 3, 4]);
  });

  test("always red is failing, sometimes red is flaky", async () => {
    expect((await verdict(scripted(() => fail()))).verdict).toBe("failing");
    const flaky = await verdict(scripted((_request, call) => call === 3 ? fail() : pass()));
    expect([flaky.verdict, flaky.failures, flaky.failingCases]).toEqual(["flaky", 1, [{ name: "counts the oars", failures: 1, message: "Expected: 12" }]]);
  });

  test("red before collecting any case is not-collected, with the runner's last lines as the cause (#3847)", async () => {
    const lines = Array.from({ length: 22 }, (_, index) => `line ${index + 1}`);
    const unbuilt = (): RunOutput => ({ exitCode: 1, wallMs: 100, cases: [], output: `${lines.join("\n")}\n\n\u001b[41m FAIL \u001b[49m oars\n` });
    const result = await verdict(scripted(unbuilt));
    expect([result.verdict, result.failures, result.failingCases, result.setupError])
      .toEqual(["not-collected", 4, [], [...lines.slice(3), " FAIL  oars"].join("\n")]);
    // One collected run means the tests were reached: that file is failing, and has no setup error.
    const reached = await verdict(scripted((_request, call) => call === 2 ? fail() : unbuilt()));
    expect([reached.verdict, reached.setupError]).toEqual(["failing", undefined]);
  });

  test("green in order and red when shuffled is order-dependent", async () => {
    expect((await verdict(scripted(request => request.seed === 2 ? fail() : pass()), { shuffle: true })).verdict).toBe("order-dependent");
  });

  test("green when idle and red under load is load-sensitive, and the load is stopped even then", async () => {
    let loaded = false, stopped = 0;
    const runner = scripted(() => loaded ? fail() : pass());
    const result = await verdict(runner, { stress: true, startLoad: () => { loaded = true; return () => { loaded = false; stopped++; }; } });
    expect([result.verdict, result.variants.stress, stopped]).toEqual(["load-sensitive", { runs: 4, failures: 4 }, 1]);
  });

  test("green alone and red in company is a leak between files", async () => {
    const SAILS = "tests/sails.test.ts";
    const runner = scripted(request => request.files.length > 1
      ? { exitCode: 1, wallMs: 1, output: "", cases: [{ file: SAILS, name: "reefs", state: "failed", ms: 1, assertions: 1 }] } : pass());
    const result = await measure({ files: [OARS, SAILS], runner, runs: 2, together: true });
    expect(result.files.map(entry => entry.verdict)).toEqual(["stable", "leaks-between-files"]);
    expect(result.together).toEqual({ runs: 2, failures: 2, failingCases: [`${SAILS} > reefs`] });
  });

  test("a case that passes without executing an assertion is reported, and a skipped one separately", async () => {
    const cases: CaseResult[] = [
      { file: OARS, name: "rows", state: "passed", ms: 2, assertions: 0 }, { file: OARS, name: "counts the oars", state: "passed", ms: 9, assertions: 1 },
      { file: OARS, name: "passes the sirens", state: "skipped", ms: 0, assertions: 0 }];
    const result = await verdict(scripted(() => pass(100, cases)));
    expect([result.zeroAssertionCases, result.skippedCases, result.slowestCases[0]]).toEqual([["rows"], ["passes the sirens"], { name: "counts the oars", medianMs: 9 }]);
  });

  test("a slow file gets fewer runs than asked, but never fewer than two", () => {
    expect([runsFor(5, 10, 600), runsFor(5, 200, 600), runsFor(5, 900, 600), runsFor(5, undefined, 600)]).toEqual([5, 3, 2, 5]);
  });

  test("the median of an even count is the mean of the middle pair", () => {
    expect([median([]), median([30, 10, 20]), median([10, 20, 30, 40])]).toEqual([null, 20, 25]);
  });
});

describe("the Bun runner on a real test file", () => {
  test("it reports each case with its assertion count, and a name filter narrows the run", async () => {
    const { runner } = fixture();
    const all = await runner({ files: [OARS] });
    expect(all.exitCode).toBe(0);
    expect(all.cases.map(entry => [entry.file, entry.name, entry.state, entry.assertions])).toEqual([
      [OARS, "the ship > counts the oars", "passed", 1], [OARS, "the ship > has oars", "passed", 1], [OARS, "the ship > rows", "passed", 0]]);
    const one = await runner({ files: [OARS], name: "counts the oars" });
    expect(one.cases.filter(entry => entry.state === "passed").map(entry => entry.name)).toEqual(["the ship > counts the oars"]);
  });
});

describe("mutation receipts", () => {
  const BREAK = (root: string, write: (file: string, text: string) => void, from: string, to: string) => {
    write("src/oars.ts", SOURCE.replace(from, to));
    const patch = git(root, "diff", "--", "src/oars.ts");
    git(root, "checkout", "--", "src/oars.ts");
    return patch;
  };

  test("a test that fails on the broken guard and passes again once restored kills the mutant", async () => {
    const { root, write, runner } = fixture();
    const patch = BREAK(root, write, "12 : 0", "11 : 0");
    const receipt = await mutate({ root, test: OARS, name: "counts the oars", expect: "Expected: 12", patch, runner });
    expect([receipt.verdict, receipt.patchFiles, receipt.runs.mutated?.failedCases]).toEqual(["killed", ["src/oars.ts"], ["the ship > counts the oars"]]);
    expect(readFileSync(join(root, "src/oars.ts"), "utf8")).toBe(SOURCE);
    expect(git(root, "status", "--porcelain", "--", "src", "tests")).toBe("");
  });

  test("a test that stays green on the broken guard lets the mutant survive", async () => {
    const { root, write, runner } = fixture();
    const receipt = await mutate({ root, test: OARS, name: "has oars", expect: "has oars", patch: BREAK(root, write, "12 : 0", "11 : 0"), runner });
    expect([receipt.verdict, receipt.runs.mutated?.exitCode]).toEqual(["survived", 0]);
  });

  test("a mutant that only fails to load is not a kill", async () => {
    const { root, write, runner } = fixture();
    const receipt = await mutate({ root, test: OARS, expect: "oars", patch: BREAK(root, write, "function oars", "function sails"), runner });
    expect(receipt.verdict).toBe("load-error");
    expect(readFileSync(join(root, "src/oars.ts"), "utf8")).toBe(SOURCE);
  });

  test("a failure that does not mention the expected assertion is the wrong reason", async () => {
    const { root, write, runner } = fixture();
    const receipt = await mutate({ root, test: OARS, expect: "Expected: 108", patch: BREAK(root, write, "12 : 0", "11 : 0"), runner });
    expect([receipt.verdict, receipt.detail]).toEqual(["wrong-reason", 'the failure does not mention "Expected: 108"']);
  });

  test("a test that is red before the mutation gives no verdict about the mutant", async () => {
    const { root, write, runner } = fixture();
    const patch = BREAK(root, write, "12 : 0", "11 : 0");
    write(OARS, TEST.replace("toBe(12)", "toBe(13)"));
    const receipt = await mutate({ root, test: OARS, expect: "Expected", patch, runner });
    expect([receipt.verdict, receipt.runs.mutated]).toEqual(["unstable-baseline", null]);
  });

  test("the unstaged change of a path is captured as the mutation and the path is restored", async () => {
    const { root, write, runner } = fixture();
    write("src/oars.ts", SOURCE.replace("12 : 0", "11 : 0"));
    const patch = worktreePatch(root, ["src/oars.ts"]);
    expect(patchFiles(patch)).toEqual(["src/oars.ts"]);
    const receipt = await mutate({ root, test: OARS, name: "counts the oars", expect: "Expected: 12", patch, runner }, true);
    expect(receipt.verdict).toBe("killed");
    expect(readFileSync(join(root, "src/oars.ts"), "utf8")).toBe(SOURCE);
    expect(() => worktreePatch(root, ["src/oars.ts"])).toThrow("No unstaged change in src/oars.ts");
  });

  test("a case name that matches no test is an error, not a verdict about the test", async () => {
    const { root, write, runner } = fixture();
    await expect(mutate({ root, test: OARS, name: "strings the bow", expect: "Expected", patch: BREAK(root, write, "12 : 0", "11 : 0"), runner }))
      .rejects.toThrow('--name "strings the bow" matched no test in tests/oars.test.ts');
    expect(readFileSync(join(root, "src/oars.ts"), "utf8")).toBe(SOURCE);
  });

  test("a mutation without an expected failure text is refused before anything runs", async () => {
    const { root, write } = fixture();
    const calls: RunRequest[] = [];
    const runner: TestRunner = async request => { calls.push(request); return { exitCode: 0, wallMs: 1, cases: [], output: "" }; };
    await expect(mutate({ root, test: OARS, expect: " ", patch: BREAK(root, write, "12 : 0", "11 : 0"), runner })).rejects.toThrow("--expect is required");
    expect(calls).toEqual([]);
  });
});
