import { describe, expect, test } from "bun:test";

import {
  fileHarm,
  meetsMinPrecision,
  pairHarm,
  percentile,
  scoreJudge,
  type JudgeSample,
} from "../src/lib/sync/judge-score";

type L = "a" | "b";
const LABELS = ["a", "b"] as const;

const sample = (id: string, label: L, predicted: L | null, confidence: number | null, accepted: L | null, repeat = 0): JudgeSample<L> => ({
  id,
  label,
  repeat,
  predicted,
  confidence,
  accepted,
});

describe("scoreJudge", () => {
  test("a known mixed run yields the hand-computed numbers", () => {
    const samples = [
      sample("1", "a", "a", 0.95, "a"),
      sample("2", "a", "b", 0.85, "b"),
      sample("3", "b", "b", 0.55, null),
      sample("4", "b", null, null, null),
    ];
    const score = scoreJudge(samples, {
      labels: LABELS,
      harmful: (accepted, label) => accepted === "b" && label === "a",
      latenciesMs: [300, 100, 400, 200],
    });
    expect(score.samples).toBe(4);
    expect(score.answered).toBe(3);
    expect(score.accuracy).toBeCloseTo(2 / 3, 10);
    expect(score.perLabel.a).toEqual({ support: 2, predicted: 1, precision: 1, recall: 0.5 });
    expect(score.perLabel.b).toEqual({ support: 2, predicted: 2, precision: 0.5, recall: 1 });
    expect(score.confusion).toEqual({ a: { a: 1, b: 1 }, b: { a: 0, b: 1 } });
    expect(score.atThreshold).toMatchObject({ accepted: 2, correct: 1, coverage: 0.5, precision: 0.5, harmful: 1 });
    expect(score.atThreshold.perLabel).toEqual({
      a: { accepted: 1, correct: 1, precision: 1 },
      b: { accepted: 1, correct: 0, precision: 0 },
    });
    const filled = score.calibration.filter((b) => b.n > 0).map((b) => [b.lo, b.n, b.meanConfidence, b.accuracy]);
    expect(filled).toEqual([
      [0.5, 1, 0.55, 1],
      [0.8, 1, 0.85, 0],
      [0.9, 1, 0.95, 1],
    ]);
    expect(score.calibration).toHaveLength(10);
    expect(score.repeatAgreement).toEqual({ items: 0, unanimous: 0, rate: null });
    expect(score.orderConsistency).toBeNull();
    expect(score.latency).toEqual({ calls: 4, p50: 200, p95: 400 });
  });

  test("a confidence of exactly 1 lands in the last bucket", () => {
    const score = scoreJudge([sample("1", "a", "a", 1, "a")], { labels: LABELS });
    expect(score.calibration[9]!.n).toBe(1);
  });

  test("a perfect run scores 1.0", () => {
    const samples = [sample("1", "a", "a", 0.9, "a"), sample("2", "b", "b", 0.9, "b")];
    const score = scoreJudge(samples, { labels: LABELS });
    expect(score.accuracy).toBe(1);
    expect(score.atThreshold.precision).toBe(1);
    expect(score.atThreshold.coverage).toBe(1);
    expect(meetsMinPrecision(score, 0.99)).toBe(true);
  });

  test("an always-wrong run scores 0 and fails any positive minimum", () => {
    const samples = [sample("1", "a", "b", 0.9, "b"), sample("2", "b", "a", 0.9, "a")];
    const score = scoreJudge(samples, { labels: LABELS });
    expect(score.accuracy).toBe(0);
    expect(score.atThreshold.precision).toBe(0);
    expect(meetsMinPrecision(score, 0.01)).toBe(false);
  });

  test("a run that decided nothing does not pass the minimum", () => {
    const score = scoreJudge([sample("1", "a", "a", 0.3, null)], { labels: LABELS });
    expect(score.atThreshold.precision).toBeNull();
    expect(meetsMinPrecision(score, 0)).toBe(false);
  });

  test("repeat agreement and order consistency", () => {
    const samples: JudgeSample<L>[] = [
      { ...sample("1", "a", "a", 0.9, "a", 0), orderAgreed: true },
      { ...sample("1", "a", "a", 0.9, "a", 1), orderAgreed: true },
      { ...sample("2", "b", "b", 0.9, null, 0), orderAgreed: false },
      { ...sample("2", "b", "a", 0.9, null, 1), orderAgreed: null },
    ];
    const score = scoreJudge(samples, { labels: LABELS });
    expect(score.repeatAgreement).toEqual({ items: 2, unanimous: 1, rate: 0.5 });
    expect(score.orderConsistency).toEqual({ compared: 3, agreed: 2, rate: 2 / 3 });
  });
});

describe("percentile", () => {
  test("nearest rank", () => {
    expect(percentile([], 50)).toBeNull();
    expect(percentile([5], 95)).toBe(5);
    expect(percentile(Array.from({ length: 20 }, (_, i) => i + 1), 95)).toBe(19);
  });
});

describe("harm", () => {
  test("J1 loses content only when a tracked file is called an artifact", () => {
    expect(fileHarm("artifact", "track")).toBe(true);
    expect(fileHarm("track", "artifact")).toBe(false);
  });

  test("J2 loses content when it keeps one side and the truth needs the other or both", () => {
    expect(pairHarm("same-fact", "distinct")).toBe(true);
    expect(pairHarm("ours-supersedes", "theirs-supersedes")).toBe(true);
    expect(pairHarm("theirs-supersedes", "same-fact")).toBe(false);
    expect(pairHarm("distinct", "same-fact")).toBe(false);
    expect(pairHarm("same-fact", "ours-supersedes")).toBe(false);
  });
});
