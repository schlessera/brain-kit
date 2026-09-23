/**
 * What re-ingesting a row already stored refreshes (#159).
 *
 * `ingestJobs` upserts on `(source, source_id)`. Before #159 the conflict
 * clause never touched `source_url` or `company`, so an adapter repair could
 * only reach rows it had not stored yet: a row stored with the literal
 * `Unknown` company kept it forever. Refreshing `company` has consequences a
 * plain `COALESCE` does not — `company_normalized` and `fingerprint` derive
 * from it, it is FTS-indexed, and a new fingerprint moves the row between
 * dedup groups — and each of those is pinned here.
 */
import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { openDatabase } from "../src/db";
import { computeFingerprint, normalizeCompany, normalizeTitle, runDedup } from "../src/dedup";
import { deleteJob } from "../src/review";
import { ingestJobs } from "../src/scrape";
import type { RawJob } from "../src/types";

function job(overrides: Partial<RawJob> = {}): RawJob {
  return {
    source: "dice",
    source_id: "/job-detail/1",
    title: "Senior Platform Engineer",
    company: "Unknown",
    url: "https://www.dice.example/job-detail/1",
    source_url: "/job-detail/1",
    ...overrides,
  };
}

interface StoredRow {
  id: number;
  source: string;
  source_id: string;
  title: string;
  title_normalized: string;
  company: string;
  company_normalized: string;
  fingerprint: string;
  source_url: string | null;
  is_duplicate: number;
  duplicate_of: number | null;
}

function row(db: Database, source: string, sourceId: string): StoredRow {
  return db.query("SELECT * FROM jobs WHERE source = ? AND source_id = ?").get(source, sourceId) as StoredRow;
}

/** Row ids whose INDEXED content matches an FTS query, not the content table. */
function ftsMatches(db: Database, query: string): number[] {
  return (db.query("SELECT rowid FROM jobs_fts WHERE jobs_fts MATCH ? ORDER BY rowid").all(query) as Array<{
    rowid: number;
  }>).map((r) => r.rowid);
}

/**
 * FTS5's own check that the index agrees with the `jobs` content table.
 *
 * `rank = 1` is what makes it compare against the content table: for an
 * external-content index, a bare `integrity-check` only checks the index is
 * internally consistent, which a row indexed under the wrong company still is.
 */
function ftsInSync(db: Database): boolean {
  try {
    db.run("INSERT INTO jobs_fts(jobs_fts, rank) VALUES('integrity-check', 1)");
    return true;
  } catch {
    return false;
  }
}

function expectFtsInSync(db: Database): void {
  expect(ftsInSync(db)).toBe(true);
}

function withDb(fn: (db: Database) => void): void {
  const db = openDatabase(":memory:");
  try {
    fn(db);
  } finally {
    db.close();
  }
}

describe("the FTS sync check", () => {
  test("sees a content row whose indexed company is stale", () => {
    // Without this, every `expectFtsInSync` below could pass over exactly the
    // drift it is there to catch.
    withDb((db) => {
      ingestJobs(db, [job({ company: "Acme Robotics" })]);
      expect(ftsInSync(db)).toBe(true);

      db.run("UPDATE jobs SET company = 'Globex'");
      expect(ftsInSync(db)).toBe(false);
    });
  });
});

describe("source_url", () => {
  test("a corrected source_url replaces the stored one", () => {
    withDb((db) => {
      ingestJobs(db, [job()]);
      ingestJobs(db, [job({ source_url: "https://www.dice.example/job-detail/1" })]);

      expect(row(db, "dice", "/job-detail/1").source_url).toBe("https://www.dice.example/job-detail/1");
    });
  });

  test("a re-scrape that carries no source_url keeps the stored one", () => {
    withDb((db) => {
      ingestJobs(db, [job()]);
      ingestJobs(db, [job({ source_url: undefined })]);

      expect(row(db, "dice", "/job-detail/1").source_url).toBe("/job-detail/1");
    });
  });
});

