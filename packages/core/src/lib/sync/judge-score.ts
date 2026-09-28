/**
 * Scores a run of the sync judge against a labelled set (E2). Pure: it takes
 * what the judge answered and what the label says, and returns the numbers.
 *
 * Two kinds of number, kept apart because they answer different questions:
 *
 * - **Single-ask quality** — accuracy, per-label precision and recall, the
 *   confusion matrix and the calibration table — reads Jev's raw answer to one
 *   question (for a pair, the order A = ours), before any line is applied. It
 *   says how good the question is.
 * - **At the thresholds** — coverage, precision and harm among the decisions
 *   the judge would actually return — reads the gated decision, both orders
 *   and all. It says whether acting on the judge is safe, and it is what
 *   `scripts/measure-sync-judge.ts --min-precision` checks.
 */

import type { FileDecision, PairDecision } from "./types.js";

/** One item in one repeat of a run. */
export interface JudgeSample<L extends string = string> {
  id: string;
  /** The label the set gives it. */
  label: L;
  repeat: number;
  /** Jev's raw answer to one question; null when the item was not answered. */
  predicted: L | null;
  /** That answer's confidence; null when not answered. */
  confidence: number | null;
  /** The decision the judge returns after its gate; null when it returns none. */
  accepted: L | null;
  /** Pairs only: whether the two orders agreed; null when either was not answered. */
  orderAgreed?: boolean | null;
}

export interface ScoreOptions<L extends string> {
  /** Every label, in the order tables should list them. */
  labels: readonly L[];
  /** Whether acting on `accepted` when the truth is `label` loses content. Wrong but harmless otherwise. */
  harmful?: (accepted: L, label: L) => boolean;
  /** Wall time of each request, for the latency percentiles. */
  latenciesMs?: readonly number[];
}

export interface LabelScore {
  /** Items with this label. */
  support: number;
  /** Answered items predicted as this label. */
  predicted: number;
  /** Of those, correct; null when none were predicted. */
  precision: number | null;
  /** Of the answered items with this label, the share predicted as it; null when there are none. */
  recall: number | null;
}

export interface ThresholdScore {
  /** Decisions returned. */
  accepted: number;
  /** Of those, equal to the label. */
  correct: number;
  /** Decisions returned over all samples. */
  coverage: number;
  /** Correct over accepted; null when nothing was accepted. */
  precision: number | null;
  /** Accepted, wrong, and losing content by `harmful`. */
  harmful: number;
  perLabel: Record<string, { accepted: number; correct: number; precision: number | null }>;
}

export interface CalibrationBucket {
  /** Confidence in [lo, hi); the last bucket includes 1. */
  lo: number;
  hi: number;
  n: number;
  meanConfidence: number | null;
  /** Share of the bucket's answers equal to the label. */
  accuracy: number | null;
}

export interface JudgeScore {
  samples: number;
  answered: number;
  /** Correct answers over answered samples; null when none were answered. */
  accuracy: number | null;
  perLabel: Record<string, LabelScore>;
  /** `confusion[label][predicted]`, over answered samples. */
  confusion: Record<string, Record<string, number>>;
  atThreshold: ThresholdScore;
  calibration: CalibrationBucket[];
  /** Items answered in at least two repeats, and how many gave the same answer every time. */
  repeatAgreement: { items: number; unanimous: number; rate: number | null };
  /** Pairs only: samples with both orders answered, and how many agreed. Null for a set without orders. */
  orderConsistency: { compared: number; agreed: number; rate: number | null } | null;
  latency: { calls: number; p50: number | null; p95: number | null };
}

const ratio = (part: number, whole: number): number | null => (whole === 0 ? null : part / whole);

/** Nearest-rank percentile (`p` in 0–100) of `values`; null when there are none. */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1]!;
}

