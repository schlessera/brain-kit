import { describe, expect, test } from "bun:test";

import { loadFileSet, loadPairSet, main, type FileCase, type PairCase } from "../../../scripts/measure-sync-judge";
import type { JevAnswers, JevChoiceQuestion, JevRequest } from "../src/lib/jev";
import type { JevLike } from "../src/lib/sync/judge";
import type { FileDecision, PairDecision } from "../src/lib/sync/types";

// `scripts/measure-sync-judge.ts` needs a key to measure anything real; these
// drive it with fake clients whose answers are known, so the numbers it
// prints and the exit code it returns can be checked keyless.

const files = loadFileSet();
const pairs = loadPairSet();

/** The same decision in the A/B terms of one order. */
function asOption(decision: PairDecision, aIsOurs: boolean): string {
  if (decision === "ours-supersedes") return aIsOurs ? "A-replaces-B" : "B-replaces-A";
  if (decision === "theirs-supersedes") return aIsOurs ? "B-replaces-A" : "A-replaces-B";
  return decision;
}

const WRONG_FILE: Record<FileDecision, FileDecision> = { artifact: "track", track: "artifact" };
const WRONG_PAIR: Record<PairDecision, PairDecision> = {
  "same-fact": "distinct",
  distinct: "same-fact",
  "ours-supersedes": "theirs-supersedes",
  "theirs-supersedes": "ours-supersedes",
};

/**
 * A fake Jev that looks each asked item up in the labelled sets and answers
 * `pick(label)` at confidence 0.95, consistently in both orders of a pair.
 */
function labelledJev(
  pickFile: (label: FileDecision) => FileDecision,
  pickPair: (label: PairDecision) => PairDecision
): JevLike & { requests: JevRequest[] } {
  const fileByPath = new Map<string, FileCase>(files.map((f) => [f.path, f]));
  const pairByTexts = new Map<string, PairCase>(pairs.map((p) => [`${p.ours}\u0000${p.theirs}`, p]));
  const requests: JevRequest[] = [];
  return {
    enabled: true,
    requests,
    async ask(request) {
      requests.push(request);
      const state = request.state as Record<string, Record<string, string>>;
      const answers: JevAnswers = {};
      for (const [id, question] of Object.entries(request.questions)) {
        const item = state[id.slice(0, id.lastIndexOf("."))]!;
        let choice: string;
        if ("head" in item) {
          choice = pickFile(fileByPath.get(item.path!)!.label);
        } else {
          const forward = pairByTexts.get(`${item.A}\u0000${item.B}`);
          const reverse = pairByTexts.get(`${item.B}\u0000${item.A}`);
          const aIsOurs = forward !== undefined;
          choice = asOption(pickPair((forward ?? reverse)!.label), aIsOurs);
        }
        const options = Object.keys((question as JevChoiceQuestion).criteria);
        const probabilities = Object.fromEntries(options.map((o) => [o, o === choice ? 0.95 : 0.05 / (options.length - 1)]));
        answers[id] = { type: "choice", choice, probabilities, confidence: 0.95 };
      }
      return { outcome: "answered", answers, durationMs: 100, model: "jev-fake" };
    },
  };
}

async function run(argv: string[], client?: JevLike, env: Record<string, string | undefined> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(argv, { client, env, out: (t) => out.push(t), err: (t) => err.push(t) });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

describe("measure-sync-judge", () => {
  test("without a key it says how to set one and exits 2", async () => {
    const { code, err } = await run(["--set", "files"], undefined, {});
    expect(code).toBe(2);
    expect(err).toContain("TYPESAFE_API_KEY");
  });

  test("a perfect fake scores 1.0 on both sets and passes --min-precision", async () => {
    const jev = labelledJev((l) => l, (l) => l);
    const { code, out } = await run(["--json", "--min-precision", "0.99"], jev);
    expect(code).toBe(0);
    const report = JSON.parse(out) as { results: { set: string; score: { samples: number; accuracy: number; atThreshold: { precision: number; coverage: number; harmful: number } }; skipped: number }[] };
    expect(report.results.map((r) => r.set)).toEqual(["files", "pairs"]);
    const [f, p] = report.results;
    expect(f!.score.samples).toBe(files.length);
    expect(p!.score.samples).toBe(pairs.length);
    for (const r of report.results) {
      expect(r.skipped).toBe(0);
      expect(r.score.accuracy).toBe(1);
      expect(r.score.atThreshold).toMatchObject({ precision: 1, coverage: 1, harmful: 0 });
    }
  });

  test("an always-wrong fake scores 0 and trips --min-precision", async () => {
    const jev = labelledJev((l) => WRONG_FILE[l], (l) => WRONG_PAIR[l]);
    const { code, out, err } = await run(["--json", "--min-precision", "0.5"], jev);
    expect(code).toBe(1);
    expect(err).toContain("files, pairs");
    const report = JSON.parse(out) as { failing: string[]; results: { score: { accuracy: number; atThreshold: { precision: number; harmful: number } } }[] };
    expect(report.failing).toEqual(["files", "pairs"]);
    for (const r of report.results) {
      expect(r.score.accuracy).toBe(0);
      expect(r.score.atThreshold.precision).toBe(0);
      expect(r.score.atThreshold.harmful).toBeGreaterThan(0);
    }
  });

  test("single-ask quality reads the A = ours order, and a fake that follows the position is never accepted", async () => {
    // "A replaces B" in both orders: ours-supersedes forward, theirs-supersedes reversed.
    const jev = labelledJev((l) => l, () => "ours-supersedes");
    const positional: JevLike = {
      enabled: true,
      async ask(request) {
        const result = await jev.ask(request);
        for (const answer of Object.values(result.answers ?? {})) {
          if (answer.type === "choice") answer.choice = "A-replaces-B";
        }
        return result;
      },
    };
    const { code, out } = await run(["--set", "pairs", "--json"], positional);
    expect(code).toBe(0);
    const { score } = (JSON.parse(out) as { results: { score: { accuracy: number; atThreshold: { accepted: number }; orderConsistency: { rate: number } } }[] }).results[0]!;
    const oursSupersedes = pairs.filter((p) => p.label === "ours-supersedes").length;
    expect(score.accuracy).toBeCloseTo(oursSupersedes / pairs.length, 10);
    expect(score.atThreshold.accepted).toBe(0);
    expect(score.orderConsistency.rate).toBe(0);
  });

  test("--repeat asks every item once per repeat and prints the tables", async () => {
    const jev = labelledJev((l) => l, (l) => l);
    const { code, out } = await run(["--set", "pairs", "--repeat", "2"], jev);
    expect(code).toBe(0);
    const asked = jev.requests.flatMap((r) => Object.keys(r.questions));
    expect(asked).toHaveLength(pairs.length * 2 * 2);
    expect(out).toContain("AT THRESHOLDS");
    expect(out).toContain(`repeat agreement 100.0% (${pairs.length}/${pairs.length} items)`);
    expect(out).toContain(`order consistency 100.0% (${pairs.length * 2}/${pairs.length * 2} pairs)`);
  });

  test("bad arguments exit 2 before anything is asked", async () => {
    const jev = labelledJev((l) => l, (l) => l);
    expect((await run(["--set", "both"], jev)).code).toBe(2);
    expect((await run(["--repeat", "0"], jev)).code).toBe(2);
    expect((await run(["--min-precision", "2"], jev)).code).toBe(2);
    expect(jev.requests).toHaveLength(0);
  });
});
