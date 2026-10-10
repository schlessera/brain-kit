// The experiment tier and its release gate (#1386). Product discovery never
// selects `experiments/`; release preparation runs all of it through
// `bun run test:experiments`, whose receipt `scripts/publish.ts` requires for
// the exact candidate. These run the real command and the real gate against a
// scratch Git checkout, so a failing, skipped or partial run, or any later
// change to the source, lock or inventory, is shown to block the release.
import { describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DEFAULT_ROOTS } from "../scripts/test";
import { discoverTests } from "../scripts/test-shards";
import {
  assertExperimentReceipt, candidate, danglingBins, EXPERIMENT_ROOT, experimentRunArgv, missingTools, readJunit, RECEIPT_PATH,
  RECEIPT_SCHEMA, receiptProblems, REQUIRED_TOOLS, runProblems, type Candidate,
} from "../scripts/test-experiments";

const ROOT = join(import.meta.dir, "..");
const SCRIPTS = ["test.ts", "test-experiments.ts", "test-shards.ts", "test-shard-costs.json", "test-network-preload.ts",
  "test-network-guard.ts", "test-network-child-preload.ts", "workspace-lease.mjs"];

const passing = (name: string) => `import { expect, test } from "bun:test";\ntest(${JSON.stringify(name)}, () => expect(1).toBe(1));\n`;

function sh(dir: string, ...argv: string[]) {
  const proc = Bun.spawnSync(argv, { cwd: dir, stdout: "pipe", stderr: "pipe",
    env: { ...process.env, GIT_AUTHOR_NAME: "Penelope", GIT_AUTHOR_EMAIL: "penelope@example.invalid",
      GIT_COMMITTER_NAME: "Penelope", GIT_COMMITTER_EMAIL: "penelope@example.invalid" } });
  if (proc.exitCode !== 0) throw new Error(`${argv.join(" ")}: ${proc.stderr.toString()}`);
  return proc.stdout.toString();
}

