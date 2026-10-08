import type { PairCase } from "./fixtures";
export interface Row {
  id: string; split: PairCase["split"]; same: boolean | null; arm: "lexical" | "current" | "hybrid";
  repetition: number; retrieved: boolean; proposed: boolean; abstained: boolean | null;
  failure: string | null; durationMs: number; modelQuality: boolean;
}
const ratio = (a: number, b: number) => b ? a / b : null;
export function metrics(rows: Row[]) {
  const complete = rows.filter(r => !r.failure), positives = complete.filter(r => r.same === true);
  const tp = positives.filter(r => r.proposed).length, fp = complete.filter(r => r.same !== true && r.proposed).length;
  return { observations: rows.length, complete: complete.length, failures: rows.length - complete.length,
    positives: positives.length, retrievedPositives: positives.filter(r => r.retrieved).length,
    candidateRecall: ratio(positives.filter(r => r.retrieved).length, positives.length),
    trueProposals: tp, falseMerges: fp, precision: ratio(tp, tp + fp), recall: ratio(tp, positives.length),
    retrievedCases: complete.filter(r => r.retrieved).length, omittedCases: complete.filter(r => !r.retrieved).length,
    abstention: ratio(complete.filter(r => r.abstained === true).length, complete.filter(r => r.abstained !== null).length),
    explicitAbstentionUnknown: complete.filter(r => r.abstained === null).length,
    measuredModelQuality: rows.length > 0 && rows.every(r => r.modelQuality),
    limitation: "Failures and retrieval misses remain distinct. Author labels are unreviewed; correlated repetitions supply no population guarantee." };
}
export function calibrate(rows: Array<Row & { threshold: number }>, expectedIds: string[]) {
  if (rows.some(r => r.split !== "tuning")) throw Error("Held-out labels cannot tune thresholds");
  for (const threshold of [.7, .8, .9, .95, 1]) {
    const selected = rows.filter(r => r.threshold === threshold);
    if (!selected.length || expectedIds.some(id => !selected.some(r => r.id === id))) continue;
    if (selected.every(r => !r.failure) && selected.some(r => r.same === true && r.proposed) &&
      selected.every(r => !r.proposed || r.same === true)) return threshold;
  }
  return null;
}
