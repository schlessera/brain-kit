/**
 * Time `brain sync run` over the E3 states it meets most: (a) nothing to do,
 * (b) local edits only, (c) two clones editing different files, (d) two
 * clones editing the same note. Manual, not in CI: every repetition builds a
 * fresh brain and bare remote and spawns the real CLI, keyless (the judge is
 * off, post-sync reindexes without embeddings).
 *
 *   bun scripts/measure-sync-run.ts                # 5 repetitions of each
 *   bun scripts/measure-sync-run.ts --repeat 20
 *   bun scripts/measure-sync-run.ts --json         # every sample, as JSON
 *
 * Prints per scenario the wall time of the whole CLI call (process start
 * included) at p50 and p95, and the p50 of each step as `run` timed it.
 * Exits 1 when a scenario did not end `complete`.
 */

import {
  brainWithRemote,
  cleanupFixtures,
  SCENARIO_SETUPS,
  syncJson,
} from "../packages/core/tests/sync-fixture.ts";
import type { RunEnvelope } from "../packages/core/src/lib/sync/run.ts";

const SCENARIOS = {
  "a nothing": SCENARIO_SETUPS.nothing,
  "b local only": SCENARIO_SETUPS.localOnly,
  "c different files": SCENARIO_SETUPS.differentFiles,
  "d same note": SCENARIO_SETUPS.sameNote,
} as const;

const STEPS = ["stash", "assess", "commit", "pull", "resolve", "conclude", "push", "postSync"] as const;

interface Sample {
  scenario: string;
  status: string;
  wallMs: number;
  timings: RunEnvelope["timings"];
}

function parseArgs(argv: string[]): { repeat: number; json: boolean } {
  let repeat = 5;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--json") json = true;
    else if (arg === "--repeat") repeat = Number(argv[++i]);
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!Number.isInteger(repeat) || repeat < 1) throw new Error("--repeat takes a positive integer");
  return { repeat, json };
}

/** Nearest-rank percentile of `values` (0 < p <= 100). */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)]!;
}

async function measure(repeat: number): Promise<Sample[]> {
  const samples: Sample[] = [];
  for (let i = 0; i < repeat; i++) {
    for (const [scenario, setup] of Object.entries(SCENARIOS)) {
      const brain = brainWithRemote();
      setup(brain);
      const start = performance.now();
      const { body } = await syncJson(brain.root, "run");
      const wallMs = performance.now() - start;
      samples.push({ scenario, status: body?.status ?? "no-json", wallMs, timings: body?.timings ?? {} });
      cleanupFixtures();
    }
  }
  return samples;
}

function table(samples: Sample[]): string {
  const ms = (n: number) => (Number.isNaN(n) ? "-" : n.toFixed(0));
  const header = ["scenario", "n", "p50", "p95", ...STEPS.map((s) => `${s} p50`)];
  const rows = Object.keys(SCENARIOS).map((scenario) => {
    const own = samples.filter((s) => s.scenario === scenario);
    const walls = own.map((s) => s.wallMs);
    return [
      scenario,
      String(own.length),
      ms(percentile(walls, 50)),
      ms(percentile(walls, 95)),
      ...STEPS.map((step) => ms(percentile(own.map((s) => s.timings[step] ?? 0), 50))),
    ];
  });
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  const line = (cells: string[]) => cells.map((c, i) => (i === 0 ? c.padEnd(widths[i]!) : c.padStart(widths[i]!))).join("  ");
  return [line(header), ...rows.map(line)].join("\n");
}

if (import.meta.main) {
  const { repeat, json } = parseArgs(process.argv.slice(2));
  const samples = await measure(repeat);
  if (json) console.log(JSON.stringify({ repeat, samples }, null, 2));
  else console.log(`brain sync run, ${repeat} repetition(s) per scenario (ms)\n\n${table(samples)}`);
  const failed = samples.filter((s) => s.status !== "complete");
  if (failed.length > 0) {
    console.error(`${failed.length} run(s) did not complete: ${failed.map((s) => `${s.scenario}=${s.status}`).join(", ")}`);
    process.exit(1);
  }
}
