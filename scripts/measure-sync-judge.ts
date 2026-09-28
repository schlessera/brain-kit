// Measures the two judgments `brain sync` asks Jev for (E2) against the
// labelled sets in `packages/core/fixtures/sync-judge/`:
//
// - `files.jsonl` — J1: is an unclassified file an artifact or content to track?
// - `pairs.jsonl` — J2: how do two edits of one passage relate?
//
// It asks exactly what a sync asks — the same questions, batching and gates,
// from `packages/core/src/lib/sync/judge.ts` — and scores the answers with
// `packages/core/src/lib/sync/judge-score.ts`. The number that decides whether
// acting on the judge is safe is precision AT the thresholds: of the decisions
// the judge would return, how many are right, and how many of the wrong ones
// lose content.
//
// Why a script and not a test: there is no keyless stand-in for what Jev
// answers. CI never runs this; the tests drive it with a fake client.
//
//   bun scripts/measure-sync-judge.ts [--set files|pairs|all] [--repeat N] \
//     [--json] [--min-precision X]
//
// `--json` prints the full score as JSON instead of the tables.
// `--min-precision X` exits 1 when any measured set's precision at the
// thresholds is below X, or when it returned no decision at all.
// Without `TYPESAFE_API_KEY` it says how to set one and exits 2.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { createJevClient } from "../packages/core/src/lib/jev.ts";
import {
  observeFiles,
  observePairs,
  SYNC_JUDGE_THRESHOLDS,
  type JevLike,
} from "../packages/core/src/lib/sync/judge.ts";
import {
  fileHarm,
  meetsMinPrecision,
  pairHarm,
  scoreJudge,
  type JudgeSample,
  type JudgeScore,
} from "../packages/core/src/lib/sync/judge-score.ts";
import {
  FILE_DECISIONS,
  PAIR_DECISIONS,
  type FileDecision,
  type JudgmentPair,
  type PairDecision,
  type UnknownFile,
} from "../packages/core/src/lib/sync/types.ts";

export const FIXTURE_DIR = resolve(import.meta.dir, "../packages/core/fixtures/sync-judge");

export interface FileCase {
  id: string;
  path: string;
  head: string;
  label: FileDecision;
}

export interface PairCase {
  id: string;
  path: string;
  context: string;
  ours: string;
  theirs: string;
  label: PairDecision;
}

function readJsonl(path: string): unknown[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line, index) => {
      try {
        return JSON.parse(line) as unknown;
      } catch {
        throw new Error(`${path}:${index + 1} is not JSON`);
      }
    });
}

const isText = (value: unknown): value is string => typeof value === "string" && value.length > 0;

export function loadFileSet(path = resolve(FIXTURE_DIR, "files.jsonl")): FileCase[] {
  return readJsonl(path).map((raw, index) => {
    const row = raw as Partial<FileCase>;
    if (!isText(row.id) || !isText(row.path) || !isText(row.head) || !FILE_DECISIONS.includes(row.label as FileDecision)) {
      throw new Error(`${path}:${index + 1} is not { id, path, head, label }`);
    }
    return { id: row.id, path: row.path, head: row.head, label: row.label as FileDecision };
  });
}

export function loadPairSet(path = resolve(FIXTURE_DIR, "pairs.jsonl")): PairCase[] {
  return readJsonl(path).map((raw, index) => {
    const row = raw as Partial<PairCase>;
    if (
      !isText(row.id) ||
      !isText(row.path) ||
      !isText(row.context) ||
      !isText(row.ours) ||
      !isText(row.theirs) ||
      !PAIR_DECISIONS.includes(row.label as PairDecision)
    ) {
      throw new Error(`${path}:${index + 1} is not { id, path, context, ours, theirs, label }`);
    }
    return {
      id: row.id,
      path: row.path,
      context: row.context,
      ours: row.ours,
      theirs: row.theirs,
      label: row.label as PairDecision,
    };
  });
}

export type SetName = "files" | "pairs";

export interface SetResult {
  set: SetName;
  repeats: number;
  score: JudgeScore;
  /** Requests by outcome, over every repeat. */
  outcomes: Record<string, number>;
  /** Items never asked (binary head, too large), per repeat. */
  skipped: number;
  /** The versioned models that answered. */
  models: string[];
  thresholds: typeof SYNC_JUDGE_THRESHOLDS;
}