export function scoreJudge<L extends string>(samples: readonly JudgeSample<L>[], options: ScoreOptions<L>): JudgeScore {
  const { labels } = options;
  const answered = samples.filter((s) => s.predicted !== null);

  const confusion: Record<string, Record<string, number>> = {};
  for (const label of labels) {
    confusion[label] = {};
    for (const predicted of labels) confusion[label]![predicted] = 0;
  }
  let correct = 0;
  for (const s of answered) {
    const row = (confusion[s.label] ??= {});
    row[s.predicted!] = (row[s.predicted!] ?? 0) + 1;
    if (s.predicted === s.label) correct++;
  }

  const perLabel: Record<string, LabelScore> = {};
  for (const label of labels) {
    const support = samples.filter((s) => s.label === label).length;
    const answeredWithLabel = answered.filter((s) => s.label === label).length;
    const predicted = answered.filter((s) => s.predicted === label).length;
    const hit = confusion[label]![label] ?? 0;
    perLabel[label] = { support, predicted, precision: ratio(hit, predicted), recall: ratio(hit, answeredWithLabel) };
  }

  const acceptedSamples = samples.filter((s) => s.accepted !== null);
  const thresholdPerLabel: ThresholdScore["perLabel"] = {};
  for (const label of labels) {
    const mine = acceptedSamples.filter((s) => s.accepted === label);
    const mineCorrect = mine.filter((s) => s.label === label).length;
    thresholdPerLabel[label] = { accepted: mine.length, correct: mineCorrect, precision: ratio(mineCorrect, mine.length) };
  }
  const acceptedCorrect = acceptedSamples.filter((s) => s.accepted === s.label).length;
  const harmful = options.harmful
    ? acceptedSamples.filter((s) => s.accepted !== s.label && options.harmful!(s.accepted!, s.label)).length
    : 0;
  const atThreshold: ThresholdScore = {
    accepted: acceptedSamples.length,
    correct: acceptedCorrect,
    coverage: samples.length === 0 ? 0 : acceptedSamples.length / samples.length,
    precision: ratio(acceptedCorrect, acceptedSamples.length),
    harmful,
    perLabel: thresholdPerLabel,
  };

  const calibration: CalibrationBucket[] = [];
  for (let b = 0; b < 10; b++) {
    const lo = b / 10;
    const hi = (b + 1) / 10;
    const inBucket = answered.filter((s) => Math.min(9, Math.floor(s.confidence! * 10)) === b);
    const hits = inBucket.filter((s) => s.predicted === s.label).length;
    const sum = inBucket.reduce((total, s) => total + s.confidence!, 0);
    calibration.push({
      lo,
      hi,
      n: inBucket.length,
      meanConfidence: ratio(sum, inBucket.length),
      accuracy: ratio(hits, inBucket.length),
    });
  }

  const byItem = new Map<string, Set<string>>();
  const repeatsByItem = new Map<string, number>();
  for (const s of answered) {
    const answers = byItem.get(s.id) ?? new Set<string>();
    answers.add(s.predicted!);
    byItem.set(s.id, answers);
    repeatsByItem.set(s.id, (repeatsByItem.get(s.id) ?? 0) + 1);
  }
  let repeated = 0;
  let unanimous = 0;
  for (const [id, answers] of byItem) {
    if ((repeatsByItem.get(id) ?? 0) < 2) continue;
    repeated++;
    if (answers.size === 1) unanimous++;
  }

  const ordered = samples.filter((s) => s.orderAgreed !== undefined);
  const compared = ordered.filter((s) => s.orderAgreed !== null);
  const agreed = compared.filter((s) => s.orderAgreed === true).length;

  const latencies = options.latenciesMs ?? [];
  return {
    samples: samples.length,
    answered: answered.length,
    accuracy: ratio(correct, answered.length),
    perLabel,
    confusion,
    atThreshold,
    calibration,
    repeatAgreement: { items: repeated, unanimous, rate: ratio(unanimous, repeated) },
    orderConsistency:
      ordered.length === 0 ? null : { compared: compared.length, agreed, rate: ratio(agreed, compared.length) },
    latency: { calls: latencies.length, p50: percentile(latencies, 50), p95: percentile(latencies, 95) },
  };
}

/**
 * Whether a run's precision at the thresholds reaches `min`. A run that
 * returned no decision at all has no precision and does not pass: a gate that
 * passes because nothing was measured is not a gate.
 */
export function meetsMinPrecision(score: JudgeScore, min: number): boolean {
  return score.atThreshold.precision !== null && score.atThreshold.precision >= min;
}

/** J1 loses content when it calls a file the owner wants tracked an artifact: it stays out of the repository. */
export function fileHarm(accepted: FileDecision, label: FileDecision): boolean {
  return accepted === "artifact" && label === "track";
}

/**
 * Which side a pair decision keeps, as the merge renders it: same-fact and
 * ours-supersedes keep OURS, theirs-supersedes keeps THEIRS, distinct keeps
 * both.
 */
export function pairKeeps(decision: PairDecision): "ours" | "theirs" | "both" {
  switch (decision) {
    case "same-fact":
    case "ours-supersedes":
      return "ours";
    case "theirs-supersedes":
      return "theirs";
    case "distinct":
      return "both";
  }
}

/**
 * J2 loses content when the decision keeps one side and the truth needs the
 * other or both. When the truth is same-fact either side alone is enough, so
 * no single-side decision loses anything.
 */
export function pairHarm(accepted: PairDecision, label: PairDecision): boolean {
  const kept = pairKeeps(accepted);
  if (kept === "both" || label === "same-fact") return false;
  return kept !== pairKeeps(label);
}
