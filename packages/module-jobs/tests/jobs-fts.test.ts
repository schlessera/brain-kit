import { describe, expect, test } from "bun:test";
import { openDatabase } from "../src/db";
import { ingestJobs } from "../src/scrape";
import { sanitizeFtsQuery, searchJobs } from "../src/review";
import { parseScoringConfig, scoreNewJobs } from "../src/score";
import type { RawJob } from "../src/types";

function makeRawJob(overrides: Partial<RawJob> = {}): RawJob {
  return {
    source: "remoteok",
    source_id: "job-1",
    title: "Platform Systems Engineer",
    company: "Acme",
    description: "<p>Build distributed orchestration platforms.</p>",
    url: "https://example.com/job-1",
    ...overrides,
  };
}

describe("FTS sync on ingest", () => {
  test("new job is searchable", () => {
    const db = openDatabase(":memory:");
    ingestJobs(db, [makeRawJob()]);
    expect(searchJobs(db, "orchestration").length).toBe(1);
    db.close();
  });

  test("content update rebuilds the FTS row (no index drift)", () => {
    const db = openDatabase(":memory:");
    ingestJobs(db, [makeRawJob({ description: "<p>Original kubernetes description.</p>" })]);
    expect(searchJobs(db, "kubernetes").length).toBe(1);

    // Same source/source_id, changed title + description
    ingestJobs(db, [
      makeRawJob({
        title: "Principal Platform Architect",
        description: "<p>Updated terraform description.</p>",
      }),
    ]);

    expect(searchJobs(db, "terraform").length).toBe(1);
    expect(searchJobs(db, "architect").length).toBe(1);
    // Old content must be gone from the index
    expect(searchJobs(db, "kubernetes").length).toBe(0);
    db.close();
  });

  test("re-ingesting an unchanged job refreshes last_seen_at", () => {
    const db = openDatabase(":memory:");
    ingestJobs(db, [makeRawJob()]);
    db.query("UPDATE jobs SET last_seen_at = '2020-01-01T00:00:00.000Z'").run();

    const stats = ingestJobs(db, [makeRawJob()]);
    expect(stats.updated).toBe(1);
    expect(stats.new).toBe(0);

    const row = db.query("SELECT last_seen_at FROM jobs").get() as { last_seen_at: string };
    expect(row.last_seen_at > "2020-01-02").toBe(true);
    db.close();
  });
});

describe("sanitizeFtsQuery", () => {
  test("quotes each term", () => {
    expect(sanitizeFtsQuery("platform engineer")).toBe('"platform" "engineer"');
  });

  test("strips embedded double quotes and punctuation-only terms", () => {
    expect(sanitizeFtsQuery('c++ "quoted" (')).toBe('"c++" "quoted"');
  });

  test("search with FTS5 operators/syntax does not throw", () => {
    const db = openDatabase(":memory:");
    ingestJobs(db, [makeRawJob()]);
    expect(() => searchJobs(db, "c++")).not.toThrow();
    expect(() => searchJobs(db, "title: OR NOT (")).not.toThrow();
    expect(searchJobs(db, '"')).toEqual([]);
    db.close();
  });
});

describe("scored_at sentinel", () => {
  // A small inline criteria: excluded titles score 0, so a legitimately
  // zero-scored job still gets scored_at stamped and is not re-scored.
  const scoring = parseScoringConfig({
    groups: [{ name: "eng", weight: 50, keywords: ["engineer", "architect"] }],
    excludeTitles: ["office manager"],
    queueThreshold: 60,
    dismissThreshold: 35,
  });

  test("legitimately zero-scored jobs are not re-scored on subsequent runs", () => {
    const db = openDatabase(":memory:");
    ingestJobs(db, [makeRawJob({ title: "Office Manager", description: "<p>Admin role.</p>" })]);

    expect(scoreNewJobs(db, scoring)).toBe(1);
    const row = db.query("SELECT relevance_score, scored_at FROM jobs").get() as {
      relevance_score: number;
      scored_at: string | null;
    };
    expect(row.relevance_score).toBe(0);
    expect(row.scored_at).not.toBeNull();

    // Second pass: nothing left to score
    expect(scoreNewJobs(db, scoring)).toBe(0);
    db.close();
  });
});
