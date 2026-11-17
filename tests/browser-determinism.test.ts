// Changed Vitest browser, layout and story specs repeat under CPU load in the
// pinned container before merge (#4163). Every case is enumerated here against
// the pure planner and a stand-in Vitest; tests/browser-determinism-container.test.ts
// proves the seam once, with the real runner, browser and image.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  BROWSER_BUDGET_SECONDS, DEFAULT_REPETITIONS, FLOOR_REPETITIONS, UNWEIGHTED_PAIR_SECONDS, browserRepetitionsFor, expandSpecs, isRepeatedSpec,
  pairKey, parsePairKey, planBrowserPartitions, planBrowserRepetitions, selectBrowserPartition, type SpecPair,
} from "../scripts/browser-determinism-plan";
import { CONFIG_ROOT, REPORT_KIND, judge, launcherArgv, parseArguments, passPlan, runBrowserDeterminism, summaryMarkdown } from "../scripts/browser-determinism";
import { RESULT_KIND, burnerSource, passCollector, readPassPlan, runPasses, scaleVitestDeadlines, startBurners } from "../scripts/browser-determinism-inside.mjs";
import { readBrowserCosts } from "../scripts/browser-shards";
import { BROWSER_DETERMINISM_PARTITIONS } from "../scripts/proof-shards";

