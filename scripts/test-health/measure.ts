/**
 * Measures how a test behaves over repeated runs: how long it takes, whether
 * it always passes, and what makes it fail when it does not.
 *
 * Four variants, each answering one question:
 *   repeat   - alone, default order: is it stable, and how long does it take?
 *   shuffle  - alone, randomized case order: do its cases depend on each other?
 *   together - with its cluster in one process: do files leak into each other?
 *   stress   - alone while every CPU is busy: does it depend on spare capacity?
 *
 * The verdict names the first variant that fails. Timings come from `repeat`
 * only, so a before/after pair compares like with like. A file whose every
 * repeat run exits nonzero without collecting a single case never reached its
 * tests: that is `not-collected` (a missing build, a load error), not `failing`.
 */
import { availableParallelism } from "node:os";
import type { CaseResult } from "./junit";
import type { RunOutput, TestRunner } from "./runner";

export type Verdict = "stable" | "not-collected" | "failing" | "flaky" | "order-dependent" | "leaks-between-files" | "load-sensitive";

export interface FileMeasure {
  file: string;
  /** Runs and failures across every variant that ran this file alone. */
  runs: number;
  failures: number;
  /** Wall time of the `repeat` runs. */
  medianMs: number | null;
  minMs: number | null;
  maxMs: number | null;
  verdict: Verdict;
  variants: Record<string, { runs: number; failures: number }>;
  failingCases: Array<{ name: string; failures: number; message?: string }>;
  /** Cases that passed without executing a single assertion. */
  zeroAssertionCases: string[];
  skippedCases: string[];
  slowestCases: Array<{ name: string; medianMs: number }>;
  /** Every case of one representative run: what the batch's test accounting compares before and after a change. */
  cases: Array<{ name: string; state: "passed" | "failed" | "skipped"; assertions: number | null }>;
  /** Only for `not-collected`: the last lines the runner printed, which name why nothing was collected. */
  setupError?: string;
}
export interface MeasureResult {
  schemaVersion: 1;
  tool: "test-health measure";
  at: string;
  files: FileMeasure[];
  together: { runs: number; failures: number; failingCases: string[] } | null;
}

export interface MeasureOptions {
  files: string[];
  runner: TestRunner;
  runs: number;
  shuffle?: boolean;
  together?: boolean;
  stress?: boolean;
  /** Vitest projects per file, for browser tiers. */
  projects?: ReadonlyMap<string, string[]>;
  /** Known cost per file in seconds; with `budgetSeconds` it caps the runs of a slow file. */
  costs?: ReadonlyMap<string, number>;
  budgetSeconds?: number;
  now?: Date;
  /** Starts load for the stress variant and returns its stop function. Injectable for tests. */
  startLoad?: () => () => void;
}

export function median(values: readonly number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : Math.round(((sorted[middle - 1]! + sorted[middle]!) / 2) * 1000) / 1000;
}

/** One busy loop per CPU, so the test competes for every core. */
export function cpuLoad(): () => void {
  const burners = Array.from({ length: availableParallelism() }, () =>
    Bun.spawn([process.execPath, "-e", "for(;;){}"], { stdout: "ignore", stderr: "ignore", stdin: "ignore" }));
  return () => { for (const burner of burners) burner.kill("SIGKILL"); };
}

