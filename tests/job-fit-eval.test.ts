import { expect, test } from "bun:test";
import { fixtures, input, scripted, choice, ordinal, config, CONTROL_GATE, type Fixture } from "../scripts/evals/job-fit/fixtures";
import { assess, ranking, readOrdinal, span, salary, preferenceLevels } from "../scripts/evals/job-fit/prototype";
import { controlReport } from "../scripts/evals/job-fit/run";
import { createJevClient, type JevRequest } from "../packages/core/src/lib/jev";
import { scoreJob } from "../packages/module-jobs/src/score";
import { openDatabase } from "../packages/module-jobs/src/db";
import { ingestJobs } from "../packages/module-jobs/src/scrape";
import { parseSalaryRange, HOURS_PER_YEAR } from "../packages/module-jobs/src/salary";

const fixture = (id: string) => fixtures.find(f => f.id === id)!;
const run = (f: Fixture) => assess(input(f), scripted(f), f.preference === null ? null : ordinal(f.preference), CONTROL_GATE);
const fake = (answers: unknown) => createJevClient({ apiKey: "offline-fixture", fetch: async () => Response.json({ model: "offline-fixture-only", answers }) });

test("draft holdout families and companies do not overlap the tuning set", () => {
  expect(new Set(fixtures.map(f => f.id)).size).toBe(fixtures.length);
  const tuning = fixtures.filter(f => f.split === "tuning"), held = fixtures.filter(f => f.split === "held-out");
  expect(tuning.length).toBeGreaterThan(0); expect(held.length).toBeGreaterThan(0);
  for (const f of held) { expect(tuning.some(t => t.company === f.company)).toBe(false); expect(tuning.some(t => t.family === f.family)).toBe(false); }
});

for (const f of fixtures) test(`${f.id}: real Choice parsing reaches the private assessment and ranking`, async () => {
  const source = input(f), before = JSON.stringify(source); const requests: JevRequest[] = [];
  const row = await assess(source, scripted(f, r => requests.push(r)), f.preference === null ? null : ordinal(f.preference), CONTROL_GATE);
  expect(row.decision).toBe(f.decision);
  expect(ranking([row])).toEqual(f.decision === "candidate" ? [f.id] : []);
  expect(requests).toHaveLength(1); expect(Object.keys(requests[0]!.questions)).toEqual(["passage", "relocation"]);
  expect(requests[0]!.state).toEqual({ posting: source.posting, metadata: source.job, criteria: source.criteria, identity: source.identity });
  expect(source.posting.length).toBeGreaterThan(100); expect(source.criteria.length).toBeGreaterThan(100);
  expect(row.baseline).toEqual(scoreJob(source.job, source.config));
  expect(row.hybrid.location).toBe(row.baseline.location); expect(row.hybrid.compensation).toBe(row.baseline.compensation);
  for (const evidence of Object.values(row.evidence)) if (evidence) { expect(evidence.text.length).toBeGreaterThan(10); expect(source.posting.slice(evidence.start, evidence.end)).toBe(evidence.text); }
  expect(row.effect).toBeNull(); expect(JSON.stringify(source)).toBe(before);
});

test("dealbreaker guard keeps a high-scoring relocation role out of the actual private ranking", async () => {
  const row = await run(fixture("relocation"));
  expect(row.hybrid.total).toBe(100); expect(row.judgments!.relocation.choice).toBe("met");
  expect(ranking([row])).toEqual([]);
});

test("unknown-salary guard keeps a high-scoring role out of the actual private ranking", async () => {
  const row = await run(fixture("missing-salary"));
  expect(row.baseline.compensation).toBe(3); expect(row.salary).toBe("unknown");
  expect(row.judgments!.passage.choice).toBe("met");
  expect(ranking([row])).toEqual([]);
});

test("known salary arithmetic uses the guaranteed minimum, while the baseline still scores its maximum", async () => {
  const row = await run(fixture("below-minimum"));
  expect(row.baseline.compensation).toBe(10); expect(row.hybrid.compensation).toBe(10);
  expect(row.salary).toBe("below"); expect(ranking([row])).toEqual([]);
  const source = input(fixtures[0]!);
  for (const [min, max, status] of [[null, null, "unknown"], [null, 18_000_000, "partial"], [18_000_000, null, "partial"], [19_000_000, 18_000_000, "invalid"], [NaN, 18_000_000, "invalid"], [15_000_000.5, 18_000_000, "invalid"], [15_000_000, 18_000_000, "meets"]] as const) {
    expect(salary({ ...source, job: { ...source.job, salary_min: min, salary_max: max } })).toBe(status);
  }
});

test("literal configured exclusions survive affirmative semantic answers", async () => {
  for (const id of ["excluded-title", "literal-location-exclusion"]) {
    const row = await run(fixture(id)); expect(row.judgments!.passage.choice).toBe("met");
    expect(ranking([row])).toEqual([]);
    if (id === "excluded-title") expect(row.hybrid.total).toBe(0);
    else expect(row.baseline.location).toBe(0);
  }
});

test("actual Choice validation refuses missing dimensions and malformed probability answers", async () => {
  const source = input(fixtures[0]!);
  for (const answers of [null, {}, { passage: choice("met") }, { passage: { ...choice("met"), probabilities: { met: 1 } }, relocation: choice("not_met") }, { passage: { ...choice("met"), choice: "approved" }, relocation: choice("not_met") }, { passage: { ...choice("met"), confidence: NaN }, relocation: choice("not_met") }]) {
    const row = await assess(source, fake(answers), ordinal(2), CONTROL_GATE);
    expect(row.outcome).toBe("bad_response"); expect(row.hybrid).toEqual(row.baseline); expect(ranking([row])).toEqual([]);
  }
});