function tallyCalls(calls: { outcome: string; durationMs: number; model?: string }[], into: SetResult["outcomes"], models: Set<string>, latencies: number[]): void {
  for (const call of calls) {
    into[call.outcome] = (into[call.outcome] ?? 0) + 1;
    latencies.push(call.durationMs);
    if (call.model) models.add(call.model);
  }
}

export async function measureFiles(client: JevLike, cases: readonly FileCase[], repeats: number): Promise<SetResult> {
  const files: UnknownFile[] = cases.map((c) => ({ id: c.id, path: c.path, head: c.head, bytes: Buffer.byteLength(c.head) }));
  const labels = new Map(cases.map((c) => [c.id, c.label]));
  const samples: JudgeSample<FileDecision>[] = [];
  const outcomes: Record<string, number> = {};
  const models = new Set<string>();
  const latencies: number[] = [];
  let skipped = 0;
  for (let repeat = 0; repeat < repeats; repeat++) {
    const { observations, calls } = await observeFiles(client, files);
    tallyCalls(calls, outcomes, models, latencies);
    for (const o of observations) {
      if (o.skipped) skipped++;
      samples.push({
        id: o.id,
        label: labels.get(o.id)!,
        repeat,
        predicted: o.answer?.choice ?? null,
        confidence: o.answer?.confidence ?? null,
        accepted: o.decision?.decision ?? null,
      });
    }
  }
  const score = scoreJudge(samples, { labels: FILE_DECISIONS, harmful: fileHarm, latenciesMs: latencies });
  return { set: "files", repeats, score, outcomes, skipped: skipped / Math.max(1, repeats), models: [...models].sort(), thresholds: SYNC_JUDGE_THRESHOLDS };
}

export async function measurePairs(client: JevLike, cases: readonly PairCase[], repeats: number): Promise<SetResult> {
  const pairs: JudgmentPair[] = cases.map((c) => ({ id: c.id, path: c.path, context: c.context, ours: c.ours, theirs: c.theirs }));
  const labels = new Map(cases.map((c) => [c.id, c.label]));
  const samples: JudgeSample<PairDecision>[] = [];
  const outcomes: Record<string, number> = {};
  const models = new Set<string>();
  const latencies: number[] = [];
  let skipped = 0;
  for (let repeat = 0; repeat < repeats; repeat++) {
    const { observations, calls } = await observePairs(client, pairs);
    tallyCalls(calls, outcomes, models, latencies);
    for (const o of observations) {
      if (o.skipped) skipped++;
      // Single-ask quality reads the A = ours order; the gate reads both.
      samples.push({
        id: o.id,
        label: labels.get(o.id)!,
        repeat,
        predicted: o.forward?.choice ?? null,
        confidence: o.forward?.confidence ?? null,
        accepted: o.decision?.decision ?? null,
        orderAgreed: o.agreed,
      });
    }
  }
  const score = scoreJudge(samples, { labels: PAIR_DECISIONS, harmful: pairHarm, latenciesMs: latencies });
  return { set: "pairs", repeats, score, outcomes, skipped: skipped / Math.max(1, repeats), models: [...models].sort(), thresholds: SYNC_JUDGE_THRESHOLDS };
}

// ---------------------------------------------------------------------------
// Printing
// ---------------------------------------------------------------------------

const pct = (value: number | null): string => (value === null ? "   -" : `${(value * 100).toFixed(1).padStart(5)}%`);
const ms = (value: number | null): string => (value === null ? "-" : `${Math.round(value)} ms`);

