/** Full-source author rubric; complementary semantic approval and reviewer events remain absent. */
import { hash } from "./prototype";
import type { SourceCase } from "./benchmark";
export const rubric = {
  version: "source-summary-v1", authorFamily: "gpt", approved: null,
  summary: "Accept any concise source-supported paraphrase retaining the case's salient facts, negation, uncertainty, actor and conditions. Do not require the authored exact sentence. Unsupported completion, approval, dates or instructions are factual errors. Missing summaries in classification-only are a task-output tradeoff, never free equivalent quality.",
  classification: "Score raw type and each controlled tag against independently reviewed source meanings separately from effective protected owner fields. Unclear/unapproved type routes to configured inbox/review without completed write; custom inbox is not hardcoded note. Abstention and paired confidence/selected-P coverage are reported separately.",
  effort: "Retain all verification/clarification/correction/generation/human events with actor/input/output/start/end/elapsed and provenance, every physical attempt and failed usage. Unknown invoice is null; diagnostics are not actual additional charges. Single scripted completion is neither complete Stage3 nor measured review effort.",
  gate: "Before scoring, all full source/label/summary/protocol packets need actual complementary review. Tune only on six source cases; freeze selected confidence+probability gates before twelve held-out cases. Require zero body/ownership/false-completion violations; original empirical decision needs complete current/classification/hybrid task quality and complete accounting. No adoption from absent measurements.",
} as const;
export interface Annotation {
  sourceSha: string; summarySha: string; rubricSha: string; caseSha: string;
  supportedFacts: number[]; unsupportedClaims: string[]; conditionPreserved: boolean; useful: boolean;
  reviewerFamily: string; independentlyApproved: boolean;
}
export const rubricKey = (c: SourceCase) => hash(JSON.stringify({ rubric, case: c.id, facts: c.facts, prohibited: c.prohibited, purpose: c.purpose }));
export function summaryObservation(c: SourceCase, source: string, written: string | null, annotation: Annotation | null) {
  const identity = { sourceSha: hash(source), summarySha: written === null ? null : hash(written), rubricSha: rubricKey(c), caseSha: hash(JSON.stringify(c)) };
  if (annotation && (annotation.sourceSha !== identity.sourceSha || annotation.summarySha !== identity.summarySha || annotation.rubricSha !== identity.rubricSha || annotation.caseSha !== identity.caseSha ||
    new Set(annotation.supportedFacts).size !== annotation.supportedFacts.length || annotation.supportedFacts.some(i => !Number.isInteger(i) || i < 0 || i >= c.facts.length))) throw Error("Summary annotation does not bind exact source/output/rubric");
  return { ...identity, omitted: written === null, annotation, factuality: null, usefulness: null, factCoverage: null, taskEquivalent: null, semanticApproval: null };
}