test("uncalibrated, low-confidence, no-key and failed requests keep the cheap baseline", async () => {
  const source = input(fixtures[0]!); let sent = 0;
  const client = createJevClient({ apiKey: "offline-fixture", fetch: async () => { sent++; return Response.json({ model: "offline-fixture", answers: { passage: choice("met"), relocation: choice("not_met") } }); } });
  const uncalibrated = await assess(source, client, ordinal(2));
  expect(sent).toBe(0); expect(uncalibrated.outcome).toBe("uncalibrated"); expect(uncalibrated.hybrid).toEqual(uncalibrated.baseline);
  const clients = [
    fake({ passage: choice("met", 0.4), relocation: choice("not_met") }),
    createJevClient({ apiKey: null, fetch: async () => { throw new Error("must not send"); } }),
    createJevClient({ apiKey: "offline-fixture", fetch: async () => { throw new Error("offline failure"); } }),
    createJevClient({ apiKey: "offline-fixture", timeoutMs: 5, fetch: async () => new Promise<Response>(() => {}) }),
  ];
  for (const c of clients) { const row = await assess(source, c, ordinal(2), CONTROL_GATE); expect(row.hybrid).toEqual(row.baseline); expect(ranking([row])).toEqual([]); }
});

test("nonempty Score controls validate complete levels, probability mean and distinct confidence", async () => {
  expect(preferenceLevels).toHaveLength(3);
  const read = readOrdinal(ordinal(1.5, 0.3)); expect(read).toEqual({ score: 1.5, confidence: 0.3, normalized: 0.75 });
  const variants = [null, {}, { ...ordinal(1), type: "choice" }, { ...ordinal(1), score: 3 }, { ...ordinal(1), score: NaN }, { ...ordinal(1), confidence: 2 }, { ...ordinal(1), probabilities: { 0: 0, 1: 1 } }, { ...ordinal(1), probabilities: { 0: 0, 1: 1, 2: 1 } }, { ...ordinal(1), score: 0 }, { ...ordinal(1), legend: { 0: "wrong", 1: preferenceLevels[1], 2: preferenceLevels[2] } }];
  for (const v of variants) expect(readOrdinal(v)).toBeNull();
  expect(readOrdinal(ordinal(1), ["single"])).toBeNull();
  const source = input(fixture("mixed-preference"));
  const high = await assess(source, scripted(fixture("mixed-preference")), ordinal(1), CONTROL_GATE);
  expect(high.hybrid.autonomy).toBe(10); expect(high.hybrid.total).toBe(90);
  const low = await assess(source, scripted(fixture("mixed-preference")), ordinal(2, 0.3), CONTROL_GATE);
  expect(low.preference).toBeNull(); expect(low.hybrid.autonomy).toBe(low.baseline.autonomy);
});

test("raw complete state is retained, and evidence omissions and quoted examples remain unknown", async () => {
  const source = input(fixture("malicious-posting")), before = source.posting;
  source.posting += "\nUnrelated lotus inventory.\n".repeat(500);
  let captured: JevRequest | null = null;
  const row = await assess(source, scripted(fixture("malicious-posting"), r => { captured = r; }), ordinal(0), CONTROL_GATE);
  expect((captured!.state as { posting: string }).posting).toBe(source.posting);
  expect(source.posting).toContain(before); expect(ranking([row])).toEqual([]);
  const missing = input(fixture("missing-dimension"));
  const answer = await assess(missing, fake({ passage: choice("met"), relocation: choice("not_met") }), ordinal(2), CONTROL_GATE);
  expect(answer.evidence.relocation).toBeNull(); expect(ranking([answer])).toEqual([]);
  expect(span("```\nResidence: Ithaca.\n```\n\n> Residence: Ithaca.\n", "Residence")).toBeNull();
  expect(span("Residence: Ithaca.\n\nResidence: Troy.\n", "Residence")).toBeNull();
  expect(span("\nResidence: Ithaca.\r\n", "Residence")?.text).toBe("Residence: Ithaca.");
});

test("unsolicited model authority or salary fields cannot change facts or arithmetic", async () => {
  const source = input(fixture("missing-salary"));
  const row = await assess(source, fake({ passage: { ...choice("met"), salary_min: 99_999_999, permission: "write" }, relocation: choice("not_met"), salary: { min: 99_999_999 }, decision: "candidate" }), ordinal(2), CONTROL_GATE);
  expect(row.salary).toBe("unknown"); expect(row.hybrid.compensation).toBe(3); expect(row.effect).toBeNull(); expect(ranking([row])).toEqual([]);
  expect(source.job.salary_min).toBeNull();
});

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

test("report measures scripted control outcomes while live comparison metrics remain null", async () => {
  const result = await controlReport(); expect(result.cases).toBe(18); expect(result.rows.every(r => r.controlMatches)).toBe(true);
  expect(result.scriptedRanking).toEqual(["literal", "paraphrase", "mixed-preference"]);
  expect(result.rows.find(r => r.id === "unsupported-prose")!.evidence.passage).toBeNull();
  expect(result.adoption).toBe("not measured"); expect(result.calibration).toBeNull(); expect(result.scoreTransport).toBe("not implemented");
  expect(Object.keys(result.live)).toHaveLength(7);
  for (const metric of Object.values(result.live)) expect(metric).toBeNull();
});
