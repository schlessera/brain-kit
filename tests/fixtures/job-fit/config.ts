// An Odysseus-world jobs scoring config for tests/job-ingest-scoring.test.ts.
// Compensation is benchmarked at EUR 150,000 a year in cents, worth 10 points.
import { parseScoringConfig } from "../../../packages/module-jobs/src/score";

export const config = parseScoringConfig({
  groups: [
    { name: "passage", weight: 40, keywords: ["navigation", "sea passage"] },
    { name: "autonomy", weight: 20, keywords: ["independent"] },
    { name: "seniority", weight: 10, match: "title", keywords: ["lead", "captain"] },
  ],
  location: { weight: 20, preferred: ["ithaca", "remote"], excluded: ["on-site only", "troy only"] },
  excludeTitles: ["recruiter"], compensationBenchmark: 15_000_000, compensationWeight: 10,
  queueThreshold: 60, dismissThreshold: 35,
});
