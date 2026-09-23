/**
 * The human rendering of `brain stats` — the layered health/inventory
 * sections, the capped breakdowns and `--all`.
 *
 * Three layers, because no single one covers the claims:
 *   - a golden over `fixtures/corpus/` indexed in-process with an injected
 *     clock, so the health section's figures cannot drift as the wall clock
 *     passes the fixture's reference date;
 *   - unit tests over a hand-built `BrainStats` for the arithmetic of the cap
 *     and for every `null` path, which a fixture cannot stage; and
 *   - CLI spawns for the claims that are about the command rather than the
 *     formatter: `--all`, `--help`, `--json` ignoring `--all`, and the
 *     empty-brain state.
 *
 * Keyless and network-free throughout.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { cpSync, mkdtempSync, rmSync, symlinkSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";

import {
  BREAKDOWN_CAP,
  formatStats,
  staleThresholdsFor,
  type StaleThresholds,
} from "../src/cli/commands/stats";
import { DEFAULT_STATS_THRESHOLDS } from "../src/lib/config";
import { initContext } from "../src/lib/context";
import { openDatabase } from "../src/lib/db";
import { indexAll } from "../src/lib/indexer";
import { collectStats, type BrainStats } from "../src/lib/stats";
import { buildTaxonomy, type Taxonomy } from "../src/lib/taxonomy";
import { cleanup, makeTempBrain, runCli } from "./cli-harness";

const CORE_ROOT = resolve(import.meta.dir, "..");
const FIXTURE_CORPUS = join(CORE_ROOT, "fixtures/corpus");
const REPO_NODE_MODULES = resolve(CORE_ROOT, "../../node_modules");

// The same injected wall clock as stats.test.ts and auditor.test.ts: every
// age in this file is measured against it, so the stale golden holds forever.
const NOW = new Date("2026-07-01T00:00:00Z");

const temps: string[] = [];
afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Golden over the fixture corpus
// ---------------------------------------------------------------------------

describe("formatStats over fixtures/corpus", () => {
  let stats: BrainStats;
  let stale: StaleThresholds;
  let db: Database;

  beforeAll(async () => {
    const root = mkdtempSync(join(tmpdir(), "brain-stats-out-"));
    temps.push(root);
    cpSync(FIXTURE_CORPUS, root, { recursive: true });
    symlinkSync(REPO_NODE_MODULES, join(root, "node_modules"));

    const ctx = await initContext({ root });
    const writable = openDatabase(ctx.dbPath);
    await indexAll(writable, { root, taxonomy: ctx.taxonomy, quiet: true });
    writable.close();

    db = openDatabase(ctx.dbPath, { readonly: true });
    stats = await collectStats(db, {
      root,
      dbPath: ctx.dbPath,
      taxonomy: ctx.taxonomy,
      config: ctx.config,
      now: NOW,
    });
    stale = staleThresholdsFor(ctx.taxonomy);
  });

  afterAll(() => db?.close());

  // The layout golden. Corpus bytes, index bytes and free space are left out:
  // they measure the machine, not the fixture, and are asserted separately.
  test("renders the health section above the inventory section", () => {
    const out = formatStats(stats, { all: false, stale });
    const body = out.slice(0, out.indexOf("  Corpus:"));

    expect(body).toBe(
      [
        "Brain Statistics",
        "",
        "Health",
        "",
        "  Broken links:       2 of 37 (5.4%), over the 5.0% ceiling",
        "  Embedding coverage: n/a — not measured (floor 90.0%)",
        "  Stale:              2 — past their type's staleDays (context 30, health 60, project 90, else 180)",
        "  Orphans:            1 — no wiki-link in either direction",
        "  Untagged:           1 — no tags (archived excluded)",
        "",
        "Inventory",
        "",
        "  Documents: 25",
        "  By type:",
        "    project: 6",
        "    identity: 4",
        "    health: 3",
        "    note: 3",
        "    study: 3",
        "    +3 more (6 documents)",
        "  By status:",
        "    active: 23",
        "    archived: 1",
        "    draft: 1",
        "  By relevance:",
        "    primary: 16",
        "    secondary: 8",
        "    historical: 1",
        "  Tags: 43",
        "  Links: 37 (2 broken)",
        "  Chunks: 27",
        "",
      ].join("\n")
    );

    // Health comes first, and nothing of it leaks into the inventory.
    expect(out.indexOf("\nHealth\n")).toBeLessThan(out.indexOf("\nInventory\n"));
    for (const figure of ["Broken links:", "Embedding coverage:", "Stale:", "Orphans:", "Untagged:"]) {
      expect(out.slice(out.indexOf("\nInventory\n"))).not.toContain(figure);
    }
  });

  // Every figure the health section prints is one collectStats returned — no
  // recomputation in the renderer.
  test("every health figure is one collectStats measured", () => {
    const out = formatStats(stats, { all: false, stale });
    const health = out.slice(out.indexOf("Health"), out.indexOf("Inventory"));

    expect(health).toContain(`${stats.brokenLinks} of ${stats.links}`);
    expect(health).toContain(`Stale:              ${stats.health.stale} `);
    expect(health).toContain(`Orphans:            ${stats.health.orphans} `);
    expect(health).toContain(`Untagged:           ${stats.health.untagged} `);
    expect(stats.health.thresholds).toEqual(DEFAULT_STATS_THRESHOLDS);
  });

  test("the size figures render at a readable scale, never as 0.0 MB", () => {
    const out = formatStats(stats, { all: false, stale });
    expect(out).toMatch(/\n {2}Corpus: \d+ files, [\d.]+ (B|KB|MB|GB|TB)\n/);
    expect(out).toMatch(/\n {2}Index: [\d.]+ (B|KB|MB|GB|TB)\n/);
    expect(out).toMatch(/\n {2}Free space: [\d.]+ (B|KB|MB|GB|TB)$/);
    expect(out).not.toContain("0.0 MB");
  });

  test("--all expands every breakdown and drops the remainder line", () => {
    const capped = formatStats(stats, { all: false, stale });
    const all = formatStats(stats, { all: true, stale });

    expect(capped).toContain("+3 more (6 documents)");
    expect(all).not.toContain("more (");
    for (const type of Object.keys(stats.byType)) {
      expect(all).toContain(`\n    ${type}: ${stats.byType[type]}`);
    }
    expect(Object.keys(stats.byType).length).toBeGreaterThan(BREAKDOWN_CAP);
  });

  test("the stale line names the fixture's per-type windows, not just the default", () => {
    const out = formatStats(stats, { all: false, stale });
    // fixtures/corpus overrides health (60) and project (90); context (30)
    // comes from the core types; everything else falls back to 180.
    expect(out).toContain("health 60");
    expect(out).toContain("project 90");
    expect(out).toContain("context 30");
    expect(out).toContain("else 180");
  });
});

// ---------------------------------------------------------------------------
// The cap, and the null paths a fixture cannot stage
// ---------------------------------------------------------------------------

const STALE: StaleThresholds = { perType: [{ type: "health", days: 60 }], defaultDays: 180 };

function statsWith(overrides: Partial<BrainStats> = {}): BrainStats {
  return {
    documents: 10,
    byType: { note: 6, health: 4 },
    byStatus: { active: 10 },
    byRelevance: { primary: 10 },
    tags: 5,
    links: 4,
    brokenLinks: 0,
    chunks: 12,
    embeddings: 12,
    health: {
      brokenLinkRate: 0,
      embeddingCoverage: 1,
      stale: 0,
      orphans: 0,
      untagged: 0,
      thresholds: DEFAULT_STATS_THRESHOLDS,
    },
    size: {
      corpus: { bytes: 2048, files: 10 },
      db: { bytes: 4096, tables: { documents: 10 } },
      freeBytes: 1024 * 1024 * 1024,
    },
    ...overrides,
  };
}

describe("capped breakdowns", () => {
  const byType = { a: 30, b: 12, c: 9, d: 7, e: 6, f: 5, g: 4, h: 3, i: 2, j: 1 };
  const documents = Object.values(byType).reduce((a, b) => a + b, 0);

  test("keeps the top five and sums the rest into +N more", () => {
    const out = formatStats(statsWith({ byType, documents }), { all: false, stale: STALE });
    const rows = out
      .slice(out.indexOf("  By type:"))
      .split("\n")
      .slice(1, 1 + BREAKDOWN_CAP);

    expect(rows).toEqual(["    a: 30", "    b: 12", "    c: 9", "    d: 7", "    e: 6"]);
    // 5 remaining values: 5 + 4 + 3 + 2 + 1 = 15.
    expect(out).toContain("    +5 more (15 documents)");
    expect(out).not.toContain("    f: 5");
  });

  test("ranks by count even when the keys are integer-like", () => {
    // Object.entries puts integer-like keys first in ascending numeric order,
    // so the SQL's ORDER BY count DESC does not survive the trip through
    // `--json`. The renderer re-sorts, or the cap would keep the wrong five.
    const numeric = { "2024": 1, "2025": 2, alpha: 99, beta: 50 };
    const out = formatStats(statsWith({ byStatus: numeric, documents: 152 }), {
      all: false,
      stale: STALE,
    });
    const rows = out.slice(out.indexOf("  By status:")).split("\n").slice(1, 5);
    expect(rows).toEqual(["    alpha: 99", "    beta: 50", "    2025: 2", "    2024: 1"]);
  });

  test("exactly five values print no remainder line", () => {
    const five = { a: 5, b: 4, c: 3, d: 2, e: 1 };
    const out = formatStats(statsWith({ byType: five, documents: 15 }), { all: false, stale: STALE });
    expect(out).not.toContain("more (");
  });

  test("a single remaining value is singular", () => {
    const six = { a: 6, b: 5, c: 4, d: 3, e: 2, f: 1 };
    const out = formatStats(statsWith({ byType: six, documents: 21 }), { all: false, stale: STALE });
    expect(out).toContain("+1 more (1 document)");
  });

  test("an empty breakdown says none rather than printing a headless list", () => {
    const out = formatStats(statsWith({ byRelevance: {} }), { all: false, stale: STALE });
    expect(out).toContain("  By relevance: none");
  });
});

describe("null figures never read as a number", () => {
  test("an unknowable broken-link rate is n/a with no verdict", () => {
    const out = formatStats(
      statsWith({
        links: 0,
        brokenLinks: 0,
        health: { ...statsWith().health, brokenLinkRate: null },
      }),
      { all: false, stale: STALE }
    );
    expect(out).toContain("  Broken links:       n/a — no links to judge (ceiling 5.0%)");
    expect(out).not.toContain("Broken links:       0 of 0");
    expect(out).not.toMatch(/Broken links:.*(within|over) the/);
  });

  test("an unknowable embedding coverage is n/a, never a passing ratio", () => {
    const out = formatStats(
      statsWith({ embeddings: 0, health: { ...statsWith().health, embeddingCoverage: null } }),
      { all: false, stale: STALE }
    );
    expect(out).toContain("  Embedding coverage: n/a — not measured (floor 90.0%)");
    expect(out).not.toMatch(/Embedding coverage:.*(meets|below) the/);
    expect(out).not.toContain("Embedding coverage: 0.0%");
    // And it must not claim the opposite either. `collectStats` returns null
    // both for a brain that does not embed and for one whose vec_chunks could
    // not be counted; "nothing embedded" would be a false claim in the second
    // case, where the index may hold every vector it should.
    expect(out).not.toMatch(/Embedding coverage:.*(nothing|no) embed/i);
  });

  test("unknowable sizes are n/a, not 0", () => {
    const out = formatStats(
      statsWith({
        size: { corpus: null, db: { bytes: null, tables: {} }, freeBytes: null },
      }),
      { all: false, stale: STALE }
    );
    expect(out).toContain("  Corpus: n/a");
    expect(out).toContain("  Index: n/a");
    expect(out).toContain("  Free space: n/a");
    expect(out).not.toContain("0 B");
  });

  // A standing guard rather than one more case: it holds for every health
  // line, including one a later change adds. Removing a null check lets the
  // comparison coerce: `null > ceiling` is false and renders "within" — an
  // unknown reading as a pass — while `null < floor` is true and renders
  // "below", an unknown reading as a failure. Both are the same defect, a
  // figure nobody could measure being given a verdict, so this guard tests
  // for the verdict rather than for either direction. A mutation run with
  // the guards deleted fails it.
  test("no health line ever pairs n/a with a verdict", () => {
    const allNull = formatStats(
      statsWith({
        links: 0,
        brokenLinks: 0,
        chunks: 0,
        embeddings: 0,
        health: { ...statsWith().health, brokenLinkRate: null, embeddingCoverage: null },
        size: { corpus: null, db: { bytes: null, tables: {} }, freeBytes: null },
      }),
      { all: false, stale: STALE }
    );

    const health = allNull.slice(allNull.indexOf("Health"), allNull.indexOf("Inventory"));
    const unknown = health.split("\n").filter((line) => line.includes("n/a"));
    expect(unknown.length).toBe(2); // brokenLinkRate + embeddingCoverage
    for (const line of unknown) {
      expect(line).not.toMatch(/\b(within|over|below|meets)\b/);
    }
  });

  test("a measurable figure still gets its verdict", () => {
    const over = formatStats(
      statsWith({
        links: 10,
        brokenLinks: 3,
        health: { ...statsWith().health, brokenLinkRate: 0.3, embeddingCoverage: 0.4 },
      }),
      { all: false, stale: STALE }
    );
    expect(over).toContain("  Broken links:       3 of 10 (30.0%), over the 5.0% ceiling");
    expect(over).toContain("  Embedding coverage: 40.0% of 12 chunks, below the 90.0% floor");

    const within = formatStats(statsWith(), { all: false, stale: STALE });
    expect(within).toContain("  Broken links:       0 of 4 (0.0%), within the 5.0% ceiling");
    expect(within).toContain("  Embedding coverage: 100.0% of 12 chunks, meets the 90.0% floor");
  });
});

describe("empty brain", () => {
  test("prints a next step, not NaN or a division by zero", () => {
    const out = formatStats(
      statsWith({
        documents: 0,
        byType: {},
        byStatus: {},
        byRelevance: {},
        tags: 0,
        links: 0,
        brokenLinks: 0,
        chunks: 0,
        embeddings: 0,
        health: {
          brokenLinkRate: null,
          embeddingCoverage: null,
          stale: 0,
          orphans: 0,
          untagged: 0,
          thresholds: DEFAULT_STATS_THRESHOLDS,
        },
      }),
      { all: false, stale: STALE }
    );
    expect(out).toBe(
      "Brain Statistics\n\n  No documents indexed. Add markdown under the brain root, then run `brain index`."
    );
    expect(out).not.toContain("NaN");
    expect(out).not.toContain("Infinity");
  });
});

describe("staleThresholdsFor", () => {
  // The golden over fixtures/corpus cannot catch this: its three windows
  // (30/60/90) are all distinct, so the tie-break never runs there.
  test("types sharing a window tie-break by code unit, not by locale", () => {
    const taxonomy: Taxonomy = buildTaxonomy({
      user: {
        taxonomy: {
          types: {
            Zeta: { dir: "zeta", staleDays: 60 },
            alpha: { dir: "alpha", staleDays: 60 },
            beta: { dir: "beta", staleDays: 60 },
          },
        },
      },
    });

    expect(staleThresholdsFor(taxonomy).perType).toEqual([
      { type: "context", days: 30 },
      { type: "Zeta", days: 60 },
      { type: "alpha", days: 60 },
      { type: "beta", days: 60 },
    ]);
  });

  test("names the types carrying a window, shortest first, and the fallback", () => {
    const taxonomy: Taxonomy = buildTaxonomy({
      user: {
        taxonomy: {
          types: {
            health: { dir: "health", staleDays: 60 },
            project: { dir: "projects", staleDays: 90 },
            // A window on a type with no directory never matches a path, so
            // it is not a window anything is judged against.
            floating: { dir: null, staleDays: 7 },
            study: { dir: "studies" },
          },
        },
      },
    });

    expect(staleThresholdsFor(taxonomy)).toEqual({
      perType: [
        { type: "context", days: 30 },
        { type: "health", days: 60 },
        { type: "project", days: 90 },
      ],
      defaultDays: 180,
    });
  });
});

// ---------------------------------------------------------------------------
// The command, spawned
// ---------------------------------------------------------------------------

describe("brain stats (spawned)", () => {
  let root: string;

  beforeAll(async () => {
    root = makeTempBrain();
    const idx = await runCli(root, ["index", "--json"]);
    expect(idx.code).toBe(0);
  });

  afterAll(() => cleanup(root));

  test("caps each breakdown and offers --all", async () => {
    const capped = await runCli(root, ["stats", "--human"]);
    expect(capped.code).toBe(0);
    expect(capped.stdout).toContain("+3 more (6 documents)");
    expect(capped.stdout.split("\n").filter((l) => /^ {4}\w+: \d+$/.test(l)).length).toBe(
      BREAKDOWN_CAP + 3 + 3 // type rows capped at 5; status and relevance have 3 each
    );

    const all = await runCli(root, ["stats", "--all", "--human"]);
    expect(all.code).toBe(0);
    expect(all.stdout).not.toContain("more (");
    for (const type of ["context", "index", "journal"]) {
      expect(capped.stdout).not.toMatch(new RegExp(`^ {4}${type}: `, "m"));
      expect(all.stdout).toMatch(new RegExp(`^ {4}${type}: `, "m"));
    }
  });

  test("--all does not reach --json", async () => {
    const plain = await runCli(root, ["stats", "--json"]);
    const all = await runCli(root, ["stats", "--all", "--json"]);
    expect(plain.code).toBe(0);
    expect(all.code).toBe(0);

    // Byte-identical but for free space, which measures the volume rather than
    // the brain and can move between two subprocesses on a busy machine.
    const normalize = (s: string) => s.replace(/"freeBytes": \d+/, '"freeBytes": <volume>');
    expect(normalize(all.stdout)).toBe(normalize(plain.stdout));

    // And both carry the uncapped breakdowns.
    for (const out of [plain.stdout, all.stdout]) {
      const parsed = JSON.parse(out);
      expect(Object.keys(parsed.byType).length).toBe(8);
      expect(out).not.toContain("more (");
    }
  });

  // --all is in the global BOOLEAN_FLAGS set, which predates this change and
  // is shared with `brain process --all`. These are the parser interactions
  // that set creates for `stats`.
  test("--all parses like every other boolean flag", async () => {
    // Piped stdout defaults to JSON, so `--all` alone must not turn on human
    // output or be mistaken for a value flag swallowing the next argument.
    const bare = await runCli(root, ["stats", "--all"]);
    expect(bare.code).toBe(0);
    expect(() => JSON.parse(bare.stdout)).not.toThrow();

    // After a bare `--`, "--all" is a positional, not a flag: the human output
    // stays capped.
    const afterSeparator = await runCli(root, ["stats", "--human", "--", "--all"]);
    expect(afterSeparator.code).toBe(0);
    expect(afterSeparator.stdout).toContain("+3 more (6 documents)");

    // And a genuine typo is still a usage error rather than a silent no-op.
    expect((await runCli(root, ["stats", "--alll"])).code).toBe(1);
  });

  test("--help documents --all and the cap", async () => {
    const { stdout, code } = await runCli(root, ["stats", "--help"]);
    expect(code).toBe(0);
    expect(stdout).toContain("--all");
    expect(stdout).toContain(`top\n                          ${BREAKDOWN_CAP} by count`);
    expect(stdout).toContain("+N more");
    expect(stdout).toContain(`coverageFloor ${DEFAULT_STATS_THRESHOLDS.coverageFloor}`);
    expect(stdout).toContain(`brokenLinkCeiling ${DEFAULT_STATS_THRESHOLDS.brokenLinkCeiling}`);
    expect(stdout).toContain("staleDays");
    expect(stdout).toContain("unaffected by --all");
    // The pre-#169 caveat — `embeddings` reading 0 for a count it could not
    // take — is gone with the behaviour it described.
    expect(stdout).not.toContain("read it, not the row");
    expect(stdout).toContain("reads `n/a` when the brain has a vector table");
  });

  test("a brain with no documents prints an empty state, not NaN", async () => {
    const empty = makeTempBrain({ empty: true });
    try {
      expect((await runCli(empty, ["init", "--default", "--json"])).code).toBe(0);
      rmSync(join(empty, "_index.md"));
      expect((await runCli(empty, ["index", "--force", "--json"])).code).toBe(0);

      const { stdout, code } = await runCli(empty, ["stats", "--human"]);
      expect(code).toBe(0);
      expect(stdout.trim()).toBe(
        "Brain Statistics\n\n  No documents indexed. Add markdown under the brain root, then run `brain index`."
      );
      expect(stdout).not.toContain("NaN");
    } finally {
      cleanup(empty);
    }
  });
});

describe("the stale line with no per-type windows", () => {
  test("names the default window alone, not an empty exception list", () => {
    const out = formatStats(statsWith(), {
      all: false,
      stale: { perType: [], defaultDays: 180 },
    });
    expect(out).toContain("past their type's staleDays (180)");
    expect(out).not.toContain("else 180");
  });
});

describe("an embeddings count that could not be taken reads as unknown", () => {
  // `embeddings` is null when vec_chunks exists but could not be counted
  // (#169). Until then it was emitted as `embeddingCount ?? 0`, so such a brain
  // rendered exactly like one holding no vectors and only the coverage line
  // told them apart. The row is suppressed at 0; null must neither vanish with
  // it nor print as a number.
  test("a null count prints an n/a row, never 0 and never NaN", () => {
    const uncounted = statsWith({
      embeddings: null,
      chunks: 12,
      health: { ...statsWith().health, embeddingCoverage: null },
    });
    const out = formatStats(uncounted, { all: false, stale: STALE });

    expect(out).toMatch(/^ {2}Embeddings: n\/a — vector table could not be read on this host$/m);
    expect(out).not.toMatch(/Embeddings: (0|null|NaN)\b/);
    expect(out).toContain("  Embedding coverage: n/a — not measured (floor 90.0%)");
  });

  test("a brain holding no vectors still prints no row, so the two no longer render alike", () => {
    const none = statsWith({
      embeddings: 0,
      chunks: 12,
      health: { ...statsWith().health, embeddingCoverage: null },
    });
    const noneOut = formatStats(none, { all: false, stale: STALE });
    expect(noneOut).not.toMatch(/^ {2}Embeddings:/m);

    const uncounted = formatStats(statsWith({ ...none, embeddings: null }), { all: false, stale: STALE });
    expect(uncounted).not.toBe(noneOut);
  });

  test("a brain with no documents still says its vector count is unknown", () => {
    // The empty state returns before the inventory, where the n/a row lives.
    // A leftover vector table this host cannot read must not vanish with it.
    const empty = { documents: 0, byType: {}, byStatus: {}, byRelevance: {}, chunks: 0 };
    const unknown = formatStats(statsWith({ ...empty, embeddings: null }), { all: false, stale: STALE });
    const none = formatStats(statsWith({ ...empty, embeddings: 0 }), { all: false, stale: STALE });

    expect(unknown).toContain("No documents indexed.");
    expect(unknown).toMatch(/^ {2}Embeddings: n\/a — vector table could not be read on this host$/m);
    expect(none).not.toMatch(/Embeddings:/);
    // --all changes nothing about it.
    expect(formatStats(statsWith({ ...empty, embeddings: null }), { all: true, stale: STALE })).toBe(unknown);
  });

  test("a counted brain does show the row", () => {
    const out = formatStats(statsWith({ embeddings: 12 }), { all: false, stale: STALE });
    expect(out).toMatch(/^ {2}Embeddings: 12$/m);
  });
});

describe("a ratio next to its threshold never reads as the same number", () => {
  // Both verdicts below are right (6/119 = 0.0504 > 0.05; 4498/5000 = 0.8996
  // < 0.9), but at one decimal the ratio and its threshold printed as the same
  // figure, so the line appeared to contradict itself (#171). The fix is
  // display-only: the verdict still compares the unrounded values. Rounding
  // before comparing would make it wrong instead, and that is the rejected fix.
  const line = (out: string, label: string) =>
    out.split("\n").find((l) => l.startsWith(`  ${label}:`)) ?? "";

  /** The ratio and the threshold as printed on a health line, and its verdict word. */
  function parts(text: string): { ratio: string; verdict: string; threshold: string } {
    // Whole tokens only: a sign or an exponent must fail the match, not be
    // cut off so the digits after it pass for the number.
    const m = text.match(
      /(?:\(|: )(\d+\.\d+)%\)?(?: of [^,]+)?, (\w+) the (\d+\.\d+)% (?:ceiling|floor)$/
    );
    if (!m) throw new Error(`not a judged health line: ${text}`);
    return { ratio: m[1], verdict: m[2], threshold: m[3] };
  }

  test("a broken-link rate just over its ceiling shows a different number, and is still over", () => {
    const out = formatStats(
      statsWith({
        brokenLinks: 6,
        links: 119,
        health: { ...statsWith().health, brokenLinkRate: 6 / 119 },
      }),
      { all: false, stale: STALE }
    );
    const broken = parts(line(out, "Broken links"));

    expect(broken.verdict).toBe("over");
    expect(broken.ratio).not.toBe(broken.threshold);
    expect(Number(broken.ratio)).toBeGreaterThan(Number(broken.threshold));
    expect(line(out, "Broken links")).toBe("  Broken links:       6 of 119 (5.04%), over the 5.00% ceiling");
  });

  test("a coverage just below its floor shows a different number, and is still below", () => {
    const out = formatStats(
      statsWith({
        embeddings: 4498,
        chunks: 5000,
        health: { ...statsWith().health, embeddingCoverage: 4498 / 5000 },
      }),
      { all: false, stale: STALE }
    );
    const coverage = parts(line(out, "Embedding coverage"));

    expect(coverage.verdict).toBe("below");
    expect(coverage.ratio).not.toBe(coverage.threshold);
    expect(Number(coverage.ratio)).toBeLessThan(Number(coverage.threshold));
    expect(line(out, "Embedding coverage")).toBe(
      "  Embedding coverage: 89.96% of 5000 chunks, below the 90.00% floor"
    );
  });

  test("as many digits as it takes, for ratios arbitrarily close", () => {
    // 1 broken link in 19,999 over a 1/20,000 ceiling: the two first differ
    // at the seventh decimal of the percentage.
    const ceiling = 1 / 20_000;
    const rate = 1 / 19_999;
    const out = formatStats(
      statsWith({
        brokenLinks: 1,
        links: 19_999,
        health: {
          ...statsWith().health,
          brokenLinkRate: rate,
          thresholds: { ...DEFAULT_STATS_THRESHOLDS, brokenLinkCeiling: ceiling },
        },
      }),
      { all: false, stale: STALE }
    );
    const broken = parts(line(out, "Broken links"));
    expect(broken.verdict).toBe("over");
    expect(broken.ratio).not.toBe(broken.threshold);
    expect(Number(broken.ratio)).toBeGreaterThan(Number(broken.threshold));
  });

  test("a ratio one ulp over a ceiling that `ratio * 100` rounds onto it still reads as bigger", () => {
    // 0.007 and the next double up are different ratios, but both times 100
    // are the same double, so widening `(ratio * 100).toFixed(n)` could never
    // separate them.
    const ceiling = 0.007;
    const bits = new Float64Array([ceiling]);
    new BigInt64Array(bits.buffer)[0] += 1n;
    const rate = bits[0];
    expect(rate).toBeGreaterThan(ceiling);
    expect(rate * 100).toBe(ceiling * 100);

    const out = formatStats(
      statsWith({
        health: {
          ...statsWith().health,
          brokenLinkRate: rate,
          thresholds: { ...DEFAULT_STATS_THRESHOLDS, brokenLinkCeiling: ceiling },
        },
      }),
      { all: false, stale: STALE }
    );
    const broken = parts(line(out, "Broken links"));
    expect(broken.verdict).toBe("over");
    expect(broken.ratio).not.toBe(broken.threshold);
    // Compared as decimal strings of equal length: Number() would collapse them again.
    expect(broken.ratio.length).toBe(broken.threshold.length);
    expect(broken.ratio > broken.threshold).toBe(true);
  });

  test("pairs twenty places cannot separate still read as different numbers", () => {
    // Found in review: the widening stopped at twenty places whether or not
    // the two had come apart.
    const next = (x: number, by: 1n | -1n) => {
      const bits = new Float64Array([x]);
      new BigInt64Array(bits.buffer)[0] += by;
      return bits[0];
    };
    const rate = 1 / 2_097_165;
    const cases = [
      // One link in 2,097,165 over a ceiling one double below it: `* 100`
      // collapses the pair, and 22 places of the ratios cannot tell them apart.
      { label: "Broken links", rate, ceiling: next(rate, -1n), verdict: "over" },
    ];
    for (const { label, rate: r, ceiling, verdict } of cases) {
      const out = formatStats(
        statsWith({
          brokenLinks: 1,
          links: 2_097_165,
          health: {
            ...statsWith().health,
            brokenLinkRate: r,
            thresholds: { ...DEFAULT_STATS_THRESHOLDS, brokenLinkCeiling: ceiling },
          },
        }),
        { all: false, stale: STALE }
      );
      const got = parts(line(out, label));
      expect(got.verdict).toBe(verdict);
      expect(got.ratio).not.toBe(got.threshold);
      expect(got.ratio.length).toBe(got.threshold.length);
      expect(got.ratio > got.threshold).toBe(true);
    }

    // No coverage at all under a tiny floor: (0 * 100).toFixed(20) and
    // (1e-28).toFixed(20) are both zeros, and past 1e-100 so is any toFixed.
    // Number.MIN_VALUE is the extreme: a subnormal, still a valid floor.
    for (const floor of [1e-30, 1e-110, Number.MIN_VALUE]) {
      const out = formatStats(
        statsWith({
          embeddings: 0,
          chunks: 5000,
          health: {
            ...statsWith().health,
            embeddingCoverage: 0,
            thresholds: { ...DEFAULT_STATS_THRESHOLDS, coverageFloor: floor },
          },
        }),
        { all: false, stale: STALE }
      );
      const coverage = parts(line(out, "Embedding coverage"));
      expect(coverage.verdict).toBe("below");
      expect(coverage.ratio).not.toBe(coverage.threshold);
      expect(coverage.ratio.length).toBe(coverage.threshold.length);
      expect(coverage.ratio < coverage.threshold).toBe(true);
    }
  });

  test("the line parser refuses a signed or exponent figure instead of reading its tail", () => {
    expect(() => parts("  Embedding coverage: 1e+21% of 1 chunk, meets the 100.0% floor")).toThrow();
    expect(() => parts("  Broken links:       1 of 2 (-2.0%), within the 5.0% ceiling")).toThrow();
    expect(() => parts("  Broken links:       1 of 2 (2.0%), within the -5.0% ceiling")).toThrow();
    expect(() => parts("  Embedding coverage: 50.0% of 1 chunk, meets the 1e-5% floor")).toThrow();
    expect(parts("  Broken links:       1 of 2 (5.04%), over the 5.00% ceiling")).toEqual({
      ratio: "5.04",
      verdict: "over",
      threshold: "5.00",
    });
  });

  test("a threshold configured finer than one decimal is not shown rounded past the ratio", () => {
    // Ceiling 5.25%, rate 5.28%: at one decimal both read 5.3%. Widening only
    // the ratio would print "5.28%, over the 5.3% ceiling" — a smaller number
    // called over a bigger one.
    const out = formatStats(
      statsWith({
        brokenLinks: 528,
        links: 10_000,
        health: {
          ...statsWith().health,
          brokenLinkRate: 0.0528,
          thresholds: { ...DEFAULT_STATS_THRESHOLDS, brokenLinkCeiling: 0.0525 },
        },
      }),
      { all: false, stale: STALE }
    );
    const broken = parts(line(out, "Broken links"));
    expect(broken.verdict).toBe("over");
    expect(Number(broken.ratio)).toBeGreaterThan(Number(broken.threshold));
  });

  test("the verdict still compares unrounded values: rounding never loosens a threshold", () => {
    // Each of these rounds to its threshold at one decimal. Comparing at
    // display precision would call them within / meets.
    for (const rate of [0.05004, 0.0500001]) {
      const out = formatStats(
        statsWith({ health: { ...statsWith().health, brokenLinkRate: rate } }),
        { all: false, stale: STALE }
      );
      expect(parts(line(out, "Broken links")).verdict).toBe("over");
    }
    for (const coverage of [0.89996, 0.8999999]) {
      const out = formatStats(
        statsWith({ health: { ...statsWith().health, embeddingCoverage: coverage } }),
        { all: false, stale: STALE }
      );
      expect(parts(line(out, "Embedding coverage")).verdict).toBe("below");
    }
  });

  test("a ratio exactly at its threshold, or nowhere near it, keeps one decimal", () => {
    const at = formatStats(
      statsWith({
        brokenLinks: 5,
        links: 100,
        embeddings: 90,
        chunks: 100,
        health: { ...statsWith().health, brokenLinkRate: 0.05, embeddingCoverage: 0.9 },
      }),
      { all: false, stale: STALE }
    );
    expect(line(at, "Broken links")).toBe("  Broken links:       5 of 100 (5.0%), within the 5.0% ceiling");
    expect(line(at, "Embedding coverage")).toBe("  Embedding coverage: 90.0% of 100 chunks, meets the 90.0% floor");

    const far = formatStats(
      statsWith({
        brokenLinks: 2,
        links: 37,
        health: { ...statsWith().health, brokenLinkRate: 2 / 37, embeddingCoverage: 0.5 },
      }),
      { all: false, stale: STALE }
    );
    expect(line(far, "Broken links")).toBe("  Broken links:       2 of 37 (5.4%), over the 5.0% ceiling");
    expect(line(far, "Embedding coverage")).toBe("  Embedding coverage: 50.0% of 12 chunks, below the 90.0% floor");
  });
});

