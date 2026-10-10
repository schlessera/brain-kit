/** Author-label grading only; origin must be retained alongside any aggregate. */
import type { BenchmarkCase } from "./benchmark";
import { semanticRanking, type SemanticAssessment } from "./semantic";
/** The installed scorer's own routing: queue, dismiss or neither, by the configured thresholds. Keyless, so scorable now. */
export function keywordDecision(row: SemanticAssessment, config: { queueThreshold: number; dismissThreshold: number }) {
  return row.baseline.total >= config.queueThreshold ? "candidate" : row.baseline.total < config.dismissThreshold ? "excluded" : "review";
}
function membership(cases: BenchmarkCase[], actual: string[]) {
  const expected = cases.filter(c => c.decision === "candidate").map(c => c.id);
  const hits = actual.filter(id => expected.includes(id)).length;
  return { agreement: cases.filter(c => expected.includes(c.id) === actual.includes(c.id)).length / cases.length,
    precision: actual.length ? hits / actual.length : null, recall: expected.length ? hits / expected.length : null };
}
export function grade(cases: BenchmarkCase[], rows: SemanticAssessment[], origin: "scripted-control" | "reviewed-live", thresholds?: { queueThreshold: number; dismissThreshold: number }) {
  if (new Set(cases.map(c => c.id)).size !== cases.length || rows.length !== cases.length || new Set(rows.map(r => r.id)).size !== rows.length || rows.some(r => !cases.some(c => c.id === r.id))) throw Error("Complete unique grading denominator required");
  // `confusion` grades the admitted judgment (floor applied; abstention reads as unclear).
  // `rawConfusion` grades whatever the exact model answered, before any floor, so a
  // calibration that admits nothing still leaves a measurable per-criterion result.
  const confusion: Record<string, Record<string, number>> = { passage: {}, relocation: {} };
  const rawConfusion: Record<string, Record<string, number>> = { passage: {}, relocation: {} };
  let criticalDealbreakerMisses = 0, mustHaveMisses = 0, unknownSalaryCandidates = 0, literalFalseExclusions = 0, sourceMissing = 0;
  const unknown = { labels: 0, answered: 0, abstained: 0 }, certainty: Array<{ id: string; criterion: string; confidence: number; selectedProbability: number }> = [];
  for (const c of cases) {
    const row = rows.find(r => r.id === c.id)!;
    for (const criterion of ["passage", "relocation"] as const) {
      const key = `${c[criterion]}=>${row[criterion]}`;
      confusion[criterion][key] = (confusion[criterion][key] ?? 0) + 1;
      const rawKey = `${c[criterion]}=>${row.rawAnswers?.[criterion].choice ?? "no_answer"}`;
      rawConfusion[criterion][rawKey] = (rawConfusion[criterion][rawKey] ?? 0) + 1;
      const judgment = row.judgments?.[criterion];
      if (judgment) certainty.push({ id: c.id, criterion, confidence: judgment.confidence, selectedProbability: judgment.probabilities[judgment.choice] });
      if (c[criterion] === "unclear") { unknown.labels++; if (row[criterion] === "unclear") unknown.abstained++; else unknown.answered++; }
    }
    if (c.relocation === "met" && row.decision === "candidate") criticalDealbreakerMisses++;
    if (c.passage === "not_met" && row.decision === "candidate") mustHaveMisses++;
    if (["unknown", "partial", "invalid"].includes(row.salary) && row.decision === "candidate") unknownSalaryCandidates++;
    if (c.literalFalseExclusion && row.literalLocationMatches.length && row.decision === "excluded") literalFalseExclusions++;
    if (!row.evidence.posting || !row.evidence.criteria || !row.evidence.identity) sourceMissing++;
  }
  const expected = cases.filter(c => c.decision === "candidate").map(c => c.id).sort(), actual = [...semanticRanking(rows)].sort();
  // Membership agreement rewards excluding everything on a mostly-ineligible set;
  // precision/recall over the candidate set say which direction the misses go.
  const hybrid = membership(cases, actual);
  // Floors the hybrid has to beat: the installed keyword routing, and routing nothing at all.
  let keywordBaseline = null;
  if (thresholds) {
    const keywordCandidates = rows.filter(r => keywordDecision(r, thresholds) === "candidate").map(r => r.id).sort();
    const keywordExcluded = rows.filter(r => keywordDecision(r, thresholds) === "excluded").map(r => r.id);
    keywordBaseline = { ...membership(cases, keywordCandidates), candidates: keywordCandidates,
      criticalDealbreakerMisses: cases.filter(c => c.relocation === "met" && keywordCandidates.includes(c.id)).length,
      mustHaveMisses: cases.filter(c => c.passage === "not_met" && keywordCandidates.includes(c.id)).length,
      eligibleDismissed: cases.filter(c => c.decision === "candidate" && keywordExcluded.includes(c.id)).length };
  }
  const reviewEverything = membership(cases, []);
  // A candidate membership golden is not an independently authored preference order.
  return { origin, labelsApproved: null, denominator: cases.length, confusion, rawConfusion, criticalDealbreakerMisses, mustHaveMisses,
    unknownSalaryCandidates, literalFalseExclusions, sourceMissing, unknown, certainty, expectedCandidates: expected, actualCandidates: actual,
    membershipAgreement: hybrid.agreement, candidatePrecision: hybrid.precision, candidateRecall: hybrid.recall,
    keywordBaseline, reviewEverythingFloor: reviewEverything.agreement,
    pairwiseRankingAgreement: null, reviewEffortSeconds: null, measuredProviderCostUsd: null,
    latencyP50Ms: null, latencyP95Ms: null, throughput: null, goNoGo: null };
}