describe("company", () => {
  test("a corrected company replaces the stored one, with its derived columns", () => {
    withDb((db) => {
      ingestJobs(db, [job()]);
      ingestJobs(db, [job({ company: "Acme Robotics GmbH" })]);

      const stored = row(db, "dice", "/job-detail/1");
      expect(stored.company).toBe("Acme Robotics GmbH");
      expect(stored.company_normalized).toBe(normalizeCompany("Acme Robotics GmbH"));
      expect(stored.fingerprint).toBe(
        computeFingerprint(stored.company, stored.title, { source: stored.source, sourceId: stored.source_id })
      );
    });
  });

  test("the FTS row indexes the company the row now holds", () => {
    withDb((db) => {
      ingestJobs(db, [job()]);
      const id = row(db, "dice", "/job-detail/1").id;
      expect(ftsMatches(db, "company:unknown")).toEqual([id]);

      ingestJobs(db, [job({ company: "Acme Robotics" })]);

      expect(ftsMatches(db, "company:robotics")).toEqual([id]);
      expect(ftsMatches(db, "company:unknown")).toEqual([]);
      expectFtsInSync(db);
    });
  });

  test("a re-scrape that could not find the company does not erase a real one", () => {
    // `Unknown` is the adapters' "no company on this card". Treated like a
    // null: a row that already has a real company keeps it.
    withDb((db) => {
      ingestJobs(db, [job({ company: "Acme Robotics" })]);
      const before = row(db, "dice", "/job-detail/1");

      ingestJobs(db, [job({ company: "Unknown", title: "Staff Platform Engineer" })]);

      const after = row(db, "dice", "/job-detail/1");
      expect(after.company).toBe("Acme Robotics");
      expect(after.company_normalized).toBe(before.company_normalized);
      expect(after.fingerprint).toBe(
        computeFingerprint("Acme Robotics", "Staff Platform Engineer", { source: "dice", sourceId: "/job-detail/1" })
      );
      expect(ftsMatches(db, "company:robotics")).toEqual([after.id]);
      expectFtsInSync(db);
    });
  });
});

describe("derived columns follow the title too", () => {
  test("a changed title recomputes title_normalized and the fingerprint", () => {
    withDb((db) => {
      ingestJobs(db, [job({ company: "Acme Robotics" })]);
      ingestJobs(db, [job({ company: "Acme Robotics", title: "Principal Platform Engineer" })]);

      const stored = row(db, "dice", "/job-detail/1");
      expect(stored.title_normalized).toBe(normalizeTitle("Principal Platform Engineer"));
      expect(stored.fingerprint).toBe(
        computeFingerprint(stored.company, stored.title, { source: stored.source, sourceId: stored.source_id })
      );
    });
  });
});