const scratch: string[] = [];
afterEach(() => { for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const stories = "packages/ui-kit/stories", browser = "packages/ui-react/tests/browser", visual = "packages/ui-kit/tests/visual";
const pair = (project: string, file: string): SpecPair => ({ project, file });
const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0);

describe("which specs the gate repeats", () => {
  test("visual, story, pointer, layout and offline specs count; the endurance spec, a helper and anything elsewhere do not", () => {
    const repeated = [`${visual}/sails.visual.tsx`, `${visual}/harbour/quay.visual.tsx`, `${stories}/Sail.stories.tsx`, `${stories}/ship/Mast.stories.tsx`,
      `${browser}/oars.pointer.tsx`, `${browser}/deck.layout.tsx`, `${browser}/offline/fog.offline.tsx`];
    expect(repeated.filter(path => !isRepeatedSpec(path)), "EVERY_SPEC_KIND_COUNTS").toEqual([]);
    const ignored = [`${browser}/watch.endurance.tsx`, `${browser}/offline/fault-network.ts`, `${browser}/conversation-server-command.ts`, `${visual}/request-log.ts`,
      `${stories}/Sail.tsx`, "packages/ui-react/tests/session-demux.test.ts", "packages/ui-react/src/deck.layout.tsx", "packages/core/tests/sails.layout.tsx",
      "packages/ui-kit/tests/sails.visual.tsx", `${browser}/oars.pointer.ts`, "tests/fixtures/browser-determinism/landing-racy.repeat.js"];
    expect(ignored.filter(isRepeatedSpec), "NOTHING_ELSE_COUNTS").toEqual([]);
  });

  test("a spec expands to every project/file pair the listing reports for it, and to nothing else", () => {
    const listing = [pair("visual", `${visual}/sails.visual.tsx`), pair("storybook", `${stories}/Sail.stories.tsx`), pair("storybook-light", `${stories}/Sail.stories.tsx`),
      ...["rail-mixed", "rail-fine", "rail-coarse"].map(project => pair(project, `${browser}/oars.pointer.tsx`)), pair("keyboard-hints-live", `${browser}/keys.pointer.tsx`),
      pair("ui-react-layout", `${browser}/deck.layout.tsx`), pair("diagrams-chromium", `${browser}/diagrams-axis.layout.tsx`), pair("diagrams-webkit", `${browser}/diagrams-axis.layout.tsx`)];
    expect(expandSpecs([`${browser}/oars.pointer.tsx`], listing), "A_POINTER_SPEC_IS_THREE_PAIRS").toEqual(["rail-coarse", "rail-fine", "rail-mixed"].map(project => pair(project, `${browser}/oars.pointer.tsx`)));
    expect(expandSpecs([`${stories}/Sail.stories.tsx`, `${stories}/Sail.stories.tsx`], listing), "A_STORY_IS_BOTH_THEMES_ONCE").toEqual([pair("storybook-light", `${stories}/Sail.stories.tsx`), pair("storybook", `${stories}/Sail.stories.tsx`)]);
    expect(expandSpecs([`${browser}/diagrams-axis.layout.tsx`, `${browser}/deck.layout.tsx`], listing).map(pairKey)).toEqual([
      `diagrams-chromium::${browser}/diagrams-axis.layout.tsx`, `diagrams-webkit::${browser}/diagrams-axis.layout.tsx`, `ui-react-layout::${browser}/deck.layout.tsx`]);
    expect(expandSpecs([], listing)).toEqual([]);
    expect(() => expandSpecs([`${browser}/stray.pointer.tsx`], listing), "A_SPEC_NOTHING_RUNS").toThrow("is a changed spec that no Vitest project lists, so nothing runs it");
    expect(() => expandSpecs([`${browser}/offline/fault-network.ts`], listing), "A_HELPER_IS_NOT_A_SPEC").toThrow("Not a browser, layout or story spec the gate repeats");
  });

  // The reviewed weight table records one row per project/file pair of a complete hosted run: the
  // installed runner's listing at the last refresh, read here without starting Vitest.
  test("every project/file pair of the last complete browser and layout run is a spec the gate repeats, in the projects that ran it", () => {
    const recorded = Object.keys(readBrowserCosts().seconds).map(parsePairKey);
    // A control against an empty or partial table, not a pin on its size: the table had 387 rows
    // before the 2026-11-17 refresh and 514 after it, and that refresh has been reverted once.
    expect(recorded.length, "A_COMPLETE_RUN").toBeGreaterThan(300);
    expect(recorded.filter(spec => !isRepeatedSpec(spec.file)).map(pairKey), "PATTERNS_COVER_EVERY_PROJECT").toEqual([]);
    const projects = (file: string) => expandSpecs([file], recorded).map(spec => spec.project);
    expect(projects(`${browser}/dictation-notice.pointer.tsx`)).toEqual(["rail-coarse", "rail-fine", "rail-mixed"]);
    expect(projects(`${stories}/evidence/SearchResultCard.stories.tsx`)).toEqual(["storybook-light", "storybook"]);
    expect(projects(`${browser}/diagrams-axis.layout.tsx`)).toEqual(["diagrams-chromium", "diagrams-webkit"]);
    expect(projects(`${browser}/handoff-sheet.layout.tsx`)).toEqual(["ui-react-layout"]);
    expect(projects(`${visual}/contact-card-fact-keys.visual.tsx`)).toEqual(["visual"]);
    // The endurance project has no row and its one spec no pattern: real-time media proof keeps its own job.
    expect(recorded.filter(spec => spec.project === "ui-react-endurance")).toEqual([]);
  });

  test("a pair key is a project and a repository path, and nothing that escapes the repository", () => {
    expect(parsePairKey(`rail-fine::${browser}/oars.pointer.tsx`)).toEqual(pair("rail-fine", `${browser}/oars.pointer.tsx`));
    expect(pairKey(pair("harbour", "tests/fixtures/browser-determinism/landing-racy.repeat.js"))).toBe("harbour::tests/fixtures/browser-determinism/landing-racy.repeat.js");
    for (const key of ["oars.pointer.tsx", `::${browser}/oars.pointer.tsx`, "rail-fine::../oars.pointer.tsx", "rail-fine::packages/../../etc/passwd", "rail fine::packages/a.tsx", "rail-fine::/abs/a.tsx"]) {
      expect(() => parsePairKey(key), key).toThrow("Expected <project>::<repository path of a spec>");
    }
  });
});

describe("repetition count and budget", () => {
  const oars = ["rail-coarse", "rail-fine", "rail-mixed"].map(project => pair(project, `${browser}/oars.pointer.tsx`));
  const costs = Object.fromEntries(oars.map((spec, index) => [pairKey(spec), 10 + index * 10]));

  test("the numbers have one owner: five repetitions, a floor of two, 300 weighted seconds, and capacity fits the step limit at the measured load ratio", () => {
    expect(BROWSER_DETERMINISM_PARTITIONS).toEqual({ capacitySeconds: 300, max: 15, stepMinutes: 20, loadRatio: 1.8, unweightedSeconds: 10, deadlineFactor: 3 });
    expect([DEFAULT_REPETITIONS, FLOOR_REPETITIONS, BROWSER_BUDGET_SECONDS, UNWEIGHTED_PAIR_SECONDS]).toEqual([5, 2, 300, 10]);
    const { deadlineFactor, loadRatio, capacitySeconds, stepMinutes } = BROWSER_DETERMINISM_PARTITIONS;
    expect(Number(deadlineFactor), "BROWSER_DEADLINE_COVERS_LOAD_WITH_MARGIN").toBe(Math.ceil(loadRatio * 1.15));
    // Vitest 4.1.11: 15 s browser tests and 30 s browser hooks. One default hang after a full capacity,
    // plus the measured setup/start-up, still fits the unchanged step limit.
    expect(capacitySeconds * loadRatio + 30 * deadlineFactor + 135, "BROWSER_HANG_FITS_STEP_LIMIT").toBeLessThan(stepMinutes * 60);
    // Passes at the measured ratio, plus the measured 2 min 15 s of build, image pull and start-up, inside the proof step.
    expect(BROWSER_DETERMINISM_PARTITIONS.capacitySeconds * BROWSER_DETERMINISM_PARTITIONS.loadRatio + 135, "CAPACITY_FITS_THE_STEP_LIMIT").toBeLessThanOrEqual(BROWSER_DETERMINISM_PARTITIONS.stepMinutes * 60);
  });

  test("ready confirmation asks for two repetitions and every other cadence for five", () => {
    expect(browserRepetitionsFor("confirmation"), "CONFIRMATION_ASKS_FOR_THE_FLOOR").toBe(2);
    for (const cadence of ["draft", "feedback", "feedback-heavy", undefined]) expect(browserRepetitionsFor(cadence), `DEFAULT_COUNT:${cadence}`).toBeUndefined();
    // 60 weighted s per pass: five repetitions fit the budget exactly.
    const counts = Object.fromEntries(["draft", "feedback", "feedback-heavy", "confirmation"].map(cadence => {
      const plan = planBrowserPartitions(oars, { cadence, costs });
      return [cadence, [plan.requested, plan.repetitions, plan.pairs.map(entry => entry.repetitions)]];
    }));
    expect(counts).toEqual({ draft: [5, 5, [5, 5, 5]], feedback: [5, 5, [5, 5, 5]], "feedback-heavy": [5, 5, [5, 5, 5]], confirmation: [2, 2, [2, 2, 2]] });
  });

  test("a selection inside the budget gets five repetitions for every pair", () => {
    const plan = planBrowserRepetitions(oars, { costs });
    expect(plan).toMatchObject({ requested: 5, floor: 2, repetitions: 5, reduced: false, overBudget: false, budgetSeconds: 300, weightSeconds: 60, estimatedSeconds: 300, unweightedSeconds: 10 });
    expect(plan.pairs).toEqual(oars.map((spec, index) => ({ ...spec, weightSeconds: 10 + index * 10, weighted: true, repetitions: 5 })));
  });

  test("five that do not fit drop uniformly to what fits, never below two, and no pair is dropped", () => {
    const reduced = planBrowserRepetitions(oars, { costs, budgetSeconds: 299 });
    expect(reduced, "REDUCED_TO_WHAT_FITS").toMatchObject({ repetitions: 4, reduced: true, overBudget: false, estimatedSeconds: 240 });
    expect(reduced.pairs.map(entry => entry.repetitions), "UNIFORM_REDUCTION").toEqual([4, 4, 4]);
    const floor = planBrowserRepetitions(oars, { costs, budgetSeconds: 100 });
    expect(floor, "FLOOR_OF_TWO_HOLDS").toMatchObject({ repetitions: 2, reduced: true, overBudget: true, estimatedSeconds: 120 });
    expect(floor.pairs.map(entry => [entry.project, entry.repetitions]), "NO_PAIR_DROPPED").toEqual([["rail-coarse", 2], ["rail-fine", 2], ["rail-mixed", 2]]);
  });

  test("a pair without a reviewed weight costs the stated default, is named as unweighted and is never free", () => {
    const added = [pair("storybook", `${stories}/Mast.stories.tsx`), pair("storybook-light", `${stories}/Mast.stories.tsx`)];
    const plan = planBrowserRepetitions([...added, oars[0]!], { costs });
    expect(plan.pairs.map(entry => [entry.project, entry.weightSeconds, entry.weighted])).toEqual([["rail-coarse", 10, true], ["storybook-light", 10, false], ["storybook", 10, false]]);
    expect(plan.weightSeconds, "THE_DEFAULT_COUNTS_TOWARDS_THE_BUDGET").toBe(30);
    // Enough unweighted pairs reduce the count like any other weight: 7 pairs are 70 s per pass, and four passes fit.
    const many = Array.from({ length: 7 }, (_, index) => pair("visual", `${visual}/new-${index}.visual.tsx`));
    expect(planBrowserRepetitions(many, { costs: {} }), "UNWEIGHTED_PAIRS_REDUCE_THE_COUNT").toMatchObject({ weightSeconds: 70, repetitions: 4, reduced: true });
    expect(planBrowserRepetitions(many, { costs: {}, unweightedSeconds: 1 }).repetitions).toBe(5);
  });

  test("the reviewed table weighs real pairs, and one run, a duplicate pair and a non-positive budget are refused", () => {
    const [key, seconds] = Object.entries(readBrowserCosts().seconds)[0]!;
    expect(planBrowserRepetitions([parsePairKey(key)]).pairs, "DEFAULT_COSTS_ARE_THE_REVIEWED_TABLE").toEqual([{ ...parsePairKey(key), weightSeconds: seconds, weighted: true, repetitions: Math.max(2, Math.min(5, Math.floor(300 / seconds))) }]);
    expect(() => planBrowserRepetitions(oars, { costs, repetitions: 1 })).toThrow("at least 2");
    expect(() => planBrowserRepetitions([oars[0]!, oars[0]!], { costs })).toThrow("A project/file pair was selected twice");
    expect(() => planBrowserRepetitions(oars, { costs, budgetSeconds: 0 })).toThrow("budget must be positive");
    expect(planBrowserRepetitions([], { costs })).toMatchObject({ pairs: [], repetitions: 5, weightSeconds: 0 });
  });
});

describe("hosted partitions by reviewed weight", () => {
  const { capacitySeconds, max } = BROWSER_DETERMINISM_PARTITIONS;
  /** `count` pairs whose pass weighs `passSeconds` in all, none heavy enough to need a partition alone. */
  const fleet = (count: number, passSeconds: number) => Object.fromEntries(Array.from({ length: count }, (_, index) =>
    [`ui-react-layout::${browser}/fleet/ship-${String(index).padStart(3, "0")}.layout.tsx`, Number((passSeconds / count * (index % 2 ? 1.5 : 0.5)).toFixed(3))]));
  const pairsOf = (costs: Record<string, number>) => Object.keys(costs).map(parsePairKey);

  test("a selection over capacity at two repetitions plans several partitions that cover every pair exactly once", () => {
    // 450 weighted s per pass, as two of the selections in the spike's window: 900 at the floor of two.
    const costs = fleet(60, 450), pairs = pairsOf(costs);
    for (const cadence of ["draft", "confirmation", "feedback-heavy"]) {
      const plan = planBrowserPartitions(pairs, { cadence, costs });
      expect(plan, cadence).toMatchObject({ repetitions: 2, floor: 2, capacitySeconds, maxPartitions: max, overBudget: true });
      expect(plan.partitions.length, `SEVERAL_PARTITIONS:${cadence}`).toBe(3);
      for (const partition of plan.partitions) {
        expect(partition.estimatedSeconds, "EACH_WITHIN_CAPACITY").toBeLessThanOrEqual(capacitySeconds);
        expect(partition.estimatedSeconds, "AT_THE_SELECTION_COUNT").toBeCloseTo(sum(partition.pairs.map(spec => costs[pairKey(spec)]!)) * 2, 6);
        expect(partition.pairs.length).toBeGreaterThan(0);
      }
      expect(plan.partitions.flatMap(partition => partition.pairs.map(pairKey)).sort(), "EVERY_PAIR_EXACTLY_ONCE").toEqual(Object.keys(costs).sort());
      expect(plan.pairs.map(entry => entry.repetitions), "NO_PAIR_BELOW_THE_FLOOR").toEqual(pairs.map(() => 2));
    }
  });

  test("a selection within one job's capacity stays one partition, and one weighted second more splits it", () => {
    const pairs = [pair("rail-fine", `${browser}/oars.pointer.tsx`), pair("ui-react-layout", `${browser}/deck.layout.tsx`)];
    const costs = { [pairKey(pairs[0]!)]: 20, [pairKey(pairs[1]!)]: 30 };
    const five = planBrowserPartitions(pairs, { cadence: "draft", costs });
    expect(five.partitions, "FIVE_REPETITIONS_ONE_JOB").toEqual([{ pairs, weightSeconds: 50, estimatedSeconds: 250 }]);
    expect(planBrowserPartitions(pairs, { cadence: "draft", costs: { ...costs, [pairKey(pairs[1]!)]: 130 } }), "AT_CAPACITY").toMatchObject({ repetitions: 2, estimatedSeconds: 300, partitions: [{ estimatedSeconds: 300 }] });
    expect(planBrowserPartitions(pairs, { cadence: "draft", costs: { ...costs, [pairKey(pairs[1]!)]: 131 } }).partitions.map(partition => partition.pairs), "OVER_CAPACITY_SPLITS").toEqual([[pairs[1]!], [pairs[0]!]]);
  });

  test("a pair whose repetitions alone exceed the capacity runs in a partition by itself", () => {
    const heavy = pair("rail-mixed", `${browser}/cyclops.pointer.tsx`), light = [pair("rail-fine", `${browser}/oars.pointer.tsx`), pair("visual", `${visual}/sails.visual.tsx`)];
    const costs = { [pairKey(heavy)]: 183, [pairKey(light[0]!)]: 100, [pairKey(light[1]!)]: 40 };
    expect(planBrowserPartitions([heavy, ...light], { costs }).partitions.map(partition => [partition.pairs, partition.estimatedSeconds]), "UNSPLITTABLE_PAIR_ALONE").toEqual([[[heavy], 366], [light, 280]]);
  });

  test("a selection beyond the maximum partition count is refused, naming its weight and the limit", () => {
    const costs = fleet(400, 2400), pairs = pairsOf(costs);
    expect(planBrowserPartitions(pairs, { costs, maxPartitions: 16 }).partitions.length, "SIXTEEN_WOULD_HOLD_IT").toBe(16);
    expect(() => planBrowserPartitions(pairs, { costs })).toThrow(
      "Repeated browser proof refused before it ran: 400 changed project/file pair(s) weigh 2400.0 weighted s per pass, 4800.0 s at the floor of 2 repetitions. " +
      "That needs more than the limit of 15 partitions of 300 weighted s each (BROWSER_DETERMINISM_PARTITIONS, scripts/proof-shards.ts). " +
      "No pair is skipped and the count stays at the floor: split the change.");
    expect(() => planBrowserPartitions([], { costs })).toThrow("Repeated browser proof was not selected");
  });

  test("a partition is read only with the planned count as its divisor", () => {
    const costs = fleet(40, 200), plan = planBrowserPartitions(pairsOf(costs), { costs });
    expect(plan.partitions).toHaveLength(2);
    expect(selectBrowserPartition(plan, "1/2")).toBe(plan.partitions[0]!);
    expect(selectBrowserPartition(plan, "2/2")).toBe(plan.partitions[1]!);
    for (const [shard, refusal] of [["1/1", "Repeated-run partition 1/1 is not in the planned set of 2"], ["1/3", "Repeated-run partition 1/3 is not in the planned set of 2"],
      ["3/2", "Invalid proof shard"], ["0/2", "Expected proof --shard=M/N"], ["2", "Expected proof --shard=M/N"]] as const) {
      expect(() => selectBrowserPartition(plan, shard), shard).toThrow(refusal);
    }
  });
});

// A stand-in for the Vitest instance the container side drives: it reports each module through the
// reporter hook, as Vitest does, and fails where its schedule says.
const REPO = "/odyssey", racy = "tests/fixtures/browser-determinism/landing-racy.repeat.js", steady = "tests/fixtures/browser-determinism/landing-steady.repeat.js";
interface Schedule { fails?: (repetition: number, key: string) => string | null | undefined; silent?: (repetition: number, key: string) => boolean; twice?: (repetition: number, key: string) => boolean; unhandled?: (repetition: number) => string | undefined; }
function standIn(listed: readonly SpecPair[], schedule: Schedule = {}) {
  const collector = passCollector(), runs: string[][] = [];
  const specification = (spec: SpecPair) => ({ project: { name: `${spec.project} (chromium)` }, moduleId: `${REPO}/${spec.file}` });
  const vitest = {
    async globTestSpecifications() { return listed.map(specification); },
    async runTestSpecifications(specifications: ReturnType<typeof specification>[], all: boolean) {
      expect(all).toBe(true);
      const keys = specifications.map(entry => `${entry.project.name.replace(" (chromium)", "")}::${entry.moduleId.slice(REPO.length + 1)}`);
      runs.push(keys);
      // A pair's repetition is how often it has been run: a pass makes one call per project.
      const repetition = runs.filter(run => run.includes(keys[0]!)).length;
      for (const [index, entry] of specifications.entries()) {
        const key = keys[index]!;
        const failed = schedule.fails?.(repetition, key);
        const module = { project: entry.project, moduleId: entry.moduleId, ok: () => failed === undefined || failed === null && false,
          errors: () => failed === null ? [{ message: "No test suite found in file" }] : [],
          children: { *allTests(state?: string) { if (failed && state === "failed") yield { fullName: "the crew is aboard before the tide turns", result: () => ({ errors: [{ message: failed }] }) }; } } };
        if (schedule.silent?.(repetition, key)) continue;
        collector.reporter.onTestModuleEnd(module);
        if (schedule.twice?.(repetition, key)) collector.reporter.onTestModuleEnd(module);
      }
      const unhandled = schedule.unhandled?.(repetition);
      return { testModules: [], unhandledErrors: unhandled ? [{ message: unhandled }] : [] };
    },
  };
  return { vitest, collector, runs };
}
const harbour = pair("harbour", racy), strait = pair("strait", racy);
const passes = (schedule: Schedule, pairs = [harbour, strait], repetitions = 5, listed: readonly SpecPair[] = [harbour, strait, pair("harbour", steady)]) => {
  const { vitest, collector, runs } = standIn(listed, schedule), lines: string[] = [];
  let clock = 0;
  return runPasses({ vitest, collector, pairs, repetitions, repo: REPO, log: line => lines.push(line), now: () => (clock += 500) }).then(outcome => ({ outcome, runs, lines }));
};

describe("further passes in one Vitest process", () => {
  test("every selected pair runs every repetition, and only the selected pairs", async () => {
    const { outcome, runs, lines } = await passes({}, [harbour]);
    expect(outcome).toEqual({ failure: null, alsoFailed: [], passes: [1, 2, 3, 4, 5].map(repetition => ({ repetition, elapsedSeconds: 0.5, ok: true })) });
    // Exactly the pair, never the project's other files nor the file's other project.
    expect(runs, "EXACT_PAIRS_EVERY_PASS").toEqual(Array.from({ length: 5 }, () => [`harbour::${racy}`]));
    expect(lines).toEqual([1, 2, 3, 4, 5].map(repetition => `Repetition ${repetition} of 5: passed in 0.5 s (1 project/file pair(s) in 1 project(s), one project at a time).`));
  });

  test("within a pass the projects run one after another, each with exactly its own pairs", async () => {
    const pairs = [harbour, pair("harbour", steady), strait];
    const { outcome, runs } = await passes({}, pairs, 2);
    expect(outcome.failure).toBeNull();
    // One browser at a time beside the burners: the load the spike measured, never every project at once.
    expect(runs, "ONE_PROJECT_AT_A_TIME").toEqual([[`harbour::${racy}`, `harbour::${steady}`], [`strait::${racy}`], [`harbour::${racy}`, `harbour::${steady}`], [`strait::${racy}`]]);
  });

  test("a spec that passes twice and fails on its third pass fails the run at repetition three, with spec, project and case named", async () => {
    const tide = "expected 'tide' to be 'crew' // Object.is equality";
    const { outcome, runs } = await passes({ fails: (repetition, key) => repetition % 3 === 0 && key === `strait::${racy}` ? tide : undefined });
    expect(outcome.failure, "SPEC_PROJECT_AND_REPETITION_NAMED").toEqual({ project: "strait", file: racy, repetition: 3, test: "the crew is aboard before the tide turns", reason: `a test case failed: ${tide}` });
    expect(outcome.passes.map(pass => pass.ok), "ONE_PASS_WOULD_HAVE_BEEN_GREEN").toEqual([true, true, false]);
    expect(runs, "STOPS_AT_THE_FIRST_FAILING_REPETITION").toEqual([[`harbour::${racy}`], [`strait::${racy}`], [`harbour::${racy}`], [`strait::${racy}`], [`harbour::${racy}`], [`strait::${racy}`]]);
  });

  test("the first failing pair is named, its project's other failures are listed, and no later project runs in that repetition", async () => {
    const { outcome, runs } = await passes({ fails: repetition => repetition === 2 ? "the tide won" : undefined }, [harbour, pair("harbour", steady), strait]);
    expect(outcome.failure).toMatchObject({ project: "harbour", file: racy, repetition: 2 });
    expect(outcome.alsoFailed).toEqual([pair("harbour", steady)]);
    expect(runs.slice(2), "THE_REPETITION_ENDS_AT_ITS_FIRST_FAILING_PROJECT").toEqual([[`harbour::${racy}`, `harbour::${steady}`]]);
  });

  test("a repetition counts only when Vitest reported each selected pair once in it", async () => {
    // A pair with no result in the second pass must not pass on the strength of its first.
    const silent = await passes({ silent: (repetition, key) => repetition === 2 && key === `strait::${racy}` });
    expect(silent.outcome.failure, "AN_EARLIER_RESULT_NEVER_STANDS_IN").toEqual({ project: "strait", file: racy, repetition: 2, test: null,
      reason: "Vitest reported 0 results for this pair in the repetition; a repetition counts only when each pair is reported once" });
    const twice = await passes({ twice: (repetition, key) => repetition === 1 && key === `harbour::${racy}` });
    expect(twice.outcome.failure).toMatchObject({ project: "harbour", repetition: 1, reason: expect.stringContaining("Vitest reported 2 results") });
  });

  test("a file that fails outside a test, and an error outside any file, fail the repetition", async () => {
    const collection = await passes({ fails: (repetition, key) => repetition === 4 && key === `harbour::${racy}` ? null : undefined });
    expect(collection.outcome.failure).toEqual({ project: "harbour", file: racy, repetition: 4, test: null, reason: "No test suite found in file" });
    const unhandled = await passes({ unhandled: repetition => repetition === 2 ? "Browser connection was closed" : undefined });
    expect(unhandled.outcome.failure).toEqual({ project: null, file: null, repetition: 2, test: null, reason: "1 unhandled error(s) outside a test: Browser connection was closed" });
  });

  test("a pair Vitest does not list runs nothing and fails before the first pass", async () => {
    const { outcome, runs } = await passes({}, [harbour, pair("strait", steady)]);
    expect(outcome.failure).toEqual({ project: "strait", file: steady, repetition: null, test: null, reason: "Vitest's own listing has no such project/file pair, so nothing would run" });
    expect(runs).toEqual([]);
  });

  test("the container's plan is validated: a kind, repository paths, at least two repetitions and a bounded load", () => {
    const plan = { kind: RESULT_KIND, version: 1, root: "packages/ui-kit", result: "tmp/browser-determinism/passes.json", pairs: [harbour], repetitions: 2, deadlineFactor: 3, burners: null, cpuList: null };
    expect(readPassPlan(plan)).toEqual({ root: "packages/ui-kit", result: "tmp/browser-determinism/passes.json", pairs: [harbour], repetitions: 2, deadlineFactor: 3, burners: null, cpuList: null });
    expect(readPassPlan({ ...plan, burners: 0, cpuList: "12-15" })).toMatchObject({ burners: 0, cpuList: "12-15" });
    for (const [label, change, refusal] of [
      ["ONE_PASS_PROVES_NOTHING", { repetitions: 1 }, "at least two"], ["NO_PAIR", { pairs: [] }, "at least one project/file pair"],
      ["DUPLICATE_PAIR", { pairs: [harbour, harbour] }, "selected twice"], ["ESCAPING_SPEC", { pairs: [pair("harbour", "../etc/passwd")] }, "at least one project/file pair"],
      ["ESCAPING_ROOT", { root: "../elsewhere" }, "repository paths"], ["RESULT_OUTSIDE_TMP", { result: "packages/passes.json" }, "repository paths"],
      ["BAD_FACTOR", { deadlineFactor: 0 }, "whole number from 1 to 100"], ["MISSING_FACTOR", { deadlineFactor: undefined }, "whole number from 1 to 100"],
      ["NEGATIVE_LOAD", { burners: -1 }, "non-negative integer"], ["NOT_A_CPU_LIST", { cpuList: "12-15; rm" }, "CPU list"], ["ANOTHER_KIND", { kind: "brain-test-determinism" }, "Not a browser repetition plan"],
    ] as const) expect(() => readPassPlan({ ...plan, ...change }), label).toThrow(refusal);
  });
});

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function gone(pid: number, withinMs: number): Promise<boolean> {
  for (const deadline = Date.now() + withinMs; Date.now() < deadline; await Bun.sleep(20)) if (!alive(pid)) return true;
  return !alive(pid);
}

describe("CPU burners inside the container", () => {
  test("stop kills exactly the started PIDs, a second stop is harmless, and zero burners is a diagnosis", async () => {
    const burners = startBurners(2, 5000);
    try {
      expect(burners.pids).toHaveLength(2);
      for (const pid of burners.pids) expect(alive(pid), "BURNER_RUNNING").toBe(true);
    } finally { burners.stop(); }
    for (const pid of burners.pids) expect(await gone(pid, 2000), "BURNER_KILLED_BY_PID").toBe(true);
    expect(() => burners.stop()).not.toThrow();
    expect(startBurners(0).pids).toEqual([]);
    expect(() => startBurners(-1)).toThrow("non-negative integer");
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

describe("the command", () => {
  const selection = [harbour, strait];
  const costs = { [pairKey(harbour)]: 4 };
  function checkout() {
    const dir = mkdtempSync(join(tmpdir(), "browser-determinism-")); scratch.push(dir);
    return dir;
  }
  /** A launcher that behaves as the container would: reads the plan the command wrote and writes a result beside it. */
  const container = (result: (plan: ReturnType<typeof passPlan>) => object | undefined, exitCode: number, seen: { argv?: string[]; plan?: ReturnType<typeof passPlan> } = {}) =>
    async (argv: string[], cwd: string) => {
      seen.argv = argv; seen.plan = JSON.parse(readFileSync(join(cwd, "tmp/browser-determinism/plan.json"), "utf8"));
      const written = result(seen.plan!);
      if (written) { mkdirSync(dirname(join(cwd, seen.plan!.result)), { recursive: true }); writeFileSync(join(cwd, seen.plan!.result), JSON.stringify(written)); }
      return exitCode;
    };
  const green = (plan: ReturnType<typeof passPlan>) => ({ kind: RESULT_KIND, version: 1, pairs: plan.pairs, repetitions: plan.repetitions, load: { burners: 4, cpus: 4 },
    passes: Array.from({ length: plan.repetitions }, (_, index) => ({ repetition: index + 1, elapsedSeconds: 1.5, ok: true })), failure: null, alsoFailed: [] });

  test("it hands the container exactly its pairs, count and load, through the launcher with the pairs' projects", async () => {
    const seen: { argv?: string[]; plan?: ReturnType<typeof passPlan> } = {}, lines: string[] = [];
    const report = await runBrowserDeterminism({ root: checkout(), pairs: selection, costs, configRoot: "tests/fixtures/browser-determinism", cpuList: "12-15", launch: container(green, 0, seen), log: line => lines.push(line) });
    expect(seen.argv, "THE_BROWSER_SUITES_LAUNCHER").toEqual(["node", "scripts/visual.mjs", "--project=harbour", "--project=strait", "--repeat-plan=tmp/browser-determinism/plan.json"]);
    expect(seen.plan).toEqual({ kind: RESULT_KIND, version: 1, root: "tests/fixtures/browser-determinism", result: "tmp/browser-determinism/passes.json", pairs: selection, repetitions: 5, deadlineFactor: 3, burners: null, cpuList: "12-15" });
    expect(report).toMatchObject({ kind: REPORT_KIND, version: 1, outcome: "passed", failure: null, exitCode: 0, repetitions: 5, requested: 5, weightSeconds: 14, load: { burners: 4, cpus: 4, inside: "pinned container" } });
    expect(report.pairs.map(entry => [entry.project, entry.weighted, entry.weightSeconds]), "UNWEIGHTED_PAIR_NAMED_IN_THE_REPORT").toEqual([["harbour", true, 4], ["strait", false, 10]]);
    expect(lines.find(line => line.includes("strait")), "AND_IN_THE_LOG").toContain("no reviewed weight: costed at the 10s default");
    expect(passPlan(report), "THE_GATES_OWN_CONFIGURATION_BY_DEFAULT").toMatchObject({ root: CONFIG_ROOT, deadlineFactor: 3, burners: null, cpuList: null });
    expect(launcherArgv([pair("rail-fine", `${browser}/a.pointer.tsx`), pair("rail-fine", `${browser}/b.pointer.tsx`), pair("ui-react-layout", `${browser}/c.layout.tsx`)]).slice(2, 4), "ONE_FLAG_PER_PROJECT").toEqual(["--project=rail-fine", "--project=ui-react-layout"]);
  });

  test("the container's first failing repetition fails the command and names the spec, the project and the repetition", async () => {
    const lines: string[] = [];
    const failed = (plan: ReturnType<typeof passPlan>) => ({ ...green(plan), passes: [{ repetition: 1, elapsedSeconds: 1, ok: true }, { repetition: 2, elapsedSeconds: 1, ok: true }, { repetition: 3, elapsedSeconds: 1, ok: false }],
      failure: { project: "strait", file: racy, repetition: 3, test: "the crew is aboard before the tide turns", reason: "a test case failed: expected 'tide' to be 'crew'" }, alsoFailed: [harbour] });
    const report = await runBrowserDeterminism({ root: checkout(), pairs: selection, costs, launch: container(failed, 1), log: line => lines.push(line) });
    expect(report).toMatchObject({ outcome: "failed", exitCode: 1, alsoFailed: [harbour],
      failure: { file: racy, project: "strait", repetition: 3, test: "the crew is aboard before the tide turns", reason: "a test case failed: expected 'tide' to be 'crew'" } });
    expect(lines).toContain(`FAILED: ${racy} in project strait, repetition 3 of 5: "the crew is aboard before the tide turns" (a test case failed: expected 'tide' to be 'crew').`);
    expect(lines.at(-1)).toBe("A changed spec must pass every repetition. Fix the spec or what it exposes; a rerun is not a fix.");
    const summary = summaryMarkdown(report);
    expect(summary).toContain("### Changed browser specs under CPU load: failed");
    expect(summary).toContain(`**Failed:** \`${racy}\` in project \`strait\`, repetition 3, case \`the crew is aboard before the tide turns\``);
    expect(summary).toContain(`| \`strait\` | \`${racy}\` | none (10 default) | 5 |`);
    expect(summary).toContain("Pass seconds: 1.0, 1.0, 1.0 (failed).");
  });

  test("a green exit is not a pass without a result that shows this plan's pairs and every repetition", async () => {
    const run = (result: (plan: ReturnType<typeof passPlan>) => object | undefined, exitCode = 0) =>
      runBrowserDeterminism({ root: checkout(), pairs: selection, costs, launch: container(result, exitCode), log: () => {} }).then(report => [report.outcome, report.exitCode, report.failure?.reason]);
    expect(await run(green)).toEqual(["passed", 0, undefined]);
    expect(await run(() => undefined), "NO_RESULT").toEqual(["failed", 1, "the pinned container exited 0 without a readable repetition result"]);
    expect(await run(() => undefined, 137), "KILLED_CONTAINER").toEqual(["failed", 137, "the pinned container exited 137 without a readable repetition result"]);
    // One pass only: the result a runner that skipped its further passes would write.
    expect(await run(plan => ({ ...green(plan), passes: green(plan).passes.slice(0, 1) })), "ONE_PASS_IS_NOT_FIVE").toEqual(["failed", 1,
      "ran 1 of 5 repetitions according to the container's result; a passing run must show every repetition"]);
    expect(await run(plan => ({ ...green(plan), pairs: plan.pairs.slice(0, 1) })), "A_DROPPED_PAIR").toEqual(["failed", 1, "the container's result names another selection or repetition count than this plan"]);
    expect(await run(plan => ({ ...green(plan), repetitions: 2 })), "ANOTHER_COUNT").toEqual(["failed", 1, "the container's result names another selection or repetition count than this plan"]);
    expect(await run(plan => ({ ...green(plan), kind: "brain-test-determinism" })), "ANOTHER_KIND").toEqual(["failed", 1, "the pinned container exited 0 without a readable repetition result"]);
    expect(await run(green, 1), "RED_EXIT_AFTER_GREEN_PASSES").toEqual(["failed", 1, "the pinned container exited 1 after reporting every repetition green"]);
    expect(judge(planBrowserRepetitions(selection, { costs }), undefined, 0).failure?.repetition).toBeNull();
  });

  test("no changed spec is no container run, and a stale result never survives into the next run", async () => {
    let launched = 0;
    const none = await runBrowserDeterminism({ root: checkout(), pairs: [], launch: async () => { launched++; return 0; }, log: () => {} });
    expect([none.outcome, none.exitCode, launched]).toEqual(["none-selected", 0, 0]);
    expect(summaryMarkdown(none)).toContain("No added or modified browser, layout or story spec.");
    const root = checkout();
    const first = await runBrowserDeterminism({ root, pairs: selection, costs, launch: container(green, 0), log: () => {} });
    expect(first.outcome).toBe("passed");
    // The second container writes nothing: the first run's green result must not be read again.
    const second = await runBrowserDeterminism({ root, pairs: selection, costs, launch: container(() => undefined, 0), log: () => {} });
    expect(second.outcome, "STALE_RESULT_REMOVED").toBe("failed");
  });

  test("arguments name either a base or explicit project/file pairs, never both or neither", () => {
    expect(parseArguments(["--base", "origin/main", "--json"])).toEqual({ base: "origin/main", pairs: [], json: true });
    expect(parseArguments(["--report=tmp/r.json", "--burners", "0", "--repetitions=3", "--budget-seconds", "90", "--cpu-list=12-15", "--config-root", "tests/fixtures/browser-determinism", `harbour::${racy}`]))
      .toEqual({ pairs: [harbour], json: false, report: "tmp/r.json", burners: 0, repetitions: 3, budgetSeconds: 90, cpuList: "12-15", configRoot: "tests/fixtures/browser-determinism" });
    for (const args of [[], ["--json"], ["--base", "origin/main", `harbour::${racy}`], ["--repetitions", "1", `harbour::${racy}`], ["--base"], ["--unknown", `harbour::${racy}`],
      [racy], ["--cpu-list", "all", `harbour::${racy}`], ["--config-root", "../elsewhere", `harbour::${racy}`], ["--burners", "-1", `harbour::${racy}`]]) {
      expect(() => parseArguments(args), args.join(" ")).toThrow("usage:");
    }
  });
});

test("resolved Vitest projects scale their own default caps and expose the factor to browser watchdogs", () => {
  const projects: { name: string; config: { testTimeout: number; hookTimeout: number; env: Record<string, string> } }[] = [
    { name: "harbour", config: { testTimeout: 15000, hookTimeout: 10000, env: { TIDE: "high" } } },
    { name: "strait", config: { testTimeout: 1700, hookTimeout: 900, env: {} } },
    { name: "unbounded", config: { testTimeout: 0, hookTimeout: 0, env: {} } },
  ];
  scaleVitestDeadlines({ projects }, 3);
  expect(projects.map(project => project.config), "PROJECT_DEFAULTS_AND_BROWSER_ENV_SCALE").toEqual([
    { testTimeout: 45000, hookTimeout: 30000, env: { TIDE: "high", BRAIN_TEST_DEADLINE_FACTOR: "3" } },
    { testTimeout: 5100, hookTimeout: 2700, env: { BRAIN_TEST_DEADLINE_FACTOR: "3" } },
    { testTimeout: 0, hookTimeout: 0, env: { BRAIN_TEST_DEADLINE_FACTOR: "3" } },
  ]);
});


test("a diagnostic deadline factor is validated, reported and handed unchanged to the container", async () => {
  expect(parseArguments(["--deadline-factor", "1", "harbour::tests/fixtures/browser-deadlines/deadline-work.repeat.js"]).deadlineFactor).toBe(1);
  for (const value of ["0", "101", "3.5", "", "three"])
    expect(() => parseArguments(["--deadline-factor", value, "harbour::tests/fixtures/browser-deadlines/deadline-work.repeat.js"])).toThrow("whole number from 1 to 100");
  expect(passPlan(planBrowserRepetitions([pair("harbour", "tests/fixtures/browser-deadlines/deadline-work.repeat.js")], { costs: {} }), { deadlineFactor: 1 }).deadlineFactor).toBe(1);
});
