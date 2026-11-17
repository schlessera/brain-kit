// Changed Bun test files repeat under CPU load before merge (#4109). The pure
// parts are tested directly; the receipts run the real command through the real
// offline wrapper in a scratch Git checkout, with one burner for a few seconds.
import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  BUDGET_SECONDS, burnerSource, DEFAULT_REPETITIONS, firstFailure, FLOOR_REPETITIONS, observedRepetitions, parseArguments,
  planRepetitions, repetitionArgv, REPORT_KIND, startBurners, summaryMarkdown, type Report,
} from "../scripts/test-determinism";
import { planPartitions, selectPartition } from "../scripts/determinism-plan";
import { DETERMINISM_PARTITIONS } from "../scripts/proof-shards";

const ROOT = join(import.meta.dir, "..");
// The wrapper, its preload and what they import, as tests/experiment-tier.test.ts copies them.
const SCRIPTS = ["test.ts", "runtime-test-builds.ts", "test-invocation.ts", "test-invocation-child.ts", "publishable-packages.ts", "test-shards.ts",
  "test-network-preload.ts", "test-home.ts", "test-network-guard.ts", "test-network-child-preload.ts", "workspace-lease.mjs", "host-admission.mjs",
  "test-determinism.ts", "determinism-plan.ts", "proof-shards.ts"];

