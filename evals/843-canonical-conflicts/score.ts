export type Label = "yes" | "no" | "unknown";
export interface Row { id: string; arm: string; split: string; rep: number; gold: Label;
  label: Label; invalid?: boolean; wrongTarget?: boolean; changedFiles?: string[] }
/** Unknown is a third class; reporting it as a conflict is a veto, never a true positive. */
export function metrics(rows: Row[]) {
  const tp = rows.filter(r => r.gold === "yes" && r.label === "yes" && !r.invalid && !r.wrongTarget).length;
  const fp = rows.filter(r => r.label === "yes" && (r.gold !== "yes" || r.invalid || r.wrongTarget)).length;
  const positives = rows.filter(r => r.gold === "yes").length;
  const byCase = Map.groupBy(rows, r => r.id);
  const agreeing = [...byCase.values()].filter(rs => rs.length === 3 && new Set(rs.map(r => `${r.label}:${!!r.invalid}:${!!r.wrongTarget}`)).size === 1).length;
  return { n: rows.length, correct: rows.filter(r => r.label === r.gold && !r.invalid && !r.wrongTarget).length,
    tp, fp, positives, precision: tp + fp ? tp / (tp + fp) : null, recall: positives ? tp / positives : null,
    vetoes: rows.filter(r => (r.label === "yes" && (r.gold !== "yes" || r.invalid || r.wrongTarget)) || r.changedFiles?.length).length,
    agreement: { cases: byCase.size, agreeing }, invalid: rows.filter(r => r.invalid).length,
    abstentions: rows.filter(r => r.label === "unknown").length,
    unknown: { n: rows.filter(r => r.gold === "unknown").length, correct: rows.filter(r => r.gold === "unknown" && r.label === "unknown" && !r.invalid).length },
    wrongTargets: rows.filter(r => r.wrongTarget).length, contentWrites: rows.filter(r => r.changedFiles?.length).length };
}