describe("a row whose fingerprint changes moves dedup group", () => {
  const acme = (source: RawJob["source"], sourceId: string, company = "Acme Robotics"): RawJob =>
    job({ source, source_id: sourceId, company, title: "Platform Engineer", url: undefined, source_url: undefined });

  function age(db: Database, source: string, sourceId: string, firstSeen: string): void {
    db.query("UPDATE jobs SET first_seen_at = ? WHERE source = ? AND source_id = ?").run(firstSeen, source, sourceId);
  }

  test("a duplicate whose company changes is released, and is not re-marked", () => {
    withDb((db) => {
      ingestJobs(db, [acme("remoteok", "a"), acme("weworkremotely", "b")]);
      age(db, "remoteok", "a", "2026-01-01T00:00:00.000Z");
      runDedup(db);
      const canonical = row(db, "remoteok", "a");
      expect(row(db, "weworkremotely", "b")).toMatchObject({ is_duplicate: 1, duplicate_of: canonical.id });

      ingestJobs(db, [acme("weworkremotely", "b", "Globex")]);

      expect(row(db, "weworkremotely", "b")).toMatchObject({ is_duplicate: 0, duplicate_of: null });
      expect(runDedup(db).duplicates_found).toBe(0);
      expect(row(db, "weworkremotely", "b")).toMatchObject({ is_duplicate: 0, duplicate_of: null });
    });
  });

  test("a canonical whose company changes releases the duplicates that pointed at it", () => {
    withDb((db) => {
      ingestJobs(db, [acme("remoteok", "a"), acme("weworkremotely", "b"), acme("workingnomads", "c")]);
      age(db, "remoteok", "a", "2026-01-01T00:00:00.000Z");
      age(db, "weworkremotely", "b", "2026-01-02T00:00:00.000Z");
      runDedup(db);
      const canonical = row(db, "remoteok", "a");
      expect(row(db, "workingnomads", "c").duplicate_of).toBe(canonical.id);

      ingestJobs(db, [acme("remoteok", "a", "Globex")]);

      // b and c still share the old fingerprint; they are released and
      // regrouped among themselves, the older one canonical.
      expect(row(db, "weworkremotely", "b")).toMatchObject({ is_duplicate: 0, duplicate_of: null });
      expect(row(db, "workingnomads", "c")).toMatchObject({ is_duplicate: 0, duplicate_of: null });
      expect(runDedup(db).duplicates_found).toBe(1);
      const b = row(db, "weworkremotely", "b");
      expect(row(db, "workingnomads", "c")).toMatchObject({ is_duplicate: 1, duplicate_of: b.id });
      expect(row(db, "remoteok", "a")).toMatchObject({ is_duplicate: 0, duplicate_of: null });
    });
  });

  test("a row whose corrected company joins an existing group is deduped into it", () => {
    withDb((db) => {
      ingestJobs(db, [acme("remoteok", "a"), acme("dice", "d", "Unknown")]);
      age(db, "remoteok", "a", "2026-01-01T00:00:00.000Z");
      // `Unknown` fingerprints on identity, so these are not duplicates yet.
      expect(runDedup(db).duplicates_found).toBe(0);

      ingestJobs(db, [acme("dice", "d")]);
      expect(runDedup(db).duplicates_found).toBe(1);
      expect(row(db, "dice", "d")).toMatchObject({ is_duplicate: 1, duplicate_of: row(db, "remoteok", "a").id });
    });
  });

  test("an OLDER row joining an established group becomes its canonical, with no chain left behind", () => {
    // The refreshed row predates the group it joins, so it wins the group.
    // Every existing duplicate must end up pointing at it — not at the old
    // canonical, which is now a duplicate itself.
    withDb((db) => {
      ingestJobs(db, [acme("dice", "d", "Unknown"), acme("remoteok", "a"), acme("weworkremotely", "b")]);
      age(db, "dice", "d", "2025-12-01T00:00:00.000Z");
      age(db, "remoteok", "a", "2026-01-01T00:00:00.000Z");
      age(db, "weworkremotely", "b", "2026-01-02T00:00:00.000Z");
      runDedup(db);
      expect(row(db, "weworkremotely", "b").duplicate_of).toBe(row(db, "remoteok", "a").id);

      ingestJobs(db, [acme("dice", "d")]);
      runDedup(db);

      const d = row(db, "dice", "d");
      expect(d).toMatchObject({ is_duplicate: 0, duplicate_of: null });
      expect(row(db, "remoteok", "a")).toMatchObject({ is_duplicate: 1, duplicate_of: d.id });
      expect(row(db, "weworkremotely", "b")).toMatchObject({ is_duplicate: 1, duplicate_of: d.id });
      const chained = db
        .query(
          "SELECT j.id FROM jobs j JOIN jobs target ON target.id = j.duplicate_of WHERE target.is_duplicate = 1"
        )
        .all();
      expect(chained).toEqual([]);
    });
  });

  test("a duplicate orphaned by a deleted canonical stays hidden when its group is regrouped", () => {
    // `deleteJob` and `jobs gc --purge` clear `duplicate_of` on the rows that
    // pointed at a deleted job but keep them marked: they were duplicates of
    // something the user dismissed. A row that later joins their fingerprint
    // must not bring them back into the review queue.
    withDb((db) => {
      ingestJobs(db, [acme("remoteok", "a"), acme("weworkremotely", "b"), acme("dice", "d", "Unknown")]);
      age(db, "remoteok", "a", "2026-01-01T00:00:00.000Z");
      age(db, "weworkremotely", "b", "2026-01-02T00:00:00.000Z");
      runDedup(db);
      deleteJob(db, row(db, "remoteok", "a").id);
      expect(row(db, "weworkremotely", "b")).toMatchObject({ is_duplicate: 1, duplicate_of: null });

      ingestJobs(db, [acme("dice", "d")]);
      runDedup(db);

      expect(row(db, "weworkremotely", "b")).toMatchObject({ is_duplicate: 1, duplicate_of: null });
      expect(row(db, "dice", "d")).toMatchObject({ is_duplicate: 0, duplicate_of: null });
    });
  });

  test("an unchanged re-scrape leaves dedup marks alone", () => {
    withDb((db) => {
      ingestJobs(db, [acme("remoteok", "a"), acme("weworkremotely", "b")]);
      age(db, "remoteok", "a", "2026-01-01T00:00:00.000Z");
      runDedup(db);

      ingestJobs(db, [acme("remoteok", "a"), acme("weworkremotely", "b")]);

      expect(row(db, "weworkremotely", "b")).toMatchObject({
        is_duplicate: 1,
        duplicate_of: row(db, "remoteok", "a").id,
      });
    });
  });
});