const scratch: string[] = [];
afterEach(() => { for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function gone(pid: number, withinMs: number): Promise<boolean> {
  for (const deadline = Date.now() + withinMs; Date.now() < deadline; await Bun.sleep(20)) if (!alive(pid)) return true;
  return !alive(pid);
}

describe("repetition budget", () => {
  const costs = { "tests/argo.test.ts": 20, "tests/ithaca.test.ts": 30 };

  test("a selection inside the budget gets the default five repetitions for every file", () => {
    const plan = planRepetitions(Object.keys(costs), { costs, budgetSeconds: 250 });
    // The budget is one partition's capacity, so a selection is split only at the floor (#4117).
    expect([DEFAULT_REPETITIONS, FLOOR_REPETITIONS, BUDGET_SECONDS]).toEqual([5, 2, DETERMINISM_PARTITIONS.capacitySeconds]);
    expect(plan).toMatchObject({ requested: 5, repetitions: 5, reduced: false, overBudget: false, weightSeconds: 50, estimatedSeconds: 250 });
    expect(plan.files).toEqual([
      { file: "tests/argo.test.ts", weightSeconds: 20, weighted: true, repetitions: 5 },
      { file: "tests/ithaca.test.ts", weightSeconds: 30, weighted: true, repetitions: 5 },
    ]);
  });

  test("five that do not fit drop uniformly, and every file keeps the same reduced count", () => {
    const plan = planRepetitions(Object.keys(costs), { costs, budgetSeconds: 249 });
    expect(plan, "REDUCED_TO_WHAT_FITS").toMatchObject({ repetitions: 4, reduced: true, overBudget: false, estimatedSeconds: 200 });
    expect(plan.files.map(entry => entry.repetitions), "UNIFORM_REDUCTION").toEqual([4, 4]);
    expect(planRepetitions(Object.keys(costs), { costs, budgetSeconds: 100 }).repetitions).toBe(2);
  });

  test("a selection too heavy for the floor still runs every file twice and says it is over budget", () => {
    const plan = planRepetitions(Object.keys(costs), { costs, budgetSeconds: 60 });
    expect(plan, "FLOOR_OF_TWO_HOLDS").toMatchObject({ repetitions: 2, reduced: true, overBudget: true, estimatedSeconds: 100 });
    expect(plan.files.map(entry => [entry.file, entry.repetitions]), "NO_FILE_DROPPED").toEqual([["tests/argo.test.ts", 2], ["tests/ithaca.test.ts", 2]]);
  });

  test("a file without a reviewed weight is listed as unweighted at the small-file default", () => {
    const plan = planRepetitions(["tests/new-voyage.test.ts"], { costs });
    expect(plan.files).toEqual([{ file: "tests/new-voyage.test.ts", weightSeconds: 0.1, weighted: false, repetitions: 5 }]);
  });

  test("one run, a duplicate file and a non-positive budget or weight are refused", () => {
    expect(() => planRepetitions(["tests/argo.test.ts"], { costs, repetitions: 1 })).toThrow("at least 2");
    expect(() => planRepetitions(["tests/argo.test.ts"], { costs, floor: 1 })).toThrow("at least two");
    expect(() => planRepetitions(["tests/argo.test.ts", "tests/argo.test.ts"], { costs })).toThrow("selected twice");
    expect(() => planRepetitions(["tests/argo.test.ts"], { costs, budgetSeconds: 0 })).toThrow("budget must be positive");
    expect(() => planRepetitions(["tests/argo.test.ts"], { costs: { "tests/argo.test.ts": 0 } })).toThrow("positive finite seconds");
  });

  test("the wrapper is invoked once, with the repetition count and a bail on the first failure", () => {
    const argv = repetitionArgv(["tests/argo.test.ts", "packages/core/tests/ithaca.test.ts"], 4);
    expect(argv.slice(1)).toEqual(["run", "test", "--rerun-each=4", "--bail=1", "--reporter=junit", "--reporter-outfile=tmp/determinism-junit.xml",
      "./tests/argo.test.ts", "./packages/core/tests/ithaca.test.ts"]);
  });
});

describe("hosted partitions by reviewed weight (#4117)", () => {
  const { capacitySeconds, max } = DETERMINISM_PARTITIONS;
  /** A fleet of `count` files whose pass weighs `passSeconds` in all, none heavy enough to need a partition alone. */
  const fleet = (count: number, passSeconds: number) => Object.fromEntries(Array.from({ length: count }, (_, index) =>
    [`tests/fleet/ship-${String(index).padStart(3, "0")}.test.ts`, Number((passSeconds / count * (index % 2 ? 1.5 : 0.5)).toFixed(3))]));
  const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0);

  test("the calibrated numbers have one owner, and its capacity fits the step limit at the measured load ratio", () => {
    expect(DETERMINISM_PARTITIONS).toEqual({ capacitySeconds: 300, max: 10, stepMinutes: 40, loadRatio: 6.84 });
    expect(capacitySeconds * DETERMINISM_PARTITIONS.loadRatio, "CAPACITY_FITS_THE_STEP_LIMIT").toBeLessThanOrEqual(DETERMINISM_PARTITIONS.stepMinutes * 60);
  });

  test("a selection the size of the largest observed plans several partitions, each within capacity, covering every file once", () => {
    // The 388-file fixture migration: about 1,327 weighted seconds per pass, 2,654 at the floor of two.
    const costs = fleet(388, 1327), files = Object.keys(costs);
    for (const cadence of ["draft", "confirmation", "feedback-heavy"]) {
      const plan = planPartitions(files, { cadence, costs });
      expect(plan, cadence).toMatchObject({ repetitions: 2, floor: 2, capacitySeconds, maxPartitions: max, overBudget: true });
      expect(plan.estimatedSeconds, "THE_OBSERVED_SIZE").toBeCloseTo(2654, 0);
      expect(plan.partitions.length, `SEVERAL_PARTITIONS:${cadence}`).toBe(9);
      for (const partition of plan.partitions) {
        expect(partition.estimatedSeconds, "EACH_WITHIN_CAPACITY").toBeLessThanOrEqual(capacitySeconds);
        expect(partition.estimatedSeconds, "AT_THE_SELECTION_COUNT").toBeCloseTo(sum(partition.files.map(file => costs[file]!)) * 2, 6);
        expect(partition.files.length).toBeGreaterThan(0);
      }
      expect(plan.partitions.flatMap(partition => partition.files).sort(), "EVERY_FILE_EXACTLY_ONCE").toEqual([...files].sort());
      expect(plan.files.map(entry => entry.repetitions), "NO_FILE_BELOW_THE_FLOOR").toEqual(files.map(() => 2));
    }
  });

  test("a selection within one job's capacity stays one partition holding every file", () => {
    const costs = { "tests/argo.test.ts": 20, "tests/ithaca.test.ts": 30 }, files = ["tests/ithaca.test.ts", "tests/argo.test.ts"];
    const five = planPartitions(files, { cadence: "draft", costs });
    expect(five.partitions, "FIVE_REPETITIONS_ONE_JOB").toEqual([{ files: ["tests/argo.test.ts", "tests/ithaca.test.ts"], weightSeconds: 50, estimatedSeconds: 250 }]);
    expect(five).toMatchObject({ repetitions: 5, reduced: false, overBudget: false });
    // Exactly at capacity is still one job; one weighted second more is two.
    expect(planPartitions(files, { cadence: "draft", costs: { ...costs, "tests/ithaca.test.ts": 130 } }), "AT_CAPACITY").toMatchObject({ repetitions: 2, estimatedSeconds: 300, partitions: [{ estimatedSeconds: 300 }] });
    expect(planPartitions(files, { cadence: "draft", costs: { ...costs, "tests/ithaca.test.ts": 131 } }).partitions.map(partition => partition.files), "OVER_CAPACITY_SPLITS")
      .toEqual([["tests/ithaca.test.ts"], ["tests/argo.test.ts"]]);
  });

  test("the count is decided first, over the whole selection, and the partitions are made for that count", () => {
    const costs = fleet(40, 100), files = Object.keys(costs);
    // 100 weighted s per pass: three repetitions fit one job on a draft, and ready confirmation asks for two (#4137).
    expect(planPartitions(files, { cadence: "draft", costs })).toMatchObject({ requested: 5, repetitions: 3, partitions: [{ estimatedSeconds: 300 }] });
    expect(planPartitions(files, { cadence: "confirmation", costs })).toMatchObject({ requested: 2, repetitions: 2, partitions: [{ estimatedSeconds: 200 }] });
    // 200 per pass cannot fit even two: both cadences split at the floor, never at a count a lighter partition could afford.
    const heavy = fleet(40, 200);
    for (const cadence of ["draft", "confirmation"]) {
      const plan = planPartitions(Object.keys(heavy), { cadence, costs: heavy });
      expect(plan.repetitions, cadence).toBe(2);
      expect(plan.partitions.map(partition => Math.round(partition.estimatedSeconds)), cadence).toEqual([200, 200]);
    }
  });

  test("a file whose repetitions alone exceed the capacity runs in a partition by itself", () => {
    const costs = { "tests/cyclops.test.ts": 340, "tests/argo.test.ts": 100, "tests/ithaca.test.ts": 40 };
    const plan = planPartitions(Object.keys(costs), { costs });
    expect(plan.partitions.map(partition => [partition.files, partition.estimatedSeconds]), "UNSPLITTABLE_FILE_ALONE")
      .toEqual([[["tests/cyclops.test.ts"], 680], [["tests/argo.test.ts", "tests/ithaca.test.ts"], 280]]);
    expect(planPartitions(["tests/cyclops.test.ts"], { costs }).partitions).toEqual([{ files: ["tests/cyclops.test.ts"], weightSeconds: 340, estimatedSeconds: 680 }]);
  });

  test("a selection beyond the maximum partition count is refused, naming its weight and the limit", () => {
    const costs = fleet(400, 1600), files = Object.keys(costs);
    expect(planPartitions(files, { costs, maxPartitions: 11 }).partitions.length, "ELEVEN_WOULD_HOLD_IT").toBe(11);
    expect(() => planPartitions(files, { costs })).toThrow(
      "Repeated-run proof refused before it ran: 400 changed Bun test file(s) weigh 1600.0 weighted s per pass, 3200.0 s at the floor of 2 repetitions. " +
      "That needs more than the limit of 10 partitions of 300 weighted s each (DETERMINISM_PARTITIONS, scripts/proof-shards.ts). " +
      "No file is skipped and the count stays at the floor: split the change.");
    // More files than the maximum, each unsplittable: still refused, never run short.
    const giants = Object.fromEntries(Array.from({ length: 11 }, (_, index) => [`tests/giant-${index}.test.ts`, 200]));
    expect(() => planPartitions(Object.keys(giants), { costs: giants })).toThrow("needs more than the limit of 10 partitions");
    expect(() => planPartitions([], { costs })).toThrow("Repeated-run proof was not selected");
    expect(() => planPartitions(files, { costs, maxPartitions: 0 })).toThrow("positive integer");
  });

  test("a partition is read only with the planned count as its divisor", () => {
    const costs = fleet(40, 200), plan = planPartitions(Object.keys(costs), { costs });
    expect(selectPartition(plan, "2/2")).toBe(plan.partitions[1]!);
    for (const [shard, refusal] of [["1/1", "Repeated-run partition 1/1 is not in the planned set of 2"], ["1/3", "Repeated-run partition 1/3 is not in the planned set of 2"],
      ["3/2", "Invalid proof shard"], ["0/2", "Expected proof --shard=M/N"], ["2", "Expected proof --shard=M/N"]] as const) {
      expect(() => selectPartition(plan, shard), shard).toThrow(refusal);
    }
  });
});

describe("reading the wrapper's output", () => {
  const files = ["tests/argo.test.ts", "packages/core/tests/ithaca.test.ts"];

  // Bun 1.4.2's stderr for `--rerun-each=3 --bail=1`, recorded from a real run.
  test("the first failure names its file, repetition and case", () => {
    const stderr = ["", "packages/core/tests/ithaca.test.ts: (run #2)", "error: expect(received).toBe(expected)", "",
      "      at <anonymous> (/odyssey/packages/core/tests/ithaca.test.ts:2:165)", "(fail) the hall > recognises the \x1b[1mscar\x1b[0m [5.37ms]",
      "Ran 6 tests across 2 files. [18.00ms]", "Bailed out after 1 failure"].join("\n");
    expect(firstFailure(stderr, files, "/odyssey")).toEqual({ file: "packages/core/tests/ithaca.test.ts", repetition: 2, test: "the hall > recognises the scar" });
  });

  test("a timed-out case and a single-run header are read the same way", () => {
    expect(firstFailure("tests/argo.test.ts: (run #1)\n(fail) rows past the sirens [100.17ms]\n  ^ this test timed out after 100ms.\n", files, "/odyssey"))
      .toEqual({ file: "tests/argo.test.ts", repetition: 1, test: "rows past the sirens" });
    expect(firstFailure("tests/argo.test.ts:\n(fail) rows past the sirens\n", files, "/odyssey")).toEqual({ file: "tests/argo.test.ts", repetition: 1, test: "rows past the sirens" });
  });

  // Under GITHUB_ACTIONS Bun 1.4.2 wraps each run in a log group; recorded from hosted run 43986946575.
  test("a GitHub Actions group header names the file and repetition too", () => {
    const stderr = ["::group::tests/argo.test.ts: (run #1)", "(pass) rows past the sirens [0.06ms]", "::endgroup::", "",
      "::group::tests/argo.test.ts: (run #2)", "(pass) rows past the sirens", "::endgroup::", "",
      "::group::packages/core/tests/ithaca.test.ts: (run #1)", "(pass) the hall > recognises the scar [5.39ms]", "::endgroup::", "",
      "::group::packages/core/tests/ithaca.test.ts: (run #2)", "error: expect(received).toBe(expected)", "",
      "::error file=packages/core/tests/ithaca.test.ts,line=2,col=165,title=error: expect(received).toBe(expected)::",
      "(fail) the hall > recognises the scar [5.41ms]", "Ran 5 tests across 2 files. [18.00ms]", "Bailed out after 1 failure"].join("\n");
    expect(firstFailure(stderr, files, "/odyssey"), "HOSTED_GROUP_HEADER_READ").toEqual({ file: "packages/core/tests/ithaca.test.ts", repetition: 2, test: "the hall > recognises the scar" });
    expect(firstFailure("::group::tests/argo.test.ts:\n(fail) rows past the sirens\n", files, "/odyssey")).toEqual({ file: "tests/argo.test.ts", repetition: 1, test: "rows past the sirens" });
  });

  test("a failure without a case line keeps the last file and run that spoke; other headers are ignored", () => {
    expect(firstFailure("tests/argo.test.ts: (run #3)\nerror: Cannot find module\nnote: (run #9)\n", files, "/odyssey")).toEqual({ file: "tests/argo.test.ts", repetition: 3, test: null });
    expect(firstFailure("error: script \"test\" exited with code 1\n", files, "/odyssey")).toEqual({ file: null, repetition: null, test: null });
  });

  test("observed repetitions count each case once per run and read a silent file as zero", () => {
    const junit = `<testsuites><testsuite name="tests/argo.test.ts" file="tests/argo.test.ts" tests="6">
      <testcase name="rows" classname="" time="0" file="tests/argo.test.ts" line="2" assertions="1" />
      <testsuite name="crew"><testcase name="rows" classname="crew" time="0" file="tests/argo.test.ts" line="5" assertions="1" /></testsuite>
      <testcase name="rows" classname="" time="0" file="tests/argo.test.ts" line="2" assertions="1" />
      <testsuite name="crew"><testcase name="rows" classname="crew" time="0" file="tests/argo.test.ts" line="5" assertions="1"></testcase></testsuite>
      <testcase name="rows" classname="" time="0" file="tests/argo.test.ts" line="2" assertions="1" />
      <testsuite name="crew"><testcase name="rows" classname="crew" time="0" file="tests/argo.test.ts" line="5" assertions="1" /></testsuite>
      <testcase name="elsewhere" classname="" time="0" file="tests/troy.test.ts" line="1" assertions="1" />
    </testsuite></testsuites>`;
    expect([...observedRepetitions(junit, files)]).toEqual([["tests/argo.test.ts", 3], ["packages/core/tests/ithaca.test.ts", 0]]);
  });

  test("arguments name either a base or explicit files, never both or neither", () => {
    expect(parseArguments(["--base", "origin/main", "--json"])).toEqual({ base: "origin/main", files: [], json: true });
    expect(parseArguments(["--report=tmp/r.json", "--burners", "2", "--repetitions=3", "--budget-seconds", "90", "./tests/argo.test.ts"]))
      .toEqual({ files: ["tests/argo.test.ts"], json: false, report: "tmp/r.json", burners: 2, repetitions: 3, budgetSeconds: 90 });
    for (const args of [[], ["--json"], ["--base", "origin/main", "tests/argo.test.ts"], ["--burners", "0", "tests/argo.test.ts"], ["--base"], ["--unknown", "tests/argo.test.ts"]]) {
      expect(() => parseArguments(args), args.join(" ")).toThrow("usage:");
    }
  });

  test("the job summary lists each file with the repetitions it got", () => {
    const report: Report = { kind: REPORT_KIND, version: 1, base: null, ...planRepetitions(["tests/argo.test.ts"], { costs: { "tests/argo.test.ts": 400 } }),
      outcome: "failed", failure: { file: "tests/argo.test.ts", repetition: 2, test: "rows `past` the sirens", reason: "a test case failed" },
      load: { burners: 4, cpus: 4 }, elapsedSeconds: 12.5, exitCode: 1 };
    const summary = summaryMarkdown(report);
    expect(summary).toContain("2 of 5 requested repetitions per file");
    expect(summary).toContain("(over budget at the floor)");
    expect(summary).toContain("| `tests/argo.test.ts` | 400 | 2 |");
    expect(summary).toContain("**Failed:** `tests/argo.test.ts`, repetition 2, case `rows 'past' the sirens`");
  });
});

describe("CPU burners", () => {
  test("stop kills exactly the started PIDs, and a second stop is harmless", async () => {
    const burners = startBurners(2, 5000);
    try {
      expect(burners.pids).toHaveLength(2);
      for (const pid of burners.pids) expect(alive(pid), "BURNER_RUNNING").toBe(true);
    } finally { burners.stop(); }
    for (const pid of burners.pids) expect(await gone(pid, 2000), "BURNER_KILLED_BY_PID").toBe(true);
    expect(() => burners.stop()).not.toThrow();
    expect(() => startBurners(0)).toThrow("positive integer");
  });

  test("a burner whose parent is killed exits by itself within its slice", async () => {
    // The parent is SIGKILLed, so no cleanup of its own can run.
    const parent = Bun.spawn([process.execPath, "-e",
      `const child = Bun.spawn([process.execPath, "-e", ${JSON.stringify(burnerSource(0, 5000))}.replace("parent=0", "parent=" + process.pid)], { stdio: ["ignore", "ignore", "ignore"] }); console.log(child.pid); await Bun.sleep(5000);`],
      { stdout: "pipe", stderr: "inherit" });
    const reader = parent.stdout.getReader();
    const burner = Number(new TextDecoder().decode((await reader.read()).value).trim());
    try {
      expect(Number.isSafeInteger(burner) && burner > 1, "BURNER_PID_REPORTED").toBe(true);
      expect(alive(burner)).toBe(true);
      parent.kill("SIGKILL"); await parent.exited;
      expect(await gone(burner, 3000), "ORPHANED_BURNER_EXITS").toBe(true);
    } finally { if (alive(burner)) process.kill(burner, "SIGKILL"); parent.kill("SIGKILL"); }
  });

  test("a burner never outlives its lifetime even with its parent alive", async () => {
    const burners = startBurners(1, 300);
    try { expect(await gone(burners.pids[0]!, 3000), "BURNER_LIFETIME_ENDS").toBe(true); } finally { burners.stop(); }
  });
});

// A real-time race with a fixed schedule: every third landing the crew is slow
// and the tide's timer wins. One run passes; the third repetition fails.
const landings = `import { expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const log = join(import.meta.dir, "landings.count");
const landing = () => { const next = (existsSync(log) ? Number(readFileSync(log, "utf8")) : 0) + 1; writeFileSync(log, String(next)); return next; };
`;
const RACY = `${landings}test("the crew is aboard before the tide turns", async () => {
  const tide = Bun.sleep(150).then(() => "tide");
  const crew = Bun.sleep(landing() % 3 === 0 ? 600 : 1).then(() => "crew");
  expect(await Promise.race([tide, crew])).toBe("crew");
});
`;
// The same fixture made deterministic: the tide waits for the crew, not for a clock.
const DETERMINISTIC = `${landings}test("the crew is aboard before the tide turns", async () => {
  const crew = Bun.sleep(landing() % 3 === 0 ? 60 : 1).then(() => "crew");
  expect(await crew).toBe("crew");
});
`;
const PASSING = (name: string) => `import { expect, test } from "bun:test";\ntest(${JSON.stringify(name)}, () => expect(1).toBe(1));\n`;

function sh(dir: string, ...argv: string[]): string {
  const proc = Bun.spawnSync(argv, { cwd: dir, stdout: "pipe", stderr: "pipe",
    env: { ...process.env, GIT_AUTHOR_NAME: "Penelope", GIT_AUTHOR_EMAIL: "penelope@example.invalid",
      GIT_COMMITTER_NAME: "Penelope", GIT_COMMITTER_EMAIL: "penelope@example.invalid" } });
  if (proc.exitCode !== 0) throw new Error(`${argv.join(" ")}: ${proc.stderr.toString()}`);
  return proc.stdout.toString().trim();
}

/** A committed scratch checkout carrying the real command, wrapper and preload; returns its base commit. */
function checkout(weights: Record<string, number> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "test-determinism-")); scratch.push(dir);
  const write = (path: string, text: string) => { mkdirSync(dirname(join(dir, path)), { recursive: true }); writeFileSync(join(dir, path), text); };
  for (const script of SCRIPTS) cpSync(join(ROOT, "scripts", script), join(dir, "scripts", script));
  // The planner's selection and diff, unchanged; its other imports stay in this repository.
  write("scripts/ci-plan.ts", `export * from ${JSON.stringify(join(ROOT, "scripts/ci-plan.ts"))};\n`);
  write("scripts/test-shard-costs.json", JSON.stringify(weights));
  cpSync(join(ROOT, "packages/core/tests/cli-harness.ts"), join(dir, "packages/core/tests/cli-harness.ts"), { recursive: true });
  write("package.json", JSON.stringify({ name: "odysseus-determinism", private: true, scripts: { test: "bun scripts/test.ts --timeout 30000" } }));
  write("bun.lock", "{ \"lockfileVersion\": 1 }\n");
  write(".gitignore", "tmp/\nnode_modules/\n*.count\nprobe-runtime\nstep-summary.md\n");
  write("tests/harbour.test.ts", PASSING("the harbour is calm"));
  write("tests/retired.test.ts", PASSING("the old route"));
  const commit = (message: string) => { sh(dir, "git", "add", "-A"); sh(dir, "git", "-c", "commit.gpgsign=false", "commit", "-q", "-m", message); return sh(dir, "git", "rev-parse", "HEAD"); };
  sh(dir, "git", "init", "-q");
  return { dir, write, commit, base: commit("fixture base") };
}

