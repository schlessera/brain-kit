/** Author-provisional full-source rubric, never a model request or adopted ranking policy. */
export const rubric = {
  authorFamily: "gpt", complementaryReview: null,
  assessment: "Walk every supplied must-have, strong preference, dealbreaker, experience alignment/gap and compensation fact; separate observed company facts from unknown funding/team/leadership/history. Explain missing or contradictory evidence rather than inventing facts. Preserve deterministic configured title/literal guards and guaranteed-minimum arithmetic; no dismissal/application/file authority.",
  labels: "21 benchmark criterion/eligibility labels are author-provisional. Descriptive autonomy is review context, not Score output/probability or scalar model preference. Whole source truth and precedence must be independently verified before any held-out score.",
  ranking: {
    measure: "Separate source-preference diagnostic, never the configured weighted-score ranking target. The held-out pair can disagree with the preserved seniority/title weighting. Report that disagreement explicitly; do not change weights or infer ordinal Score results to satisfy this rubric.",
    configuredRanking: "Retain actual scoreJob component points, configured weights and deterministic tie ordering for every arm. Analyze any source-preference pair separately from numeric ranking agreement. No authored total order or scalar autonomy quality is yet approved.",
    method: "Eligibility must be recorded separately. Evaluate each author pair only if both roles were actually admitted, retaining excluded/unknown/unobserved pairs as coverage gaps; do not turn coverage into agreement. Prefer explicitly broader independent course ownership over supervised routine autonomy where both roles meet hard criteria and guaranteed pay. Shared company knowledge is deliberately unknown. This tiny two-pair rubric is not population preference validation or a production score.",
    pairs: [
      { split: "tuning", higher: "tune-course", lower: "tune-advertisement", reason: "Both provisional candidates meet hard criteria; complete sources describe broad course ownership versus routine autonomy with exceptional review." },
      { split: "held-out", higher: "held-paraphrase", lower: "held-old-title", reason: "Both provisional candidates meet hard criteria; homeward course ownership meets the stated strong preference more fully than reviewed unusual supply decisions." },
    ], ties: [], unknownPairOrder: "No forced order when source preference or eligibility is missing/conflicting; retain as unresolved.",
  },
  effort: { record: "Every source verification/clarification/correction/explanation/fallback/research/generation/human decision retains actor, literal input/output, start/end clock, elapsed and provenance. Reject negative or missing duration. Model/native usage and invoices remain separate from reviewer work.",
    actorKinds: ["model", "reviewer", "source-verification", "clarification", "correction", "explanation", "generation", "human-decision"],
    boundary: "Scripted events are controls only, no measured time saving. Author-provisional explanatory quality needs independent rubric approval. Included subscription diagnostics never establish an invoice or zero extra charge." },
} as const;