export function renderSet(result: SetResult): string {
  const { score } = result;
  const labels = Object.keys(score.perLabel);
  const width = Math.max(...labels.map((l) => l.length), 10);
  const lines: string[] = [];
  lines.push(`== ${result.set} (${score.samples} samples over ${result.repeats} repeat(s); models: ${result.models.join(", ") || "none"})`);
  lines.push(`requests: ${Object.entries(result.outcomes).map(([k, v]) => `${k} ${v}`).join(", ") || "none"}; skipped items per repeat: ${result.skipped}`);
  lines.push(`answered ${score.answered}/${score.samples}; single-ask accuracy ${pct(score.accuracy)}`);
  lines.push("");
  lines.push(`${"label".padEnd(width)}  support  precision  recall`);
  for (const label of labels) {
    const s = score.perLabel[label]!;
    lines.push(`${label.padEnd(width)}  ${String(s.support).padStart(7)}  ${pct(s.precision).padStart(9)}  ${pct(s.recall).padStart(6)}`);
  }
  lines.push("");
  lines.push(`confusion (row = label, column = answer): ${labels.join(" | ")}`);
  for (const label of labels) {
    lines.push(`${label.padEnd(width)}  ${labels.map((p) => String(score.confusion[label]?.[p] ?? 0).padStart(4)).join(" ")}`);
  }
  lines.push("");
  const t = score.atThreshold;
  lines.push(`AT THRESHOLDS ${JSON.stringify(result.thresholds)}`);
  lines.push(`  coverage ${pct(t.coverage)}  precision ${pct(t.precision)}  accepted ${t.accepted}  correct ${t.correct}  harmful ${t.harmful}`);
  for (const label of labels) {
    const s = t.perLabel[label]!;
    lines.push(`  ${label.padEnd(width)}  accepted ${String(s.accepted).padStart(4)}  precision ${pct(s.precision)}`);
  }
  lines.push("");
  lines.push("calibration (single ask): bucket  n  mean confidence  accuracy");
  for (const b of score.calibration) {
    if (b.n === 0) continue;
    lines.push(`  ${b.lo.toFixed(1)}-${b.hi.toFixed(1)}  ${String(b.n).padStart(4)}  ${pct(b.meanConfidence)}  ${pct(b.accuracy)}`);
  }
  lines.push("");
  lines.push(`repeat agreement ${pct(score.repeatAgreement.rate)} (${score.repeatAgreement.unanimous}/${score.repeatAgreement.items} items)`);
  if (score.orderConsistency) {
    lines.push(`order consistency ${pct(score.orderConsistency.rate)} (${score.orderConsistency.agreed}/${score.orderConsistency.compared} pairs)`);
  }
  lines.push(`latency p50 ${ms(score.latency.p50)}  p95 ${ms(score.latency.p95)} over ${score.latency.calls} request(s)`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export interface MainDeps {
  env?: Record<string, string | undefined>;
  /** Injected transport; the real client for `TYPESAFE_API_KEY` otherwise. */
  client?: JevLike;
  out?: (text: string) => void;
  err?: (text: string) => void;
  files?: readonly FileCase[];
  pairs?: readonly PairCase[];
}

function flag(argv: readonly string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

/** Exit code: 0 measured, 1 below `--min-precision`, 2 no key or bad arguments. */
export async function main(argv: readonly string[], deps: MainDeps = {}): Promise<number> {
  const out = deps.out ?? ((text: string) => console.log(text));
  const err = deps.err ?? ((text: string) => console.error(text));
  const env = deps.env ?? process.env;

  const set = flag(argv, "set") ?? "all";
  if (set !== "files" && set !== "pairs" && set !== "all") {
    err(`--set must be files, pairs or all, not ${set}`);
    return 2;
  }
  const repeatRaw = flag(argv, "repeat") ?? "1";
  const repeats = Number(repeatRaw);
  if (!Number.isInteger(repeats) || repeats < 1) {
    err(`--repeat must be a positive integer, not ${repeatRaw}`);
    return 2;
  }
  const minRaw = flag(argv, "min-precision");
  const minPrecision = minRaw === undefined ? null : Number(minRaw);
  if (minPrecision !== null && !(Number.isFinite(minPrecision) && minPrecision >= 0 && minPrecision <= 1)) {
    err(`--min-precision must be a number from 0 to 1, not ${minRaw}`);
    return 2;
  }

  let client = deps.client;
  if (!client) {
    const apiKey = env.TYPESAFE_API_KEY?.trim();
    if (!apiKey) {
      err(
        "TYPESAFE_API_KEY is not set. The measurement asks Jev live and has no keyless mode.\n" +
          "Set it for this run: TYPESAFE_API_KEY=<key> bun scripts/measure-sync-judge.ts [--set files|pairs|all]"
      );
      return 2;
    }
    client = createJevClient({ apiKey });
  }

  const results: SetResult[] = [];
  if (set !== "pairs") results.push(await measureFiles(client, deps.files ?? loadFileSet(), repeats));
  if (set !== "files") results.push(await measurePairs(client, deps.pairs ?? loadPairSet(), repeats));

  const failing = minPrecision === null ? [] : results.filter((r) => !meetsMinPrecision(r.score, minPrecision)).map((r) => r.set);

  if (argv.includes("--json")) {
    out(JSON.stringify({ minPrecision, failing, results }, null, 2));
  } else {
    out(results.map(renderSet).join("\n\n"));
  }
  if (failing.length > 0) {
    err(`precision at the thresholds is below ${minPrecision} (or nothing was decided) for: ${failing.join(", ")}`);
    return 1;
  }
  return 0;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
