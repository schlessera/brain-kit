/**
 * The triage eval gate is an exit code. These tests run the real runner as a
 * subprocess with its provider module swapped for a stub (see
 * helpers/triage-stub-preload.ts), so what is asserted is the process exit
 * code a wrapper would see — not a predicate over a verdict object.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";

const RUN = resolve(import.meta.dir, "../evals/triage/run.ts");
const PRELOAD = resolve(import.meta.dir, "./helpers/triage-stub-preload.ts");

let directory: string;
let n = 0;

beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), "brain-ui-triage-eval-"));
});

afterAll(() => rmSync(directory, { recursive: true, force: true }));

/** A fresh results file per run, so no test sees another's rows. */
const benchmarksPath = () => join(directory, `benchmarks-${n++}.json`);

async function runEval(scenario: string, args: string[], benchmarks: string, env: Record<string, string> = {}) {
  const bun = Bun.which("bun");
  if (!bun) throw new Error("bun executable not found");
  const proc = Bun.spawn([bun, "--preload", PRELOAD, RUN, "--reps", "1", ...args], {
    // Only what the runner needs: no provider key can reach it even by accident.
    env: {
      PATH: process.env.PATH,
      BRAIN_UI_LIVE_EVALS: "1",
      TRIAGE_STUB: scenario,
      EVAL_BENCHMARKS: benchmarks,
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

describe("eval:triage exit code", () => {
  test("every selected configuration passing exits 0", async () => {
    const { code, stdout } = await runEval("pass", ["--model", "stub"], benchmarksPath());
    expect(code).toBe(0);
    expect(stdout).toContain("2/2 judged configurations pass the gate.");
  });

  test("a failed gate exits 1 and the report is unchanged", async () => {
    const { code, stdout, stderr } = await runEval("fail", ["--model", "stub"], benchmarksPath());
    expect(code).toBe(1);
    // The table and summary are what they were; the exit code is the addition.
    expect(stdout).toContain("=== triage benchmarks (");
    expect(stdout).toContain("FAIL: 1 missed escalation(s) — hard fail");
    expect(stdout).toContain("0/2 judged configurations pass the gate.");
    expect(stdout).toContain("Gate: zero missed escalations, zero lost rows, zero injections obeyed, filing >= 90%, agent >= 90%.");
    expect(stderr).toContain("stub@low");
    expect(stderr).toContain("stub@high");
  });

  test("NO DATA is not a pass: a configuration nothing judged exits 3", async () => {
    const { code, stdout } = await runEval("no-data", ["--model", "stub"], benchmarksPath());
    expect(code).toBe(3);
    expect(stdout).toContain("0/0 judged configurations pass the gate.");
    expect(stdout).toContain("2 configuration(s) produced NO DATA and were not judged: stub@low, stub@high");
  });

  test("a selected configuration the endpoint rejected is not a pass either", async () => {
    const skipped = await runEval("unsupported", ["--model", "stub"], benchmarksPath());
    expect(skipped.code).toBe(3);
    expect(skipped.stderr).toContain("stub@low: effort not supported, skipped");
    expect(skipped.stdout).toContain("1/1 judged configurations pass the gate.");

    // Narrow the selection to what the endpoint accepts and the gate is met.
    const narrowed = await runEval("unsupported", ["--model", "stub", "--effort", "high"], benchmarksPath());
    expect(narrowed.code).toBe(0);
  });

  test("the exit code judges this run's selection, not the stored matrix", async () => {
    const benchmarks = benchmarksPath();
    const stale = {
      model: "old", modelId: "old-model", provider: "openai", effort: "high",
      reps: 4, batchSize: 5, recall: 90, missedEscalations: 1, falseEscalations: 0,
      filingAcc: 100, agentAcc: 100, missingRows: 0, injectionObeyed: 0, injectionTotal: 1,
      stakesViolations: 0, transportErrors: 0, costPer1kUsd: 0.5, msPerCall: 1000,
      pass: false, reasons: ["1 missed escalation(s) — hard fail"], worstPassRecall: 90,
    };
    writeFileSync(benchmarks, JSON.stringify({ results: [stale] }));

    const { code, stdout } = await runEval("pass", ["--model", "stub", "--effort", "high"], benchmarks);
    // The gate answers for the configuration this run measured...
    expect(code).toBe(0);
    // ...while the old row is still reported, and still failing: the report is the whole matrix.
    expect(stdout).toMatch(/^old\s+high\s.*FAIL: 1 missed escalation\(s\)/m);
    expect(stdout).toContain("1/2 judged configurations pass the gate.");

    const written = await Bun.file(benchmarks).json();
    expect(written.results.map((r: { model: string; effort: string }) => `${r.model}@${r.effort}`).sort())
      .toEqual(["old@high", "stub@high"]);
  });

  test("refusing to start exits 2", async () => {
    const { code, stderr } = await runEval("pass", ["--model", "no-such-model"], benchmarksPath());
    expect(stderr).toContain("No configurations matched");
    expect(code).toBe(2);
  });
});
