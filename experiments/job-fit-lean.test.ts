import { expect, test } from "bun:test";
import data from "../evals/cases/847-job-fit.json";
import { parseScoringConfig } from "../packages/module-jobs/src/score";
import { aggregate, candidate, metrics, type Case, type Row } from "../evals/847-job-fit/scoring";
const config = parseScoringConfig(data.shared.scoringConfig);
const get = (id: string) => data.cases.find(c => c.id === id)! as Case;

test("definite dealbreakers and guaranteed minimum defeat eligible-looking salary ceilings", () => {
  expect(aggregate(get("held-board-vs-contract"), "met", "met", config)).toBe("excluded");
  expect(aggregate(get("held-low-guarantee"), "met", "not_met", config)).toBe("excluded");
  expect(aggregate(get("held-ceiling-only"), "met", "not_met", config)).toBe("review");
  expect(aggregate(get("held-no-residence"), "met", "unclear", config)).toBe("review");
  expect(aggregate(get("held-paraphrase"), "met", "not_met", config)).toBe("candidate");
});

test("selected probability and confidence both gate a judgment", () => {
  const answer = { type: "choice" as const, choice: "met", confidence: 0.99,
    probabilities: { met: 0.01, not_met: 0.49, unclear: 0.5 } };
  const result = candidate(get("held-paraphrase"), { passage: answer,
    relocation: { ...answer, choice: "not_met", probabilities: { met: 0, not_met: 1, unclear: 0 } } }, 0.6, config);
  expect(result.decision).toBe("review"); expect(result.lowConfidence).toBe(true);
});

test("vetoes count every repetition rather than a majority vote", () => {
  const rows: Row[] = ["excluded", "excluded", "candidate"].map((decision, rep) => ({
    id: "held-board-vs-contract", rep, arm: "model", decision: decision as Row["decision"] }));
  const result = metrics(rows, [get("held-board-vs-contract")]);
  expect(result.correct).toBe(2); expect(result.dealbreakerMisses).toBe(1);
  expect(result.unanimous).toBe(0); expect(result.precision).toBe(0);
});
