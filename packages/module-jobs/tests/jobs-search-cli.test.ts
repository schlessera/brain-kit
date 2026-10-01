import { afterAll, beforeAll, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { cleanup, makeTempBrain, runCli } from "../../core/tests/cli-harness";
import { openDatabase } from "../src/db";
import { ingestJobs } from "../src/scrape";
import type { JobRow, RawJob } from "../src/types";

const roots: string[] = [];
const packageRoot = resolve(import.meta.dir, "..");
afterAll(() => { for (const root of roots) cleanup(root); });

function fixture(seed = false, dbPath = "jobs.db"): string {
  const root = makeTempBrain({ empty: true });
  roots.push(root);
  const moduleDir = join(root, "modules/jobs");
  mkdirSync(moduleDir, { recursive: true });
  writeFileSync(join(moduleDir, "module.ts"),
    `export { default } from ${JSON.stringify(join(packageRoot, "src/module.ts"))};\n`);
  cpSync(join(packageRoot, "skills"), join(moduleDir, "skills"), { recursive: true });
  cpSync(join(packageRoot, "README.md"), join(moduleDir, "README.md"));
  writeFileSync(join(root, "brain.config.json"), JSON.stringify({
    modules: { "./modules/jobs": { criteria: "career/criteria.md", dbPath } },
  }));
  if (seed) {
    const path = join(root, dbPath);
    mkdirSync(dirname(path), { recursive: true });
    const db = openDatabase(path);
    try {
      const jobs: RawJob[] = Array.from({ length: 66 }, (_, i) => ({
        source: "remoteok", source_id: `ithaca-${i}`,
        title: `Ithaca navigation role ${String(i).padStart(2, "0")}`,
        company: "Ithaca Fleet", description: i === 0
          ? "Odysseus seeks a fictional navigation crew."
          : "Odysseus seeks a fictional sailing crew.",
        url: `https://example.com/jobs/ithaca-${i}`,
      }));
      expect(ingestJobs(db, jobs).new).toBe(66);
      db.exec("UPDATE jobs SET is_duplicate = 1 WHERE id = 66");
      // An ordering assertion over tied ranks would not detect reversing rank.
      const ranks = db.query("SELECT rank FROM jobs_fts WHERE jobs_fts MATCH 'navigation' ORDER BY rank LIMIT 2")
        .all() as { rank: number }[];
      expect(ranks).toHaveLength(2);
      expect(ranks[0]!.rank).toBeLessThan(ranks[1]!.rank);
    } finally { db.close(); }
  }
  return root;
}

let populated: string;
beforeAll(() => { populated = fixture(true); });

const invalidValues = [
  ["nonnumeric", "abc"], ["zero", "0"], ["negative", "-1"], ["fraction", "1.5"],
  ["infinity", "Infinity"], ["negative infinity", "-Infinity"], ["NaN", "NaN"],
  ["overflow", "1e309"], ["unsafe integer", "9007199254740992"],
  ["empty", ""], ["whitespace", " "],
] as const;

const invalidCases: readonly (readonly [string, readonly string[]])[] = [
  ...invalidValues.map(([name, value]) => [name, ["--limit", value, "--json"]] as const),
  ["missing at end", ["--json", "--limit"]],
  ["missing before a flag", ["--limit", "--json"]],
];

for (const [name, flags] of invalidCases) {
  for (const seeded of [false, true]) {
    test(`jobs search gives usage for ${name} with ${seeded ? "populated" : "absent"} database`, async () => {
      const root = seeded ? populated : fixture();
      const result = await runCli(root, ["jobs", "search", "navigation", ...flags]);
      expect(result.stderr).toContain("--limit must be a positive safe integer");
      expect(result.stderr).toContain("Usage: brain jobs search");
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).not.toMatch(/datatype mismatch|SQLITE|SQLiteError/);
    });
  }

  test(`jobs search does not create a database for ${name}`, async () => {
    const root = fixture();
    const path = join(root, "jobs.db");
    expect(existsSync(path)).toBe(false);
    const result = await runCli(root, ["jobs", "search", "navigation", ...flags]);
    // Keep this before the usage assertion: it independently observes opening
    // with CREATE, even when the later SQL query fails for the expected reason.
    expect(existsSync(path)).toBe(false);
    expect(result.code).toBe(1);
  });
}