/** A run fails on a nonzero exit, and also when a case failed under an exit code that hid it. */
const failed = (run: RunOutput): boolean => run.exitCode !== 0 || run.cases.some(entry => entry.state === "failed");
/** A run that failed before collecting any case says nothing about the tests. */
const notCollected = (run: RunOutput): boolean => run.exitCode !== 0 && run.cases.length === 0;
const SETUP_ERROR_LINES = 20;
// Terminal colour codes from the runner, written as an escape so no raw control character sits in source.
const ANSI = /\u001b\[[0-9;]*m/g;
const tail = (output: string): string =>
  output.replace(ANSI, "").split("\n").map(line => line.trimEnd()).filter(Boolean).slice(-SETUP_ERROR_LINES).join("\n");

export function runsFor(requested: number, costSeconds: number | undefined, budgetSeconds: number | undefined): number {
  if (!costSeconds || !budgetSeconds) return requested;
  return Math.max(2, Math.min(requested, Math.floor(budgetSeconds / costSeconds)));
}

export async function measure(options: MeasureOptions): Promise<MeasureResult> {
  const files: FileMeasure[] = [];
  for (const file of options.files) {
    const projects = options.projects?.get(file);
    const runs = runsFor(options.runs, options.costs?.get(file), options.budgetSeconds);
    const variants: Record<string, RunOutput[]> = { repeat: [] };
    for (let index = 0; index < runs; index++) variants.repeat!.push(await options.runner({ files: [file], projects }));
    if (options.shuffle && !projects?.length) {
      variants.shuffle = [];
      for (let seed = 1; seed <= runs; seed++) variants.shuffle.push(await options.runner({ files: [file], seed }));
    }
    if (options.stress) {
      variants.stress = [];
      const stop = (options.startLoad ?? cpuLoad)();
      try { for (let index = 0; index < runs; index++) variants.stress.push(await options.runner({ files: [file], projects })); }
      finally { stop(); }
    }
    const all = Object.values(variants).flat();
    const failures = (name: string) => (variants[name] ?? []).filter(failed).length;
    const repeatFailures = failures("repeat");
    const uncollected = variants.repeat!.length > 0 && variants.repeat!.every(notCollected);
    const verdict: Verdict = uncollected ? "not-collected" : repeatFailures === runs ? "failing" : repeatFailures > 0 ? "flaky"
      : failures("shuffle") > 0 ? "order-dependent" : failures("stress") > 0 ? "load-sensitive" : "stable";
    const byCase = new Map<string, CaseResult[]>();
    for (const run of all) for (const entry of run.cases) byCase.set(entry.name, [...(byCase.get(entry.name) ?? []), entry]);
    const repeatCases = new Map<string, number[]>();
    for (const run of variants.repeat!) {
      for (const entry of run.cases) if (entry.ms !== null && entry.state === "passed") repeatCases.set(entry.name, [...(repeatCases.get(entry.name) ?? []), entry.ms]);
    }
    const walls = variants.repeat!.filter(run => !failed(run)).map(run => run.wallMs);
    files.push({
      file, runs: all.length, failures: all.filter(failed).length,
      medianMs: median(walls), minMs: walls.length ? Math.min(...walls) : null, maxMs: walls.length ? Math.max(...walls) : null,
      verdict,
      variants: Object.fromEntries(Object.entries(variants).map(([name, list]) => [name, { runs: list.length, failures: list.filter(failed).length }])),
      failingCases: [...byCase.entries()].map(([name, list]) => ({ name, failures: list.filter(entry => entry.state === "failed").length,
        message: list.find(entry => entry.state === "failed")?.message })).filter(entry => entry.failures > 0)
        .map(({ message, ...rest }) => message ? { ...rest, message } : rest),
      zeroAssertionCases: [...byCase.entries()].filter(([, list]) => list.every(entry => entry.state === "passed" && entry.assertions === 0)).map(([name]) => name).sort(),
      skippedCases: [...byCase.entries()].filter(([, list]) => list.every(entry => entry.state === "skipped")).map(([name]) => name).sort(),
      slowestCases: [...repeatCases.entries()].map(([name, list]) => ({ name, medianMs: median(list)! }))
        .sort((a, b) => b.medianMs - a.medianMs || (a.name < b.name ? -1 : 1)).slice(0, 8),
      cases: (variants.repeat!.find(run => !failed(run)) ?? variants.repeat![0])?.cases.map(entry => ({ name: entry.name, state: entry.state, assertions: entry.assertions })) ?? [],
      ...(uncollected ? { setupError: tail(variants.repeat!.at(-1)!.output) } : {}),
    });
  }

  let together: MeasureResult["together"] = null;
  if (options.together && options.files.length > 1) {
    const projects = [...new Set(options.files.flatMap(file => options.projects?.get(file) ?? []))];
    const outputs: RunOutput[] = [];
    for (let index = 0; index < Math.min(3, options.runs); index++) outputs.push(await options.runner({ files: options.files, projects: projects.length ? projects : undefined }));
    const failing = new Set(outputs.flatMap(run => run.cases.filter(entry => entry.state === "failed").map(entry => `${entry.file} > ${entry.name}`)));
    together = { runs: outputs.length, failures: outputs.filter(failed).length, failingCases: [...failing].sort() };
    // A file that is clean alone and fails in company is being leaked into.
    if (together.failures > 0) for (const entry of files) if (entry.verdict === "stable" && [...failing].some(name => name.startsWith(`${entry.file} > `))) entry.verdict = "leaks-between-files";
  }
  return { schemaVersion: 1, tool: "test-health measure", at: (options.now ?? new Date()).toISOString(), files, together };
}
