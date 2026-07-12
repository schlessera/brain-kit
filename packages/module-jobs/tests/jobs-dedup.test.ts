import { describe, expect, test } from "bun:test";
import { computeFingerprint, normalizeTitle, runDedup } from "../src/dedup";
import { openDatabase } from "../src/db";
import { ingestJobs } from "../src/scrape";
import type { RawJob } from "../src/types";

describe("normalizeTitle", () => {
  test("keeps seniority tokens (Senior vs Junior must not collapse)", () => {
    expect(normalizeTitle("Senior Software Engineer")).not.toBe(
      normalizeTitle("Junior Software Engineer")
    );
    expect(normalizeTitle("Staff Engineer")).not.toBe(normalizeTitle("Principal Engineer"));
  });

  test("keeps parenthetical role qualifiers (Frontend vs Backend must not collapse)", () => {
    expect(normalizeTitle("Software Engineer (Frontend)")).not.toBe(
      normalizeTitle("Software Engineer (Backend)")
    );
  });

  test("still strips gender markers and trailing location markers", () => {
    expect(normalizeTitle("Senior Engineer (m/f/d)")).toBe(normalizeTitle("Senior Engineer"));
    expect(normalizeTitle("Senior Engineer - Remote")).toBe(normalizeTitle("Senior Engineer"));
    expect(normalizeTitle("Senior Engineer | Europe")).toBe(normalizeTitle("Senior Engineer"));
  });
});

describe("computeFingerprint", () => {
  test("senior vs junior at the same company do not collide", () => {
    expect(computeFingerprint("Acme", "Senior Engineer")).not.toBe(
      computeFingerprint("Acme", "Junior Engineer")
    );
  });

  test("same job cross-source still collides (dedup keeps working)", () => {
    expect(computeFingerprint("Acme Inc.", "Senior Platform Engineer")).toBe(
      computeFingerprint("Acme", "Senior Platform Engineer - Remote")
    );
  });

  test("'Unknown'-company jobs fall back to source+source_id identity", () => {
    const a = computeFingerprint("Unknown", "Platform Engineer", {
      source: "nodesk",
      sourceId: "/remote-jobs/alpha/",
    });
    const b = computeFingerprint("Unknown", "Platform Engineer", {
      source: "nodesk",
      sourceId: "/remote-jobs/beta/",
    });
    expect(a).not.toBe(b);
  });

  test("empty company also falls back to identity", () => {
    const a = computeFingerprint("", "Engineer", { source: "weworkremotely", sourceId: "guid-1" });
    const b = computeFingerprint("", "Engineer", { source: "weworkremotely", sourceId: "guid-2" });
    expect(a).not.toBe(b);
  });
});

describe("runDedup integration", () => {
  test("cross-source duplicates are marked; Unknown-company jobs never collapse", () => {
    const db = openDatabase(":memory:");

    const jobs: RawJob[] = [
      { source: "remoteok", source_id: "r1", title: "Senior Platform Engineer", company: "Acme" },
      {
        source: "remotive",
        source_id: "v1",
        title: "Senior Platform Engineer - Remote",
        company: "Acme Inc.",
      },
      {
        source: "nodesk",
        source_id: "/remote-jobs/alpha/",
        title: "Platform Engineer",
        company: "Unknown",
      },
      {
        source: "nodesk",
        source_id: "/remote-jobs/beta/",
        title: "Platform Engineer",
        company: "Unknown",
      },
    ];
    ingestJobs(db, jobs);

    const stats = runDedup(db);
    expect(stats.duplicates_found).toBe(1);

    const dupes = db.query("SELECT COUNT(*) AS c FROM jobs WHERE is_duplicate = 1").get() as {
      c: number;
    };
    expect(dupes.c).toBe(1);

    // Both Unknown-company jobs stay visible
    const unknowns = db
      .query("SELECT COUNT(*) AS c FROM jobs WHERE company = 'Unknown' AND is_duplicate = 0")
      .get() as { c: number };
    expect(unknowns.c).toBe(2);

    db.close();
  });
});