describe("byte scaling", () => {
  // Boundaries: the last value that stays in a unit, and the first that steps up.
  const cases: [number, string][] = [
    [0, "0 B"],
    [1, "1 B"],
    [1023, "1023 B"],
    [1024, "1.0 KB"],
    [1_048_575, "1024.0 KB"],
    [1_048_576, "1.0 MB"],
    [22_231, "21.7 KB"],
    [1024 ** 4 * 3, "3.0 TB"],
    // Nothing scales past TB — a petabyte reads as 1024 TB rather than an
    // invented unit.
    [1024 ** 5, "1024.0 TB"],
  ];

  for (const [count, rendered] of cases) {
    test(`${count} bytes renders as ${rendered}`, () => {
      const out = formatStats(statsWith({ size: { corpus: null, db: { bytes: count, tables: {} }, freeBytes: null } }), {
        all: false,
        stale: STALE,
      });
      expect(out).toContain(`  Index: ${rendered}\n`);
    });
  }
});

describe("ordering is not locale-dependent", () => {
  // The cap makes the tie-break decide which rows print at all, so it must
  // give the same answer under every runtime locale. Byte order does; a
  // locale-aware collation does not agree with it on case or on accents.
  test("ties break by code unit, the same answer under any ICU collation", () => {
    const tied = { Zeta: 3, alpha: 3, Ábra: 3, beta: 3, gamma: 3, delta: 3, epsilon: 3 };
    const out = formatStats(statsWith({ byType: tied, documents: 21 }), { all: false, stale: STALE });
    const rows = out.slice(out.indexOf("  By type:")).split("\n").slice(1, 1 + BREAKDOWN_CAP);
    expect(rows).toEqual(["    Zeta: 3", "    alpha: 3", "    beta: 3", "    delta: 3", "    epsilon: 3"]);
    expect(out).toContain("+2 more (6 documents)");
  });
});
