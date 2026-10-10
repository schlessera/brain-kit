// The shipped jobs ingest-to-score chain the job-fit eval first exercised
// (#1386 split it from the eval's private-assessment tests in
// experiments/job-fit-eval.test.ts): configured currency rates and hourly
// ranges normalize before `scoreJob` sees them. The eval's scoring config is
// the only fixture borrowed.
import { expect, test } from "bun:test";
import { config } from "../scripts/evals/job-fit/fixtures";
import { scoreJob } from "../packages/module-jobs/src/score";
import { openDatabase } from "../packages/module-jobs/src/db";
import { ingestJobs } from "../packages/module-jobs/src/scrape";
import { parseSalaryRange, HOURS_PER_YEAR } from "../packages/module-jobs/src/salary";

test("real ingest normalizes configured currency and hourly ranges before scoring", () => {
  const db = openDatabase(":memory:");
  try {
    const parsed = parseSalaryRange("EUR 75 - 90 per hour"); expect(parsed.min).toBe(75 * HOURS_PER_YEAR);
    ingestJobs(db, [
      { source: "remoteok", source_id: "hourly-control", title: "Captain", company: "Ithaca harbour", salary_min: parsed.min, salary_max: parsed.max, salary_currency: "EUR" },
      { source: "remoteok", source_id: "rate-control", title: "Captain", company: "Phaeacian docks", salary_min: 160000, salary_max: 180000, salary_currency: "USD" },
    ], false, { EUR: 1, USD: 1.25 });
    const rows = db.query("SELECT title, company, description_text, location, tags, salary_min, salary_max, remote_type, salary_currency FROM jobs ORDER BY id").all() as Array<Parameters<typeof scoreJob>[0] & { salary_currency: string }>;
    expect(rows).toHaveLength(2); expect(rows[0]!.salary_min).toBe(15_600_000); expect(rows[1]!.salary_min).toBe(20_000_000);
    expect(rows[1]!.salary_currency).toBe("USD");
    for (const row of rows) expect(scoreJob({ ...row, tags: [] }, config).compensation).toBe(10);
  } finally { db.close(); }
});
