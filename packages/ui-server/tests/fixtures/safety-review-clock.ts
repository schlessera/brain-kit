/** Fixed clocks belong to this test module, never the production writer RPC. */
import type { Database } from "bun:sqlite";
import { prepareSafetyReview, commitSafetyReview, type SafetyReviewBody, type SafetyReviewer } from "../../src/governance/safety-reviews";

export const url = import.meta.url;
function readings(at: number | number[]): () => number {
  let index = 0;
  return () => typeof at === "number" ? at : at[Math.min(index++, at.length - 1)]!;
}
export function setup(db: Database) {
  return {
    safetyPrepareReview: (body: SafetyReviewBody, actor: SafetyReviewer, at: number) => prepareSafetyReview(db, body, actor, () => at),
    safetyCommitReview: (id: string, body: SafetyReviewBody, actor: SafetyReviewer, at: number | number[], pending = false, failed = false) =>
      commitSafetyReview(db, id, body, actor, pending, failed, readings(at)),
  };
}
