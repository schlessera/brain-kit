import { expect, test } from "bun:test";
import { turnJournalSummarySchema } from "../src/schemas.js";

const legacy = { state: "complete", changedFiles: 0, steeringFiles: 0, costUsd: null, costIsEstimate: null,
  profile: "governed", actor: "interactive", model: null, policyHash: null, sharedAttribution: false, observedAt: 0 };

test("configuration coverage is optional for legacy journals and validates each authoritative state", () => {
  expect(turnJournalSummarySchema.parse(legacy)).not.toHaveProperty("configurationCoverage");
  for (const configurationCoverage of ["incomplete", "complete", "unknown"]) {
    expect(turnJournalSummarySchema.parse({ ...legacy, configurationCoverage })).toHaveProperty("configurationCoverage", configurationCoverage);
  }
  expect(turnJournalSummarySchema.safeParse({ ...legacy, configurationCoverage: "guessed" }).success, "COVERAGE_REJECTS_INVENTED_COMPLETENESS").toBe(false);
});