/** A committed scratch checkout carrying the real test scripts and a two-file tier. */
async function checkout(use: (dir: string) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "experiment-tier-"));
  try {
    mkdirSync(join(dir, "scripts"));
    for (const script of SCRIPTS) cpSync(join(ROOT, "scripts", script), join(dir, "scripts", script));
    // The actual preload also owns cleanup for the shared CLI harness.
    mkdirSync(join(dir, "packages/core/tests"), { recursive: true });
    cpSync(join(ROOT, "packages/core/tests/cli-harness.ts"), join(dir, "packages/core/tests/cli-harness.ts"));
    writeFileSync(join(dir, "packages/core/tests/product.test.ts"), passing("product"));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fixture", private: true }));
    writeFileSync(join(dir, "bun.lock"), "{ \"lockfileVersion\": 1 }\n");
    writeFileSync(join(dir, ".gitignore"), "tmp/\nnode_modules/\n");
    mkdirSync(join(dir, "experiments/core"), { recursive: true });
    writeFileSync(join(dir, "experiments/harness.test.ts"), passing("harness"));
    writeFileSync(join(dir, "experiments/core/judge.test.ts"), passing("judge"));
    sh(dir, "git", "init", "-q");
    sh(dir, "git", "add", "-A");
    sh(dir, "git", "commit", "-q", "-m", "fixture");
    await use(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function runTier(dir: string) {
  const proc = Bun.spawn([process.execPath, join(dir, "scripts/test-experiments.ts")], { cwd: dir, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, output: out + err };
}

const refusal = (dir: string) => {
  try { assertExperimentReceipt(dir); return ""; } catch (error) { return String(error); }
};

describe("experiment tier discovery", () => {
  test("its root is disjoint from the product roots, and its files are not product files", () => {
    expect(DEFAULT_ROOTS).not.toContain(EXPERIMENT_ROOT);
    const product = new Set(discoverTests(ROOT, DEFAULT_ROOTS));
    const experiments = discoverTests(ROOT, [EXPERIMENT_ROOT]);
    expect(experiments.length).toBeGreaterThan(0);
    expect(experiments.filter((file) => product.has(file))).toEqual([]);
    expect(experiments.every((file) => file.startsWith(`${EXPERIMENT_ROOT}/`))).toBe(true);
  });

  test("the product guards with an experiment origin stay in product discovery", () => {
    // CI names both (scripts/check-pr.ts runtime proof, scripts/ci-plan.ts FAST_TESTS).
    const product = discoverTests(ROOT, DEFAULT_ROOTS);
    for (const guard of ["tests/measurement-isolation.test.ts", "tests/measurement-fixture-lifetime.test.ts", "tests/show-block-schema-forms.test.ts"]) {
      expect(product).toContain(guard);
    }
  });

  test("the command runs the tier through the root wrapper and its offline preload, with the 30s timeout", () => {
    const argv = experimentRunArgv("tmp/x.xml", "bun");
    expect(argv.slice(1, 6)).toEqual([join(ROOT, "scripts/test.ts"), "./experiments", "--timeout", "30000", "--reporter=junit"]);
  });

  test("an unbuilt workspace (dangling package bins) is detected", () => {
    const dir = mkdtempSync(join(tmpdir(), "experiment-bins-"));
    try {
      mkdirSync(join(dir, "node_modules/.bin"), { recursive: true });
      writeFileSync(join(dir, "built.js"), "");
      symlinkSync("../../built.js", join(dir, "node_modules/.bin/built"));
      symlinkSync("../@fixture/pkg/dist/cli.js", join(dir, "node_modules/.bin/unbuilt"));
      expect(danglingBins(dir)).toEqual(["node_modules/.bin/unbuilt"]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("a missing namespace or launcher tool refuses the tier rather than skipping", () => {
    expect(missingTools(() => "/usr/bin/x")).toEqual([]);
    expect(missingTools((name) => name === "bwrap" ? null : "/usr/bin/x")).toEqual(["bwrap"]);
    expect([...REQUIRED_TOOLS]).toEqual(expect.arrayContaining(["python3", "bwrap", "unshare", "setpriv"]));
  });
});

describe("experiment tier results", () => {
  const scratch = (files: Record<string, string>, use: (xml: string) => void) => {
    const dir = mkdtempSync(join(tmpdir(), "experiment-junit-"));
    try {
      writeFileSync(join(dir, "package.json"), "{}");
      for (const [file, body] of Object.entries(files)) {
        mkdirSync(dirname(join(dir, file)), { recursive: true });
        writeFileSync(join(dir, file), body);
      }
      // A plain Bun run, no preload: the fixture files only use bun:test.
      Bun.spawnSync([process.execPath, "test", "./experiments", "--reporter=junit", "--reporter-outfile=out.xml"], { cwd: dir, stdout: "pipe", stderr: "pipe" });
      use(readFileSync(join(dir, "out.xml"), "utf8"));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  };

  test("Bun's report yields executed files and totals, with todo counted as skipped", () => scratch({
    "experiments/a.test.ts": `import { describe, test } from "bun:test";\ntest("ok", () => {});\ntest.skip("skip", () => {});\ntest.todo("todo");\ndescribe("group", () => { test("inner", () => {}); });\n`,
    "experiments/sub/b.test.ts": `import { test } from "bun:test";\ntest("fails", () => { throw new Error("x"); });\n`,
    "experiments/no-tests.test.ts": "export {};\n",
  }, (xml) => {
    expect(readJunit(xml)).toEqual({ files: ["experiments/a.test.ts", "experiments/sub/b.test.ts"], tests: 5, failures: 1, skipped: 2 });
  }));

  const before: Candidate = { tree: "t", head: "h", lock: { path: "bun.lock", sha256: "l" }, bun: "1.4.2",
    inventory: { root: "experiments", files: ["experiments/a.test.ts", "experiments/b.test.ts"], sha256: "i" } };
  const clean = { exitCode: 0, files: ["experiments/a.test.ts", "experiments/b.test.ts"], tests: 4, failures: 0, skipped: 0 };

  test("only a complete, clean run of the unchanged candidate proves the tier", () => {
    expect(runProblems(before, clean, before)).toEqual([]);
    expect(runProblems(before, { ...clean, exitCode: 1 }, before)).toEqual(["bun test exited 1"]);
    expect(runProblems(before, { ...clean, failures: 1 }, before)).toEqual(["1 test(s) failed"]);
    expect(runProblems(before, { ...clean, skipped: 1 }, before)[0]).toContain("skipped or todo");
    expect(runProblems(before, { ...clean, files: ["experiments/a.test.ts"] }, before)[0]).toContain("did not execute: experiments/b.test.ts");
    expect(runProblems(before, { ...clean, files: [...clean.files, "experiments/c.test.ts"] }, before)[0]).toContain("outside the inventory");
    expect(runProblems(before, clean, { ...before, tree: "changed" })[0]).toContain("the run changed its own candidate");
    expect(runProblems(before, { ...clean, tests: 0 }, before)).toContain("no test executed");
  });

  test("a receipt is evidence only for its own candidate and a clean complete result", () => {
    const receipt = { schema: RECEIPT_SCHEMA, candidate: before, result: { files: 2, tests: 4, failures: 0, skipped: 0 }, recordedAt: "x" };
    expect(receiptProblems(receipt, before)).toEqual([]);
    expect(receiptProblems(receipt, { ...before, head: "a later commit of the same tree" })).toEqual([]);
    expect(receiptProblems(receipt, { ...before, tree: "u" })[0]).toContain("source tree");
    expect(receiptProblems(receipt, { ...before, lock: { path: "bun.lock", sha256: "m" } })).toEqual(["bun.lock changed since the run"]);
    expect(receiptProblems(receipt, { ...before, inventory: { ...before.inventory, sha256: "j" } })[0]).toContain("inventory");
    expect(receiptProblems(receipt, { ...before, bun: "1.4.3" })[0]).toContain("Bun 1.4.2");
    expect(receiptProblems({ ...receipt, result: { ...receipt.result, skipped: 1 } }, before)).toContain("the recorded run had failures or skips");
    expect(receiptProblems({ ...receipt, result: { ...receipt.result, files: 1 } }, before)).toContain("the recorded run did not execute the complete inventory");
    expect(receiptProblems({}, before)).toEqual(["the receipt is not an experiment-tier receipt"]);
  });
});

describe("the experiment command and the release gate, run for real", () => {
  test("a clean run records a receipt the gate accepts until the source, lock or inventory changes", () => checkout(async (dir) => {
    expect(refusal(dir)).toContain(`no experiment-tier receipt at ${RECEIPT_PATH}`);
    const run = await runTier(dir);
    expect(run.code, run.output).toBe(0);
    expect(run.output).toContain("Experiment tier passed: 2 tests in 2 files.");
    // The product test beside it is not part of the tier.
    expect(run.output).not.toContain("packages/core/tests/product.test.ts");
    const receipt = JSON.parse(readFileSync(join(dir, RECEIPT_PATH), "utf8"));
    expect(receipt.candidate).toEqual(candidate(dir));
    expect(receipt.result).toEqual({ files: 2, tests: 2, failures: 0, skipped: 0 });
    expect(refusal(dir)).toBe("");

    // Committing the same tree keeps the evidence; ignored output does not count.
    writeFileSync(join(dir, "tmp/build-output.txt"), "ignored\n");
    sh(dir, "git", "commit", "-q", "--allow-empty", "-m", "version packages");
    expect(refusal(dir)).toBe("");

    const lock = readFileSync(join(dir, "bun.lock"), "utf8");
    writeFileSync(join(dir, "bun.lock"), lock.replace("1", "2"));
    expect(refusal(dir)).toContain("bun.lock changed since the run");
    writeFileSync(join(dir, "bun.lock"), lock);
    expect(refusal(dir)).toBe("");

    writeFileSync(join(dir, "packages/core/source.ts"), "export const changed = true;\n");
    expect(refusal(dir)).toContain("source tree");
    rmSync(join(dir, "packages/core/source.ts"));
    expect(refusal(dir)).toBe("");

    writeFileSync(join(dir, "experiments/added.test.ts"), passing("added"));
    expect(refusal(dir)).toContain("the experiment test inventory changed since the run");
  }));

  for (const [kind, body, message] of [
    ["failing", `import { test } from "bun:test";\ntest("fails", () => { throw new Error("deliberate"); });\n`, "test(s) failed"],
    ["skipped", `import { test } from "bun:test";\ntest.skip("skipped", () => {});\ntest("ok", () => {});\n`, "skipped or todo"],
    ["todo", `import { test } from "bun:test";\ntest.todo("later");\ntest("ok", () => {});\n`, "skipped or todo"],
    ["only", `import { test } from "bun:test";\ntest.only("only", () => {});\ntest("hidden", () => {});\n`, "bun test exited"],
    ["empty", "export {};\n", "did not execute: experiments/core/judge.test.ts"],
  ] as const) {
    test(`a ${kind} experiment test records no receipt, so the release is refused`, () => checkout(async (dir) => {
      expect((await runTier(dir)).code).toBe(0);
      expect(refusal(dir)).toBe("");
      writeFileSync(join(dir, "experiments/core/judge.test.ts"), body);
      const run = await runTier(dir);
      expect(run.code, run.output).not.toBe(0);
      expect(run.output).toContain("no receipt recorded");
      expect(run.output).toContain(message);
      // The earlier passing receipt is gone, not merely stale.
      expect(refusal(dir)).toContain("no experiment-tier receipt");
      // Failure reports carry absolute local paths; none is left in the
      // checkout for the whole-tree leakage gate to find.
      expect(readdirSync(join(dir, "tmp")).filter((name) => name.endsWith(".xml"))).toEqual([]);
    }));
  }

  test("an unbuilt workspace refuses the tier before running anything", () => checkout(async (dir) => {
    mkdirSync(join(dir, "node_modules/.bin"), { recursive: true });
    symlinkSync("../@fixture/pkg/dist/cli.js", join(dir, "node_modules/.bin/unbuilt"));
    const run = await runTier(dir);
    expect(run.code).not.toBe(0);
    expect(run.output).toContain("the workspace is not built (node_modules/.bin/unbuilt dangle)");
    expect(refusal(dir)).toContain("no experiment-tier receipt");
  }));

  test("arguments are refused: a partial run can never record a receipt", () => checkout(async (dir) => {
    const proc = Bun.spawnSync([process.execPath, join(dir, "scripts/test-experiments.ts"), "experiments/harness.test.ts"], { cwd: dir, stdout: "pipe", stderr: "pipe" });
    expect(proc.exitCode).not.toBe(0);
    expect(proc.stderr.toString()).toContain("takes no arguments");
    expect(refusal(dir)).toContain("no experiment-tier receipt");
  }));
});