for (const [name, flags, count] of [
  ["default", [], 20], ["one", ["--limit", "1"], 1],
  ["two", ["--limit", "2"], 2], ["above default", ["--limit", "25"], 25],
  ["above review tool cap", ["--limit", "60"], 60],
  ["largest safe integer", ["--limit", String(Number.MAX_SAFE_INTEGER)], 65],
  ["existing numeric notation", ["--limit", "1e1"], 10],
] as const) {
  test(`jobs search preserves the nonempty JSON envelope and order for ${name}`, async () => {
    const result = await runCli(populated, ["jobs", "search", "navigation", ...flags, "--json"]);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    const body = JSON.parse(result.stdout) as { query: string; results: JobRow[] };
    expect(Object.keys(body).sort()).toEqual(["query", "results"]);
    expect(body.query).toBe("navigation");
    expect(body.results.length).toBeGreaterThan(0);
    expect(body.results).toHaveLength(count);
    expect(body.results.map((job) => job.id)).toEqual(Array.from({ length: count }, (_, i) => i + 1));
    expect(body.results[0]).toMatchObject({ title: "Ithaca navigation role 00", company: "Ithaca Fleet" });
  });
}

test("jobs search preserves multiword queries and human output", async () => {
  const json = await runCli(populated, ["jobs", "search", "Ithaca", "navigation", "--limit", "2", "--json"]);
  expect(json.code).toBe(0);
  const body = JSON.parse(json.stdout) as { query: string; results: JobRow[] };
  expect(body.query).toBe("Ithaca navigation");
  expect(body.results.length).toBeGreaterThan(0);
  expect(body.results.map((job) => job.id)).toEqual([1, 2]);
  const human = await runCli(populated, ["jobs", "search", "navigation", "--limit", "2", "--human"]);
  expect(human.code).toBe(0);
  expect(human.stdout).toContain('Search results for "navigation": 2 jobs');
  expect(human.stdout.indexOf("Ithaca navigation role 00")).toBeGreaterThanOrEqual(0);
  expect(human.stdout.indexOf("Ithaca navigation role 01")).toBeGreaterThan(human.stdout.indexOf("Ithaca navigation role 00"));
});

test("invalid limits are refused before opening an existing corrupt database", async () => {
  const root = fixture();
  writeFileSync(join(root, "jobs.db"), "fictional corrupt database sentinel");
  const result = await runCli(root, ["jobs", "search", "navigation", "--limit", "abc", "--json"]);
  expect(result.stderr).toContain("--limit must be a positive safe integer");
  expect(result.code).toBe(1);
  expect(result.stdout).toBe("");
});

test("jobs search uses the configured database path", async () => {
  const root = fixture(true, "data/opportunities.db");
  const result = await runCli(root, ["jobs", "search", "navigation", "--limit", "2", "--json"]);
  expect(result.code).toBe(0);
  const body = JSON.parse(result.stdout) as { query: string; results: JobRow[] };
  expect(body.results.length).toBeGreaterThan(0);
  expect(body.results.map((job) => job.id)).toEqual([1, 2]);
  expect(existsSync(join(root, "jobs.db"))).toBe(false);
});

test("valid search retains initialization of an absent database and its empty envelope", async () => {
  const root = fixture();
  const result = await runCli(root, ["jobs", "search", "navigation", "--json"]);
  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ query: "navigation", results: [] });
  expect(existsSync(join(root, "jobs.db"))).toBe(true);
});
