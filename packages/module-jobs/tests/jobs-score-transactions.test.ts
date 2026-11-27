/** Scoring and deletion are all or nothing, and scoring reads its candidates in bounded pages (#4811). */
import { afterEach, beforeAll, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDatabase } from "../src/db";
import { deleteJob, searchJobs } from "../src/review";
import { loadScoringConfig, rescoreAllJobs, scoreNewJobs, type ScoringConfig } from "../src/score";
import { ingestJobs } from "../src/scrape";
import type { RawJob } from "../src/types";

let config: ScoringConfig;
beforeAll(() => { config = loadScoringConfig(import.meta.dir, "fixtures/criteria.md"); });

const handles: Database[] = [];
afterEach(() => { for (const db of handles.splice(0)) db.close(); });

function seeded(count: number): { db: Database; ids: number[] } {
  const db = openDatabase(":memory:");
  handles.push(db);
  const jobs: RawJob[] = Array.from({ length: count }, (_, i) => ({
    source: "remoteok", source_id: `ithaca-${i}`, title: `Ithaca helmsman ${i}`, company: `Ithaca Fleet ${i}`,
    description: "Steer the ship past Scylla and Charybdis.", tags: ["sailing"],
  }));
  ingestJobs(db, jobs);
  const ids = (db.query("SELECT id FROM jobs ORDER BY id").all() as Array<{ id: number }>).map((row) => row.id);
  return { db, ids };
}

/** Make `toScoreInput` throw on one row: its stored tags are not JSON. */
function breakRow(db: Database, id: number): void {
  db.query("UPDATE jobs SET tags = 'not-json' WHERE id = ?").run(id);
}

test("scoreNewJobs scores nothing when the third candidate fails", () => {
  const { db, ids } = seeded(5);
  breakRow(db, ids[2]!);
  expect(() => scoreNewJobs(db, config)).toThrow();
  expect(db.query("SELECT COUNT(*) AS c FROM jobs WHERE scored_at IS NOT NULL").get()).toEqual({ c: 0 });
});

test("rescoreAllJobs keeps every previous score when the third row fails", () => {
  const { db, ids } = seeded(5);
  db.exec(`UPDATE jobs SET relevance_score = -1, score_breakdown = '{"previous":true}', scored_at = '2026-07-12T00:00:00Z'`);
  const before = db.query("SELECT id, relevance_score, score_breakdown, scored_at FROM jobs ORDER BY id").all();
  breakRow(db, ids[2]!);
  expect(() => rescoreAllJobs(db, config)).toThrow();
  expect(db.query("SELECT id, relevance_score, score_breakdown, scored_at FROM jobs ORDER BY id").all()).toEqual(before);
});

test("deleteJob keeps the job searchable when its final delete fails", () => {
  const { db, ids } = seeded(3);
  const target = ids[1]!;
  db.exec(`CREATE TRIGGER refuse_job_delete BEFORE DELETE ON jobs WHEN OLD.id = ${target}
    BEGIN SELECT RAISE(ABORT, 'job delete refused'); END`);
  expect(searchJobs(db, "helmsman 1").map((job) => job.id)).toContain(target);
  expect(() => deleteJob(db, target)).toThrow("job delete refused");
  expect(searchJobs(db, "helmsman 1").map((job) => job.id)).toContain(target);
});

/** Record the row count of every `.all()` on a statement that reads `description_text`. */
function spyDescriptionReads(db: Database): number[] {
  const reads: number[] = [];
  const wrapped = new WeakSet<object>();
  for (const method of ["query", "prepare"] as const) {
    const original = db[method].bind(db) as (sql: string) => ReturnType<Database["query"]>;
    Object.defineProperty(db, method, {
      configurable: true, writable: true,
      value: (sql: string) => {
        const statement = original(sql);
        if (sql.includes("description_text") && !wrapped.has(statement)) {
          wrapped.add(statement);
          const all = statement.all.bind(statement);
          statement.all = ((...params: never[]) => {
            const rows = all(...params);
            reads.push(rows.length);
            return rows;
          }) as typeof statement.all;
        }
        return statement;
      },
    });
  }
  return reads;
}

test("both scoring passes read candidates in bounded pages", () => {
  const count = 1_200;
  for (const pass of [scoreNewJobs, rescoreAllJobs]) {
    const { db } = seeded(count);
    const reads = spyDescriptionReads(db);
    expect(pass(db, config)).toBe(count);
    for (const method of ["query", "prepare"] as const) delete (db as unknown as Record<string, unknown>)[method];
    expect(reads.reduce((sum, rows) => sum + rows, 0)).toBe(count);
    expect(Math.max(...reads)).toBeLessThan(count);
  }
});
