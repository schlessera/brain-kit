/**
 * The stats history (#581): one snapshot per day in `.stats-history.jsonl`,
 * recorded by `brain maintain` and `brain stats --record`, read back by
 * `brain stats --history` as one series per field.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

import { cleanup, makeTempBrain, runCli } from "./cli-harness";
import {
  DAILY_DAYS,
  historySeries,
  parseHistory,
  readHistory,
  recordSnapshot,
  snapshotOf,
  STATS_HISTORY_FILE,
  thin,
  type StatsSnapshot,
} from "../src/lib/stats-history";
import type { BrainStats } from "../src/lib/stats";

const temps: string[] = [];
afterEach(() => {
  while (temps.length) cleanup(temps.pop()!);
});

function tempBrain(opts: { empty?: boolean } = {}): string {
  const root = makeTempBrain(opts);
  temps.push(root);
  return root;
}

function stats(overrides: Partial<BrainStats> = {}): BrainStats {
  return {
    documents: 10,
    byType: { note: 6, project: 4 },
    byStatus: { active: 10 },
    byRelevance: { primary: 10 },
    tags: 5,
    links: 20,
    brokenLinks: 1,
    chunks: 30,
    embeddings: 30,
    health: {
      brokenLinkRate: 0.05,
      embeddingCoverage: 1,
      stale: 2,
      orphans: 3,
      untagged: 1,
      thresholds: { coverageFloor: 0.9, brokenLinkCeiling: 0.05 },
    },
    size: {
      corpus: { bytes: 1000, files: 11 },
      db: { bytes: 4096, tables: { documents: 10, links: 20, chunks: 30 }, vectorSlots: { live: 30, allocated: 1024 } },
      freeBytes: 999,
    },
    ...overrides,
  };
}

const at = (iso: string) => new Date(`${iso}T03:00:00Z`);
const snap = (date: string, s: BrainStats = stats()) => snapshotOf(s, { now: at(date), version: "0.40.0" });

function lines(root: string): string[] {
  return readFileSync(join(root, STATS_HISTORY_FILE), "utf8").split("\n").filter(Boolean);
}

describe("snapshotOf", () => {
  test("keeps the counts, health ratios and size totals, and drops the thresholds", () => {
    const s = snap("2026-09-29");
    expect(s.date).toBe("2026-09-29");
    expect(s.at).toBe("2026-09-29T03:00:00.000Z");
    expect(s.version).toBe("0.40.0");
    expect(s.byType).toEqual({ note: 6, project: 4 });
    expect(s.health).toEqual({ brokenLinkRate: 0.05, embeddingCoverage: 1, stale: 2, orphans: 3, untagged: 1 });
    expect(s.health).not.toHaveProperty("thresholds");
    expect(s.size).toEqual({
      corpusBytes: 1000,
      corpusFiles: 11,
      dbBytes: 4096,
      // documents + links + chunks: the tables reduced to their total
      dbRows: 60,
      vectorsLive: 30,
      vectorsAllocated: 1024,
      freeBytes: 999,
    });
  });

  test("an unreadable corpus stays null, not 0", () => {
    const s = snap("2026-09-29", stats({ size: { ...stats().size, corpus: null } }));
    expect(s.size.corpusBytes).toBeNull();
    expect(s.size.corpusFiles).toBeNull();
  });
});

describe("recordSnapshot", () => {
  test("a second recording the same day replaces that day's entry", () => {
    const root = tempBrain({ empty: true });
    expect(recordSnapshot(root, snap("2026-09-28")).replaced).toBe(false);
    recordSnapshot(root, snap("2026-09-29", stats({ documents: 10 })));
    const second = recordSnapshot(root, snap("2026-09-29", stats({ documents: 12 })));
    expect(second).toEqual({ date: "2026-09-29", replaced: true, kept: 2, thinned: 0 });

    const stored = lines(root).map((l) => JSON.parse(l) as StatsSnapshot);
    expect(stored.map((s) => s.date)).toEqual(["2026-09-28", "2026-09-29"]);
    expect(stored[1].documents).toBe(12);
  });

  test("the file is one line per day, sorted by date, whatever order they were recorded in", () => {
    const root = tempBrain({ empty: true });
    recordSnapshot(root, snap("2026-09-29"));
    recordSnapshot(root, snap("2026-09-27"));
    recordSnapshot(root, snap("2026-09-28"));
    expect(lines(root).map((l) => JSON.parse(l).date)).toEqual(["2026-09-27", "2026-09-28", "2026-09-29"]);
    expect(readFileSync(join(root, STATS_HISTORY_FILE), "utf8").endsWith("}\n")).toBe(true);
  });

  test("refuses to rewrite a file with a line that is not a snapshot, and leaves it as it was", () => {
    const root = tempBrain({ empty: true });
    recordSnapshot(root, snap("2026-09-28"));
    const path = join(root, STATS_HISTORY_FILE);
    const conflicted = `<<<<<<< HEAD\n${readFileSync(path, "utf8")}=======\n>>>>>>> theirs\n`;
    writeFileSync(path, conflicted);
    expect(() => recordSnapshot(root, snap("2026-09-29"))).toThrow(/line 1 is not JSON/);
    expect(readFileSync(path, "utf8")).toBe(conflicted);
  });
});

describe("retention", () => {
  const days = (from: string, count: number) =>
    Array.from({ length: count }, (_, i) => ({
      date: new Date(Date.parse(`${from}T00:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10),
    }));

  test("keeps every day of the last 90, then the latest of each ISO week", () => {
    // 2026-03-02 is a Monday; 210 days runs to 2026-09-27.
    const all = days("2026-03-02", 210);
    const today = "2026-09-27";
    const kept = thin(all, today).map((s) => s.date);

    const cutoff = "2026-06-29"; // today - 90 days
    const recent = kept.filter((d) => d >= cutoff);
    expect(recent.length).toBe(91);
    const older = kept.filter((d) => d < cutoff);
    // Every older entry is a Sunday, the last day of its ISO week.
    expect(older.length).toBeGreaterThan(0);
    for (const d of older) expect(new Date(`${d}T00:00:00Z`).getUTCDay()).toBe(0);
    // One per week: consecutive older entries are seven days apart.
    for (let i = 1; i < older.length; i++) {
      expect(Date.parse(older[i]) - Date.parse(older[i - 1])).toBe(7 * 86_400_000);
    }
  });

  test("is idempotent as the window moves: nothing it kept is dropped later", () => {
    let kept = days("2026-01-05", 120);
    let today = "2026-05-04";
    kept = thin(kept, today);
    for (let i = 0; i < 60; i++) {
      today = new Date(Date.parse(`${today}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
      const before = kept.filter((s) => Date.parse(s.date) < Date.parse(today) - (DAILY_DAYS + 7) * 86_400_000);
      kept = thin([...kept, { date: today }], today);
      for (const s of before) expect(kept.map((k) => k.date)).toContain(s.date);
    }
  });

  test("a week with a gap keeps whichever day it has last", () => {
    const kept = thin([{ date: "2026-01-05" }, { date: "2026-01-07" }, { date: "2026-09-29" }], "2026-09-29");
    expect(kept.map((s) => s.date)).toEqual(["2026-01-07", "2026-09-29"]);
  });

  test("recording thins in the same write", () => {
    const root = tempBrain({ empty: true });
    writeFileSync(
      join(root, STATS_HISTORY_FILE),
      ["2026-01-05", "2026-01-06", "2026-01-07"].map((d) => JSON.stringify(snap(d))).join("\n") + "\n"
    );
    const result = recordSnapshot(root, snap("2026-09-29"));
    expect(result).toEqual({ date: "2026-09-29", replaced: false, kept: 2, thinned: 2 });
    expect(lines(root).map((l) => JSON.parse(l).date)).toEqual(["2026-01-07", "2026-09-29"]);
  });
});

describe("historySeries", () => {
  test("one array per field, oldest first", () => {
    const h = historySeries([snap("2026-09-27", stats({ documents: 8 })), snap("2026-09-28", stats({ documents: 9 }))]);
    expect(h.dates).toEqual(["2026-09-27", "2026-09-28"]);
    expect(h.versions).toEqual(["0.40.0", "0.40.0"]);
    expect(h.documents).toEqual([8, 9]);
    expect(h.health.orphans).toEqual([3, 3]);
    expect(h.health.embeddingCoverage).toEqual([1, 1]);
    expect(h.size.dbRows).toEqual([60, 60]);
    expect(h.byType).toEqual({ note: [6, 6], project: [4, 4] });
  });

  test("a field an older snapshot lacks reads null, never 0", () => {
    // An older line: no health block at all, no size, no byRelevance.
    const old = { date: "2026-09-01", at: "2026-09-01T03:00:00.000Z", version: "0.39.0", documents: 7, byType: { note: 7 } };
    const h = historySeries(parseHistory(`${JSON.stringify(old)}\n${JSON.stringify(snap("2026-09-02"))}\n`));
    // Guard against a vacuous pass: the newer snapshot carries every field.
    expect(h.health.orphans[1]).toBe(3);
    expect(h.health.orphans).toEqual([null, 3]);
    expect(h.health.stale).toEqual([null, 2]);
    expect(h.size.freeBytes).toEqual([null, 999]);
    expect(h.tags).toEqual([null, 5]);
    expect(h.byRelevance).toEqual({ primary: [null, 10] });
    // A type the older snapshot did not have is a real zero there: it has a byType.
    expect(h.byType).toEqual({ note: [7, 6], project: [0, 4] });
  });

  test("a measured null stays null", () => {
    const h = historySeries([snap("2026-09-01", stats({ embeddings: null }))]);
    expect(h.embeddings).toEqual([null]);
  });

  test("--since keeps snapshots on and after the day", () => {
    const all = [snap("2026-09-01"), snap("2026-09-02"), snap("2026-09-03")];
    expect(historySeries(all, "2026-09-02").dates).toEqual(["2026-09-02", "2026-09-03"]);
    expect(historySeries(all, "2026-10-01").dates).toEqual([]);
  });

  test("two lines for one day (a merge of two clones) resolve to the later recording", () => {
    const early = snapshotOf(stats({ documents: 1 }), { now: new Date("2026-09-02T01:00:00Z"), version: "0.40.0" });
    const late = snapshotOf(stats({ documents: 2 }), { now: new Date("2026-09-02T23:00:00Z"), version: "0.40.0" });
    for (const text of [`${JSON.stringify(late)}\n${JSON.stringify(early)}\n`, `${JSON.stringify(early)}\n${JSON.stringify(late)}\n`]) {
      expect(historySeries(parseHistory(text)).documents).toEqual([2]);
    }
  });
});

describe("the CLI", () => {
  test("brain maintain run twice on the same day leaves exactly one snapshot", async () => {
    const root = tempBrain();
    for (let i = 0; i < 2; i++) {
      const { stdout, code, stderr } = await runCli(root, ["maintain", "--no-git", "--json"]);
      expect(code, stderr).toBe(0);
      const step = (JSON.parse(stdout) as { step: string; result: string }[]).find((s) => s.step === "stats");
      expect(step?.result).toMatch(i === 0 ? /^ok — recorded \d{4}-\d{2}-\d{2} in \.stats-history\.jsonl \(1 snapshot kept\)$/ : /^ok — replaced /);
    }
    const stored = lines(root);
    expect(stored.length).toBe(1);
    expect(JSON.parse(stored[0]).documents).toBeGreaterThan(0);
    // Two full maintain runs: past the 30s default under a loaded suite.
  }, 120_000);

  test("brain index --force leaves the history intact", async () => {
    const root = tempBrain();
    await runCli(root, ["index", "--json"]);
    expect((await runCli(root, ["stats", "--record", "--json"])).code).toBe(0);
    const before = readFileSync(join(root, STATS_HISTORY_FILE), "utf8");
    expect(before).not.toBe("");
    expect((await runCli(root, ["index", "--force", "--json"])).code).toBe(0);
    expect(readFileSync(join(root, STATS_HISTORY_FILE), "utf8")).toBe(before);
  });

  test("recording preserves current figures; trend evidence reflects the history available before the write", async () => {
    const root = tempBrain();
    await runCli(root, ["index", "--json"]);
    // Free space is the one figure that moves between two runs on a shared disk.
    const pinned = (out: string) => {
      const value = JSON.parse(out);
      delete value.trends;
      value.size.freeBytes = 0;
      return value;
    };
    const plain = await runCli(root, ["stats", "--json"]);
    expect(existsSync(join(root, STATS_HISTORY_FILE))).toBe(false);
    const recording = await runCli(root, ["stats", "--record", "--json"]);
    expect(existsSync(join(root, STATS_HISTORY_FILE))).toBe(true);
    const after = await runCli(root, ["stats", "--json"]);
    expect(pinned(recording.stdout)).toEqual(pinned(plain.stdout));
    expect(pinned(after.stdout)).toEqual(pinned(plain.stdout));
    const beforeTrends = JSON.parse(plain.stdout).trends;
    const recordedTrends = JSON.parse(recording.stdout).trends;
    expect(beforeTrends.verdicts).toHaveLength(3);
    expect(recordedTrends.verdicts).toEqual(beforeTrends.verdicts);
    expect(JSON.parse(after.stdout).trends.verdicts.find((v: { metric: string }) => v.metric === "orphans").recent.samples).toBe(1);
    // The note goes to stderr, where it cannot corrupt the JSON.
    expect(recording.stderr).toContain("History: recorded");
  });

  test("the history file is not indexed, validated or audited", async () => {
    const root = tempBrain();
    await runCli(root, ["index", "--json"]);
    const docs = JSON.parse((await runCli(root, ["stats", "--record", "--json"])).stdout).documents;
    // A history line that would be a finding anywhere it was read as a document.
    writeFileSync(
      join(root, STATS_HISTORY_FILE),
      `${JSON.stringify({ date: "2026-01-01", note: "# Title [[nowhere]] #tag" })}\n` +
        readFileSync(join(root, STATS_HISTORY_FILE), "utf8")
    );
    await runCli(root, ["index", "--force", "--json"]);
    expect(JSON.parse((await runCli(root, ["stats", "--json"])).stdout).documents).toBe(docs);
    for (const command of [["validate", "--json"], ["audit", "--json"], ["list", "--json", "--limit", "1000"]]) {
      const { stdout } = await runCli(root, command);
      expect(stdout.length, command.join(" ")).toBeGreaterThan(0);
      expect(stdout, command.join(" ")).not.toContain("stats-history");
    }
  });

  test("brain stats --history --json returns the recorded series, and --since filters it", async () => {
    const root = tempBrain();
    writeFileSync(
      join(root, STATS_HISTORY_FILE),
      [snap("2026-09-01", stats({ documents: 8 })), snap("2026-09-02", stats({ documents: 9 }))]
        .map((s) => JSON.stringify(s))
        .join("\n") + "\n"
    );
    const all = JSON.parse((await runCli(root, ["stats", "--history", "--json"])).stdout);
    expect(all.dates).toEqual(["2026-09-01", "2026-09-02"]);
    expect(all.documents).toEqual([8, 9]);
    expect(all.health.orphans).toEqual([3, 3]);
    const since = JSON.parse((await runCli(root, ["stats", "--history", "--since", "2026-09-02", "--json"])).stdout);
    expect(since.dates).toEqual(["2026-09-02"]);

    const human = await runCli(root, ["stats", "--history", "--human"]);
    expect(human.stdout).toContain("Stats history (2 snapshots, 2026-09-01 – 2026-09-02)");
  });

  test("no history is an empty series, not an error", async () => {
    const root = tempBrain();
    const { stdout, code } = await runCli(root, ["stats", "--history", "--json"]);
    expect(code).toBe(0);
    const h = JSON.parse(stdout);
    expect(h.dates).toEqual([]);
    expect(h.documents).toEqual([]);
    expect(readHistory(root)).toEqual([]);
  });

  test("usage errors: --since needs a real date and --history; --history and --record do not mix", async () => {
    const root = tempBrain();
    for (const args of [
      ["stats", "--history", "--since", "2026-13-01"],
      ["stats", "--since", "2026-09-01"],
      ["stats", "--history", "--record"],
    ]) {
      const { code } = await runCli(root, [...args, "--json"]);
      expect(code, args.join(" ")).toBe(1);
    }
    expect(existsSync(join(root, STATS_HISTORY_FILE))).toBe(false);
  });
});
