/** Author-label grading only; origin must be retained alongside any aggregate. */
import type { BenchmarkCase } from "./benchmark";
import { semanticRanking, type SemanticAssessment } from "./semantic";
export function grade(cases: BenchmarkCase[], rows: SemanticAssessment[], origin: "scripted-control" | "reviewed-live") {
  if (new Set(cases.map(c => c.id)).size !== cases.length || rows.length !== cases.length || new Set(rows.map(r => r.id)).size !== rows.length || rows.some(r => !cases.some(c => c.id === r.id))) throw Error("Complete unique grading denominator required");
  const confusion: Record<string, Record<string, number>> = { passage: {}, relocation: {} };
  let criticalDealbreakerMisses = 0, unknownSalaryCandidates = 0, literalFalseExclusions = 0, sourceMissing = 0;
  const unknown = { labels: 0, answered: 0, abstained: 0 }, certainty: Array<{ id: string; criterion: string; confidence: number; selectedProbability: number }> = [];
  for (const c of cases) {
    const row = rows.find(r => r.id === c.id)!;
    for (const criterion of ["passage", "relocation"] as const) {
      const key = `${c[criterion]}=>${row[criterion]}`;
      confusion[criterion][key] = (confusion[criterion][key] ?? 0) + 1;
      const judgment = row.judgments?.[criterion];
      if (judgment) certainty.push({ id: c.id, criterion, confidence: judgment.confidence, selectedProbability: judgment.probabilities[judgment.choice] });
      if (c[criterion] === "unclear") { unknown.labels++; if (row[criterion] === "unclear") unknown.abstained++; else unknown.answered++; }
    }
    if (c.relocation === "met" && row.decision === "candidate") criticalDealbreakerMisses++;
    if (["unknown", "partial", "invalid"].includes(row.salary) && row.decision === "candidate") unknownSalaryCandidates++;
    if (c.literalFalseExclusion && row.literalLocationMatches.length && row.decision === "excluded") literalFalseExclusions++;
    if (!row.evidence.posting || !row.evidence.criteria || !row.evidence.identity) sourceMissing++;
  }
  const expected = cases.filter(c => c.decision === "candidate").map(c => c.id).sort(), actual = [...semanticRanking(rows)].sort();
  const membershipAgreement = cases.filter(c => expected.includes(c.id) === actual.includes(c.id)).length / cases.length;
  // A candidate membership golden is not an independently authored preference order.
  return { origin, labelsApproved: null, denominator: cases.length, confusion, criticalDealbreakerMisses,
    unknownSalaryCandidates, literalFalseExclusions, sourceMissing, unknown, certainty, expectedCandidates: expected, actualCandidates: actual,
    membershipAgreement, pairwiseRankingAgreement: null, reviewEffortSeconds: null, measuredProviderCostUsd: null,
    latencyP50Ms: null, latencyP95Ms: null, throughput: null, goNoGo: null };
}
