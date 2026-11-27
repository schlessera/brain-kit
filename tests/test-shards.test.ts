import { describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { assertPartition, balanceTests, discoverTests } from "../scripts/test-shards";
import { DETERMINISM_PARTITIONS } from "../scripts/proof-shards";
import { FLOOR_REPETITIONS } from "../scripts/determinism-plan";

const ROOT = join(import.meta.dir, "..");

test("measured expensive files go in different shards with deterministic ties", () => {
  const files = ["a", "b", "c", "d", "e", "f"];
  const costs = { a: 12, b: 11, c: 10, d: 2, e: 1, f: 1 };
  const shards = balanceTests(files, 3, costs);
  expect(shards).toEqual(balanceTests([...files].reverse(), 3, costs));
  expect(shards.map((shard) => shard.reduce((sum, file) => sum + costs[file as keyof typeof costs], 0))).toEqual([13, 12, 12]);
  expect(shards.every((shard) => shard.length > 0)).toBe(true);
  expect(shards.flat().sort()).toEqual(files);
});

describe("partition coverage guard", () => {
  const files = ["a", "b", "c"];
  const invalid: Record<string, string[][]> = {
    omitted: [["a"], ["b"]],
    duplicated: [["a", "b"], ["b", "c"]],
    unexpected: [["a"], ["b"], ["unexpected"]],
    empty: [["a", "b", "c"], []],
    absent: [],
  };
  for (const [kind, shards] of Object.entries(invalid)) {
    test(`rejects ${kind} assignments`, () => {
      expect(files.length).toBeGreaterThan(0);
      expect(() => assertPartition(files, shards)).toThrow("exactly once");
    });
  }
  test("rejects duplicated discovery", () => {
    expect(() => assertPartition(["a", "a", "b"], [["a"], ["b"]])).toThrow("exactly once");
  });
  test("accepts complete disjoint non-empty assignments", () => {
    expect(() => assertPartition(files, [["a"], ["b"], ["c"]])).not.toThrow();
  });
});

test("invalid costs and impossible shard counts fail before execution", () => {
  for (const total of [0, 1.5, Infinity, Number.MAX_SAFE_INTEGER]) {
    expect(() => balanceTests(["a"], total)).toThrow();
  }
  for (const seconds of [0, -1, Infinity, NaN]) {
    expect(() => balanceTests(["a"], 1, { a: seconds })).toThrow("positive finite");
  }
});

describe("balanced shards run the root command for real", () => {
  async function fixture(check: (dir: string, files: string[]) => Promise<void>) {
    const dir = mkdtempSync(join(tmpdir(), "balanced-test-shards-"));
    const files = [
      "packages/a/same.test.ts", "packages/a/same.test.tsx", "packages/a/entry.spec.mjs",
      "packages/b/entry_test.js", "tests/entry_spec.ts", "tests/nested/entry.test.mts",
    ];
    try {
      mkdirSync(join(dir, "scripts"));
      const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fixture", scripts: { test: manifest.scripts.test } }));
      for (const script of ["test.ts", "offline-command.ts", "offline-command.py", "test-credential-names.json", "docker-test-files.ts", "runtime-test-builds.ts", "test-invocation.ts", "test-invocation-child.ts", "publishable-packages.ts", "test-shards.ts", "test-shard-costs.json", "test-network-preload.ts", "test-home.ts", "test-network-guard.ts", "test-network-child-preload.ts", "workspace-lease.mjs", "host-admission.mjs"]) {
        cpSync(join(ROOT, "scripts", script), join(dir, "scripts", script));
      }
      mkdirSync(join(dir, "packages/core/tests"), { recursive: true });
      cpSync(join(ROOT, "packages/core/tests/cli-harness.ts"), join(dir, "packages/core/tests/cli-harness.ts"));
      for (const file of files) addTest(dir, file);
      // The experiment tier (#1386) and a sibling whose name merely contains
      // "tests" stay out of default discovery and of every balanced shard.
      for (const excluded of ["other/entry.test.ts", "packages/.hidden/entry.test.ts", "packages/a/node_modules/entry.test.ts",
        "experiments/entry.test.ts", "experiment-tests/entry.test.ts"]) {
        addTest(dir, excluded);
      }
      mkdirSync(join(dir, "packages/a/helpers"));
      writeFileSync(join(dir, "packages/a/helpers/not.test-helper.ts"), "throw new Error('not a test');");
      await check(dir, files);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  function addTest(dir: string, file: string) {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), `import { expect, test } from "bun:test";\n` +
      `test(${JSON.stringify(file)}, () => {\n` +
      `  console.log("E" + "XEC " + ${JSON.stringify(file)});\n` +
      `  expect(process.env.FAIL_BALANCED_FILE).not.toBe(${JSON.stringify(file)});\n` +
      `});\n`);
  }

  async function run(dir: string, args: string[], fail?: string) {
    const proc = Bun.spawn([process.execPath, "run", "test", ...args], {
      cwd: dir, stdout: "pipe", stderr: "pipe",
      env: { ...process.env, FAIL_BALANCED_FILE: fail ?? "" },
    });
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    return { code: await proc.exited, files: [...out.matchAll(/^EXEC (.+)$/gm)].map((match) => match[1]!), output: out + err };
  }

  test("three non-empty shards execute exactly the unsharded files, including a newly added test", () => fixture(async (dir, files) => {
    const verify = async () => {
      const full = await run(dir, []);
      expect(full.code).toBe(0);
      expect(full.files.sort()).toEqual([...files].sort());
      expect(discoverTests(dir, ["packages", "tests"])).toEqual(full.files);
      const executed: string[] = [];
      for (let shard = 1; shard <= 3; shard++) {
        const result = await run(dir, [`--balanced-shard=${shard}/3`]);
        if (result.code !== 0) throw new Error(result.output);
        expect(result.files.length).toBeGreaterThan(0);
        executed.push(...result.files);
      }
      expect(new Set(executed).size).toBe(executed.length);
      expect(executed.sort()).toEqual(full.files);
    };
    await verify();
    const added = "packages/new/future.spec.ts";
    addTest(dir, added);
    files.push(added);
    await verify();
  }));

  test("a failing selected file fails the root command", () => fixture(async (dir, files) => {
    const partitions = balanceTests(discoverTests(dir, ["packages", "tests"]), 3);
    const failedFile = files[0]!;
    const index = partitions.findIndex((shard) => shard.includes(failedFile));
    expect(index).toBeGreaterThanOrEqual(0);
    const result = await run(dir, [`--balanced-shard=${index + 1}/3`], failedFile);
    expect(result.files).toContain(failedFile);
    expect(result.code).not.toBe(0);
    expect(result.output).toContain(`(fail) ${failedFile}`);
  }));
});

describe("a Bun test file fits half a determinism partition (#4842)", () => {
  /** Files above the bound today, each with the issue that splits it. */
  const EXEMPT: Record<string, string> = {
    "packages/ui-react/tests/parallel-sessions-runtime.test.ts": "#2793 splits it by scenario group",
    "packages/ui-react/tests/association-signout-runtime.test.ts": "#2793 splits it by scenario group",
  };
  const COSTS = join(ROOT, "scripts/test-shard-costs.json");

  /** A file whose floor repetitions exceed one partition runs alone, past the job's step. */
  function weightBound(costs: Record<string, number>, exempt: Record<string, string>, capacitySeconds: number, floor: number) {
    const bound = capacitySeconds / floor;
    const over = Object.entries(costs).filter(([, weight]) => weight > bound).map(([file]) => file).sort();
    return {
      bound,
      unexempt: over.filter(file => !(file in exempt)).map(file => `${file}: ${costs[file]} s > ${bound} s`),
      stale: Object.keys(exempt).filter(file => !over.includes(file)).sort(),
    };
  }
  const reviewed = () => JSON.parse(readFileSync(COSTS, "utf8")) as Record<string, number>;

  test("no reviewed weight exceeds the bound except the named exemptions", () => {
    const result = weightBound(reviewed(), EXEMPT, DETERMINISM_PARTITIONS.capacitySeconds, FLOOR_REPETITIONS);
    expect(result.bound).toBe(DETERMINISM_PARTITIONS.capacitySeconds / FLOOR_REPETITIONS);
    expect(result.unexempt).toEqual([]);
    expect(result.stale).toEqual([]);
    expect(Object.keys(EXEMPT)).toHaveLength(2);
  });

  test("a weight above the bound fails naming the file and both numbers", () => {
    const costs = { ...reviewed(), "packages/ui-react/tests/connection-continuity-runtime.test.ts": 151 };
    expect(weightBound(costs, EXEMPT, 300, 2).unexempt).toEqual(["packages/ui-react/tests/connection-continuity-runtime.test.ts: 151 s > 150 s"]);
  });

  test("an exemption removed while its file is still above the bound fails", () => {
    const { "packages/ui-react/tests/association-signout-runtime.test.ts": _, ...fewer } = EXEMPT;
    expect(weightBound(reviewed(), fewer, 300, 2).unexempt).toEqual(["packages/ui-react/tests/association-signout-runtime.test.ts: 194.306 s > 150 s"]);
  });

  test("an exemption whose file dropped to the bound or disappeared is stale", () => {
    const costs = { ...reviewed(), "packages/ui-react/tests/association-signout-runtime.test.ts": 150 };
    delete costs["packages/ui-react/tests/parallel-sessions-runtime.test.ts"];
    expect(weightBound(costs, EXEMPT, 300, 2).stale).toEqual(Object.keys(EXEMPT).sort());
  });

  test("the bound follows the partition capacity and the repetition floor", () => {
    const costs = { "a.test.ts": 140, "b.test.ts": 260, "c.test.ts": 90 };
    expect(weightBound(costs, {}, 300, 2)).toEqual({ bound: 150, unexempt: ["b.test.ts: 260 s > 150 s"], stale: [] });
    expect(weightBound(costs, {}, 600, 2).unexempt).toEqual([]);
    expect(weightBound(costs, {}, 300, 3).unexempt).toEqual(["a.test.ts: 140 s > 100 s", "b.test.ts: 260 s > 100 s"]);
  });
});