/**
 * An explicit offline harness, as in tests/test-network-guard.test.ts: this
 * test process's guard adds its preload to every `bun` it spawns, which would
 * hide whether the wrapper installs its own. An alias the guard does not
 * recognise starts the command with no inherited preload, so a refusal below
 * can only come from scripts/test.ts.
 */
function unguardedRuntime(dir: string): string {
  const runtime = join(dir, "probe-runtime");
  if (!existsSync(runtime)) symlinkSync(process.execPath, runtime);
  return runtime;
}

/** The fixture's own job summary: a hosted job's real summary must never receive a fixture's table. */
const summaryPath = (dir: string) => join(dir, "step-summary.md");
const scratchEnv = (dir: string) => ({ ...process.env, GITHUB_STEP_SUMMARY: summaryPath(dir) });

/**
 * Bun prints differently under GitHub Actions (log groups) and under a coding
 * agent's environment (failures only). The first hosted run failed on exactly
 * that difference, so the receipts name the reporter they run under.
 */
const REPORTERS = {
  "plain": { GITHUB_ACTIONS: undefined },
  "GitHub Actions log groups": { GITHUB_ACTIONS: "true" },
} as const;
function reporterEnv(dir: string, reporter: keyof typeof REPORTERS): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...scratchEnv(dir), ...REPORTERS[reporter] };
  for (const name of ["CLAUDECODE", "AGENT", "REPL_ID", "CI"]) delete env[name];
  return env;
}

