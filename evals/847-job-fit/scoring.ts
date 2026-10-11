import { scoreJob, type ScoreJobInput, type ScoringConfig } from "../../packages/module-jobs/src/score";
import type { JevAnswers } from "../../packages/core/src/lib/jev";

export type Decision = "candidate" | "excluded" | "review";
export type Label = "met" | "not_met" | "unclear";
export interface Case {
  id: string; split: string; set: string; posting: string; job: ScoreJobInput;
  companyPacket?: unknown;
  expected: { passage: Label; relocation: Label; decision: Decision; autonomy?: number | null };
}
export interface Row {
  id: string; rep: number; arm: string; decision: Decision;
  passage?: Label; relocation?: Label; invalid?: boolean; lowConfidence?: boolean;
  statusFiles?: number; pipelinePresent?: boolean; permissionDenials?: number; agentTurns?: number;
  answers?: JevAnswers; outcome?: string; score?: number; model?: string;
}

export function keyword(c: Case, config: ScoringConfig): Decision {
  const score = scoreJob(c.job, config).total;
  return score >= config.queueThreshold ? "candidate" : score < config.dismissThreshold ? "excluded" : "review";
}

/** Definite hard failures precede missing evidence; salary uses guaranteed minimum, never ceiling. */
export function aggregate(c: Case, passage: Label, relocation: Label, config: ScoringConfig): Decision {
  const { job } = c;
  // Retain the configured literal guards, including their negated/quoted false exclusions.
  const titleExcluded = config.excludeTitles.some(k => job.title.toLowerCase().includes(k));
  const text = `${c.posting} ${job.location ?? ""}`;
  const locationExcluded = config.location?.excluded.some(k =>
    new RegExp(`\\b${k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(text));
  if (titleExcluded || locationExcluded || passage === "not_met" || relocation === "met" ||
      (job.salary_min !== null && job.salary_min < (config.compensationBenchmark ?? 0))) return "excluded";
  if (passage === "unclear" || relocation === "unclear" || job.salary_min === null) return "review";
  const base = scoreJob(job, config);
  const total = base.total - base.passage - (base.location ?? 0) - (base.compensation ?? 0) +
    40 + (config.location?.weight ?? 0) + config.compensationWeight;
  return total >= config.queueThreshold ? "candidate" : "review";
}

export function candidate(c: Case, answers: JevAnswers | undefined, floor: number, config: ScoringConfig) {
  if (!answers) return { decision: "review" as Decision, invalid: true };
  let lowConfidence = false;
  const read = (key: string): Label => {
    const a = answers[key];
    if (a?.type !== "choice" || !["met", "not_met", "unclear"].includes(a.choice)) return "unclear";
    if (a.confidence < floor || a.probabilities[a.choice] < floor) { lowConfidence = true; return "unclear"; }
    return a.choice as Label;
  };
  const passage = read("passage"), relocation = read("relocation");
  return { passage, relocation, lowConfidence, decision: aggregate(c, passage, relocation, config) };
}

export function metrics(rows: Row[], cases: Case[]) {
  const gold = new Map(cases.map(c => [c.id, c.expected]));
  const tp = rows.filter(r => r.decision === "candidate" && gold.get(r.id)?.decision === "candidate").length;
  const predicted = rows.filter(r => r.decision === "candidate").length;
  const eligible = rows.filter(r => gold.get(r.id)?.decision === "candidate").length;
  const ids = [...new Set(rows.map(r => r.id))];
  return {
    n: rows.length, correct: rows.filter(r => r.decision === gold.get(r.id)?.decision).length,
    precision: predicted ? tp / predicted : null, recall: eligible ? tp / eligible : null,
    dealbreakerMisses: rows.filter(r => gold.get(r.id)?.relocation === "met" && r.decision === "candidate").length,
    mustHaveMisses: rows.filter(r => gold.get(r.id)?.passage === "not_met" && r.decision === "candidate").length,
    dealbreakerLabelErrors: rows.filter(r => r.relocation && gold.get(r.id)?.relocation === "met" && r.relocation !== "met").length,
    mustHaveLabelErrors: rows.filter(r => r.passage && gold.get(r.id)?.passage === "not_met" && r.passage !== "not_met").length,
    invalid: rows.filter(r => r.invalid).length, abstentions: rows.filter(r => r.decision === "review").length,
    lowConfidence: rows.filter(r => r.lowConfidence).length,
    unanimous: ids.filter(id => new Set(rows.filter(r => r.id === id).map(r => r.decision)).size === 1).length,
    cases: ids.length,
  };
}
