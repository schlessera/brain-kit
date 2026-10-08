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
export function quality(rows: QualityRow[]) {
  const complete = rows.filter(r => r.failure === null), positive = complete.filter(r => r.conflict === "yes"), negative = complete.filter(r => r.conflict !== "yes");
  const truePositive = positive.filter(r => r.reported).length, falsePositive = negative.filter(r => r.reported).length;
  return { observations: rows.length, complete: complete.length, failures: rows.length - complete.length,
    semanticPositives: positive.length, retrievedPositives: positive.filter(r => r.retrieved).length,
    truePositive, falsePositive, falseNegative: positive.length - truePositive,
    retrievalRecall: ratio(positive.filter(r => r.retrieved).length, positive.length),
    precision: ratio(truePositive, truePositive + falsePositive), recall: ratio(truePositive, positive.length),
    abstention: ratio(complete.filter(r => r.abstained === true).length, complete.filter(r => r.abstained !== null).length),
    abstentionUnknown: complete.filter(r => r.abstained === null).length,
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