async function determinism(dir: string, ...args: string[]): Promise<{ code: number; report: Report; output: string; summary: string }> {
  return determinismUnder(scratchEnv(dir), dir, ...args);
}

async function determinismUnder(env: Record<string, string | undefined>, dir: string, ...args: string[]): Promise<{ code: number; report: Report; output: string; summary: string }> {
  rmSync(summaryPath(dir), { force: true });
  const proc = Bun.spawn([unguardedRuntime(dir), join(dir, "scripts/test-determinism.ts"), "--json", "--burners", "1", ...args],
    { cwd: dir, stdout: "pipe", stderr: "pipe", env });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  let report: Report;
  try { report = JSON.parse(out.trim().split("\n").at(-1)!); } catch { throw new Error(`No report (exit ${code}):\n${out}\n${err}`); }
  return { code, report, output: out + err, summary: existsSync(summaryPath(dir)) ? readFileSync(summaryPath(dir), "utf8") : "" };
}

describe("the command, through the real offline wrapper", () => {
  test.each(Object.keys(REPORTERS) as (keyof typeof REPORTERS)[])("under the %s reporter the racy fixture's failure still names its file and repetition", async reporter => {
    const f = checkout(); f.write("tests/landing.test.ts", RACY); f.commit("a race against the tide");
    const run = await determinismUnder(reporterEnv(f.dir, reporter), f.dir, "--base", f.base);
    expect(run.code, run.output).toBe(1);
    expect(run.output.includes("::group::tests/landing.test.ts: (run #3)"), "REPORTER_IS_THE_ONE_NAMED").toBe(reporter === "GitHub Actions log groups");
    expect(run.report.failure, `FAILURE_NAMED_UNDER_${reporter === "plain" ? "PLAIN" : "LOG_GROUPS"}`).toEqual({ file: "tests/landing.test.ts", repetition: 3,
      test: "the crew is aboard before the tide turns", reason: "a test case failed" });
  }, 60_000);

  test("a racy fixture that fails one run in three fails the gate, with its file, repetition and case named", async () => {
    const f = checkout(); f.write("tests/landing.test.ts", RACY); f.commit("a race against the tide");
    const run = await determinism(f.dir, "--base", f.base);
    expect(run.code, run.output).toBe(1);
    expect(run.report.outcome).toBe("failed");
    expect(run.report.failure, "RACY_FIXTURE_FAILS_AT_ITS_THIRD_REPETITION").toEqual({ file: "tests/landing.test.ts", repetition: 3,
      test: "the crew is aboard before the tide turns", reason: "a test case failed" });
    expect(run.report.files).toEqual([{ file: "tests/landing.test.ts", weightSeconds: 0.1, weighted: false, repetitions: 5 }]);
    expect(run.output).toContain('FAILED: tests/landing.test.ts, repetition 3 of 5: "the crew is aboard before the tide turns"');
    expect(run.summary, "JOB_SUMMARY_NAMES_THE_FAILURE").toContain("**Failed:** `tests/landing.test.ts`, repetition 3, case `the crew is aboard before the tide turns`");
  }, 60_000);

  test("the same fixture made deterministic passes all five repetitions, and the report shows each one ran", async () => {
    const f = checkout(); f.write("tests/landing.test.ts", DETERMINISTIC); f.commit("the tide waits for the crew");
    const run = await determinism(f.dir, "--base", f.base);
    expect(run.code, run.output).toBe(0);
    expect(run.report).toMatchObject({ kind: REPORT_KIND, outcome: "passed", failure: null, repetitions: 5, reduced: false, load: { burners: 1 } });
    expect(run.report.files, "EVERY_REPETITION_OBSERVED").toEqual([{ file: "tests/landing.test.ts", weightSeconds: 0.1, weighted: false, repetitions: 5, observed: 5 }]);
    expect(run.summary, "JOB_SUMMARY_LISTS_EACH_FILE").toContain("| `tests/landing.test.ts` | none | 5 |");
  }, 60_000);

  test("only added and modified Bun test files are selected; a deleted one and other files are not", async () => {
    const f = checkout();
    f.write("tests/harbour.test.ts", PASSING("the harbour is still calm")); f.write("tests/sails.test.ts", PASSING("the sails hold"));
    f.write("tests/notes.md", "Ithaca lies west.\n"); f.write("experiments/judge.test.ts", PASSING("judge"));
    rmSync(join(f.dir, "tests/retired.test.ts")); f.commit("modify, add and delete");
    const run = await determinism(f.dir, "--base", f.base);
    expect(run.code, run.output).toBe(0);
    expect(run.report.files.map(entry => [entry.file, entry.observed]), "ADDED_AND_MODIFIED_ONLY").toEqual([["tests/harbour.test.ts", 5], ["tests/sails.test.ts", 5]]);
  }, 60_000);

  test("a selection that cannot fit five repetitions reports the reduced count per file and still runs each twice", async () => {
    const f = checkout({ "tests/harbour.test.ts": 20, "tests/sails.test.ts": 20 });
    f.write("tests/harbour.test.ts", PASSING("the harbour is still calm")); f.write("tests/sails.test.ts", PASSING("the sails hold")); f.commit("two weighted files");
    const reduced = await determinism(f.dir, "--base", f.base, "--budget-seconds", "130");
    expect(reduced.code, reduced.output).toBe(0);
    expect(reduced.report, "REDUCED_COUNT_REPORTED").toMatchObject({ requested: 5, repetitions: 3, reduced: true, overBudget: false });
    expect(reduced.report.files.map(entry => [entry.file, entry.repetitions, entry.observed])).toEqual([["tests/harbour.test.ts", 3, 3], ["tests/sails.test.ts", 3, 3]]);
    expect(reduced.output).toContain("Reduced from 5 to 3 repetitions");
    const floor = await determinism(f.dir, "--base", f.base, "--budget-seconds", "30");
    expect(floor.code, floor.output).toBe(0);
    expect(floor.report, "FLOOR_STILL_RUNS").toMatchObject({ repetitions: 2, reduced: true, overBudget: true });
    expect(floor.report.files.map(entry => [entry.file, entry.observed]), "EVERY_FILE_RAN_TWICE").toEqual([["tests/harbour.test.ts", 2], ["tests/sails.test.ts", 2]]);
    expect(floor.output).toContain("Over budget at the floor of 2");
  }, 90_000);

  test("the repetitions run under the offline preload: a non-loopback connection fails the gate", async () => {
    const f = checkout();
    f.write("tests/oracle.test.ts", `import { test } from "bun:test";\ntest("the oracle is consulted", async () => { await fetch("https://oracle.example.invalid/prophecy"); });\n`);
    f.commit("consult the oracle");
    const run = await determinism(f.dir, "--base", f.base);
    expect(run.code, run.output).toBe(1);
    expect(run.output, "OFFLINE_PRELOAD_ACTIVE").toContain("Offline test guard: attempted real network access");
    expect(run.output).toContain("fetch https://oracle.example.invalid/prophecy");
    expect(run.report.failure).toMatchObject({ file: "tests/oracle.test.ts", repetition: 1, test: "the oracle is consulted" });
  }, 60_000);

  test("a change with no Bun test file selects nothing and burns nothing; an explicit unknown file is refused", async () => {
    const f = checkout(); f.write("docs/voyage.md", "Ithaca lies west.\n"); f.commit("docs only");
    const none = await determinism(f.dir, "--base", f.base);
    expect(none.code, none.output).toBe(0);
    expect(none.report).toMatchObject({ outcome: "none-selected", files: [], load: { burners: 0 } });
    expect(none.output).not.toContain("CPU burners started");
    expect(none.summary).toContain("No added or modified Bun test file.");
    const unknown = Bun.spawnSync([join(f.dir, "probe-runtime"), join(f.dir, "scripts/test-determinism.ts"), "--burners", "1", "docs/voyage.md"],
      { cwd: f.dir, stdout: "pipe", stderr: "pipe", env: scratchEnv(f.dir) });
    expect(unknown.exitCode).toBe(1);
    expect(unknown.stderr.toString()).toContain("Not a Bun test file under packages/ or tests/: docs/voyage.md");
  }, 60_000);
});
