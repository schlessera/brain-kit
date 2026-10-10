import type { PairCase } from "./fixtures";
export interface Row {
  id: string; split: PairCase["split"]; same: boolean | null; arm: "lexical" | "current" | "hybrid";
  repetition: number; retrieved: boolean; proposed: boolean; abstained: boolean | null;
  failure: string | null; durationMs: number; modelQuality: boolean;
}
const ratio = (a: number, b: number) => b ? a / b : null;
interface Case { id: string; same: boolean | null; retrieved: boolean; proposed: boolean; unstable: boolean; abstained: boolean | null; failed: boolean }
/** One record per pair: repetitions vote, and disagreement is reported rather than counted three times. */
export function perCase(rows: Row[]): Case[] {
  const groups = new Map<string, Row[]>();
  for (const row of rows) groups.set(row.id, [...(groups.get(row.id) ?? []), row]);
  return [...groups.entries()].map(([id, group]) => {
    const complete = group.filter(r => !r.failure), proposals = complete.filter(r => r.proposed).length;
    const abstentions = complete.filter(r => r.abstained !== null);
    return { id, same: group[0].same, retrieved: complete.some(r => r.retrieved), proposed: proposals * 2 > complete.length,
      unstable: proposals > 0 && proposals < complete.length, failed: complete.length === 0,
      abstained: abstentions.length ? abstentions.filter(r => r.abstained).length * 2 > abstentions.length : null };
  });
}
export function metrics(rows: Row[]) {
  const cases = perCase(rows), complete = cases.filter(c => !c.failed), positives = complete.filter(c => c.same === true);
  const tp = positives.filter(c => c.proposed), fp = complete.filter(c => c.same !== true && c.proposed);
  return { observations: rows.length, cases: cases.length, complete: complete.length, failedCases: cases.length - complete.length,
    positives: positives.length, retrievedPositives: positives.filter(c => c.retrieved).length,
    candidateRecall: ratio(positives.filter(c => c.retrieved).length, positives.length),
    missedPositives: positives.filter(c => !c.retrieved).map(c => c.id),
    trueProposals: tp.length, falseMerges: fp.length, falseMergeIds: fp.map(c => c.id),
    precision: ratio(tp.length, tp.length + fp.length), recall: ratio(tp.length, positives.length),
    unstableCases: complete.filter(c => c.unstable).map(c => c.id),
    abstention: ratio(complete.filter(c => c.abstained === true).length, complete.filter(c => c.abstained !== null).length),
    explicitAbstentionUnknown: complete.filter(c => c.abstained === null).length,
    measuredModelQuality: rows.length > 0 && rows.every(r => r.modelQuality),
    limitation: "Failures and retrieval misses remain distinct. Author labels are unreviewed; repetitions of one pair are correlated, so a majority vote is not a population estimate." };
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
