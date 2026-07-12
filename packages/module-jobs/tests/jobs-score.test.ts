import { beforeAll, describe, expect, test } from "bun:test";
import { loadScoringConfig, scoreJob, type ScoreJobInput, type ScoringConfig } from "../src/score";

// Criteria loaded from the fixture file (neutral example keywords).
let config: ScoringConfig;
beforeAll(() => {
  config = loadScoringConfig(import.meta.dir, "fixtures/criteria.md");
});

function makeJob(overrides: Partial<ScoreJobInput> = {}): ScoreJobInput {
  return {
    title: "Software Engineer",
    company: "Acme Corp",
    description_text: null,
    location: null,
    tags: null,
    salary_min: null,
    salary_max: null,
    remote_type: null,
    ...overrides,
  };
}

describe("scoreJob (criteria-driven)", () => {
  test("breakdown is keyed by the criteria's group names", () => {
    const breakdown = scoreJob(makeJob(), config);
    expect(breakdown).toHaveProperty("distributed-systems");
    expect(breakdown).toHaveProperty("seniority");
    expect(breakdown).toHaveProperty("location");
    expect(breakdown).toHaveProperty("compensation");
    expect(breakdown).toHaveProperty("total");
  });

  test("a strong-tier match scores that group's full weight", () => {
    const breakdown = scoreJob(
      makeJob({
        title: "Staff Engineer, Distributed Systems",
        description_text: "Build consensus systems at scale.",
        location: "Remote, Europe",
        remote_type: "fully_remote",
      }),
      config
    );
    expect(breakdown["distributed-systems"]).toBe(25); // strong tier
    expect(breakdown.seniority).toBe(15); // "staff" in title
    expect(breakdown.location).toBe(20); // europe preferred
    expect(breakdown.total).toBe(25 + 15 + 20 + 3); // +3 unknown-salary comp
  });

  test("a weak-tier match scores the lower tier's points", () => {
    const breakdown = scoreJob(
      makeJob({
        title: "Backend Engineer",
        description_text: "Work on microservices and scalability.",
        location: "Remote",
      }),
      config
    );
    expect(breakdown["distributed-systems"]).toBe(15); // weak tier only
    expect(breakdown.seniority).toBe(0);
    expect(breakdown.location).toBe(20);
  });

  test("an excluded title zeroes the whole job", () => {
    const breakdown = scoreJob(
      makeJob({
        title: "Sales Engineer",
        description_text: "Distributed systems, consensus, staff-level.",
        location: "Remote, Europe",
        salary_max: 20_000_000,
      }),
      config
    );
    expect(breakdown["distributed-systems"]).toBe(0);
    expect(breakdown.seniority).toBe(0);
    expect(breakdown.location).toBe(0);
    expect(breakdown.total).toBe(0);
  });

  test("an excluded-location marker zeroes the location dimension", () => {
    const breakdown = scoreJob(
      makeJob({
        title: "Principal Engineer",
        description_text: "Distributed systems and consensus. This role is US only.",
        location: "Remote",
      }),
      config
    );
    expect(breakdown.location).toBe(0);
    expect(breakdown["distributed-systems"]).toBe(25);
    expect(breakdown.seniority).toBe(15);
  });

  test("word-boundary location markers: 'Milwaukee' does not match 'uk'", () => {
    const notEu = scoreJob(
      makeJob({ title: "Backend Engineer", description_text: "A role.", location: "Milwaukee, WI" }),
      config
    );
    expect(notEu.location).toBe(0);

    const realUk = scoreJob(
      makeJob({ title: "Backend Engineer", description_text: "A role.", location: "London, UK" }),
      config
    );
    expect(realUk.location).toBe(20);
  });

  test("compensation dimension respects the benchmark", () => {
    const atBench = scoreJob(makeJob({ salary_max: 15_000_000 }), config);
    expect(atBench.compensation).toBe(10);
    const near = scoreJob(makeJob({ salary_max: 12_000_000 }), config); // 80% of benchmark
    expect(near.compensation).toBe(5);
    const below = scoreJob(makeJob({ salary_max: 9_000_000 }), config);
    expect(below.compensation).toBe(0);
    const unknown = scoreJob(makeJob(), config);
    expect(unknown.compensation).toBe(3); // round(10 * 0.3)
  });
});
