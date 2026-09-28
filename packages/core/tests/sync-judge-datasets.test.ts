import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

import { FIXTURE_DIR, loadFileSet, loadPairSet } from "../../../scripts/measure-sync-judge";
import { scanTree } from "../../../scripts/check-leakage";
import { planFileBatches, planPairBatches } from "../src/lib/sync/judge";
import { FILE_DECISIONS, PAIR_DECISIONS } from "../src/lib/sync/types";

// The E2 sets are only worth measuring if every item is asked and each label
// has enough rows that one answer does not move its precision by much.

describe("E2 dataset: files.jsonl", () => {
  const files = loadFileSet();

  test("at least 30 rows, unique ids, both labels well represented", () => {
    expect(files.length).toBeGreaterThanOrEqual(30);
    expect(new Set(files.map((f) => f.id)).size).toBe(files.length);
    for (const label of FILE_DECISIONS) {
      const n = files.filter((f) => f.label === label).length;
      expect({ label, share: n / files.length >= 0.4 }).toEqual({ label, share: true });
    }
  });

  test("every row is asked: text heads within the byte bound", () => {
    const plan = planFileBatches(files.map((f) => ({ id: f.id, path: f.path, head: f.head, bytes: f.head.length })));
    expect(plan.skipped.size).toBe(0);
    expect(plan.batches.flatMap((b) => b.indexes)).toHaveLength(files.length);
  });
});

describe("E2 dataset: pairs.jsonl", () => {
  const pairs = loadPairSet();

  test("at least 48 rows, unique ids, at least 10 per label", () => {
    expect(pairs.length).toBeGreaterThanOrEqual(48);
    expect(new Set(pairs.map((p) => p.id)).size).toBe(pairs.length);
    for (const label of PAIR_DECISIONS) {
      const n = pairs.filter((p) => p.label === label).length;
      expect({ label, atLeast10: n >= 10 }).toEqual({ label, atLeast10: true });
    }
  });

  test("every row is a real conflict and is asked", () => {
    for (const p of pairs) expect({ id: p.id, differ: p.ours !== p.theirs }).toEqual({ id: p.id, differ: true });
    const plan = planPairBatches(pairs.map(({ label: _label, ...pair }) => pair));
    expect(plan.skipped.size).toBe(0);
    expect(plan.batches.flatMap((b) => b.indexes)).toHaveLength(pairs.length);
  });
});

describe("E2 datasets: leakage", () => {
  test("the leakage gate finds nothing in the fixture directory", () => {
    expect(resolve(FIXTURE_DIR)).toEndWith("packages/core/fixtures/sync-judge");
    expect(scanTree(FIXTURE_DIR)).toEqual([]);
  });
});
