/** Explicit denominators; scripted rows never stand in for live quality. */
import type { SemanticCase } from "./workload";
export interface QualityRow {
  id: string; split: SemanticCase["split"]; arm: "current" | "deterministic" | "hybrid";
  repetition: number; conflict: SemanticCase["golden"]["conflict"]; retrieved: boolean;
  reported: boolean; abstained: boolean | null; failure: string | null; destructiveEffects: number;
  durationMs: number; calls: number; inputTokens: number | null; outputTokens: number | null;
  apiEquivalentUsd: number | null; additionalBilledUsd: number | null;
}
const ratio = (a: number, b: number) => b ? a / b : null;
/** Per golden label: a report on `yes` is correct, on `no` is a false positive, on `unknown` is unsupported. */
function byGolden(rows: QualityRow[]) {
  const out: Record<SemanticCase["golden"]["conflict"], { rows: number; reported: number; abstained: number }> = {
    yes: { rows: 0, reported: 0, abstained: 0 }, no: { rows: 0, reported: 0, abstained: 0 }, unknown: { rows: 0, reported: 0, abstained: 0 } };
  for (const r of rows) { const g = out[r.conflict]; g.rows++; if (r.reported) g.reported++; if (r.abstained === true) g.abstained++; }
  return out;
}
/** Fraction of (case, arm) groups whose repetitions all agree on `reported`; null without any repeated case. */
export function agreement(rows: QualityRow[]) {
  const groups = new Map<string, boolean[]>();
  for (const r of rows) if (r.failure === null) { const key = `${r.arm}:${r.id}`; groups.set(key, [...(groups.get(key) ?? []), r.reported]); }
  const repeated = [...groups.values()].filter(g => g.length > 1);
  return { groups: groups.size, repeatedGroups: repeated.length, consistent: ratio(repeated.filter(g => g.every(v => v === g[0])).length, repeated.length) };
}
export function quality(rows: QualityRow[]) {
  const complete = rows.filter(r => r.failure === null), positive = complete.filter(r => r.conflict === "yes"), negative = complete.filter(r => r.conflict !== "yes");
  const truePositive = positive.filter(r => r.reported).length, falsePositive = negative.filter(r => r.reported).length;
  const retrievedPositive = positive.filter(r => r.retrieved);
  return { observations: rows.length, complete: complete.length, failures: rows.length - complete.length,
    semanticPositives: positive.length, retrievedPositives: retrievedPositive.length,
    truePositive, falsePositive, falseNegative: positive.length - truePositive,
    retrievalRecall: ratio(retrievedPositive.length, positive.length),
    precision: ratio(truePositive, truePositive + falsePositive), recall: ratio(truePositive, positive.length),
    // Recall among candidates the grammar actually retrieved: the judgment's own ceiling, separate from retrieval.
    judgmentRecall: ratio(retrievedPositive.filter(r => r.reported).length, retrievedPositive.length),
    abstention: ratio(complete.filter(r => r.abstained === true).length, complete.filter(r => r.abstained !== null).length),
    abstentionUnknown: complete.filter(r => r.abstained === null).length,
    byGolden: byGolden(complete), agreement: agreement(rows),
    destructiveEffects: rows.reduce((n, r) => n + r.destructiveEffects, 0),
    completeComparison: rows.length > 0 && rows.every(r => !r.failure),
    caveat: "Unknown labels remain separate abstention cases and count as unsupported positive emissions; small correlated repetitions do not establish population safety." };
}
export function chooseThreshold(rows: Array<{ split: SemanticCase["split"]; threshold: number; conflict: SemanticCase["golden"]["conflict"]; reported: boolean; failure: string | null }>) {
  if (rows.some(r => r.split !== "tuning")) throw Error("Held-out data cannot tune admission");
  for (const threshold of [0.7, 0.8, 0.9, 0.95, 1]) {
    const selected = rows.filter(r => r.threshold === threshold);
    if (selected.length && selected.every(r => !r.failure) && selected.some(r => r.reported && r.conflict === "yes") && selected.every(r => !r.reported || r.conflict === "yes")) return threshold;
  }
  return null;
}
export function percentile(values: number[], p: number) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b); return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)]!;
}
