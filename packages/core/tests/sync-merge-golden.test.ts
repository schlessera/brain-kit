/**
 * Golden merges (E1): every case under `fixtures/sync-merge/<strategy>/<case>/`
 * is three versions of one file and the file the merge must produce.
 *
 * - `base.md`, `ours.md`, `theirs.md`: the sides; a missing file is a side
 *   where the file does not exist.
 * - `expected.md`: the merged file, byte for byte; missing means deleted.
 *   `expected-remote.md`: THEIRS' copy beside it (`keep-both`).
 * - `case.json`: `{ path, strategy?, decisions?, exists?, remote?, pairs?, notes?, unresolved? }`.
 *   Without `strategy`, `strategyFor` over the core taxonomy must pick the
 *   directory's strategy. `decisions` answer judgment pairs, matched by a
 *   substring of the pair's OURS text; `exists` are paths already
 *   taken and `remote` where THEIRS' copy must go; `pairs` is how many the plan must ask;
 *   `notes` are substrings the notes must contain; `unresolved` is a
 *   substring of the reason when the merge must refuse.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "fs";
import { join, resolve } from "path";

import { planMerge } from "../src/lib/sync/resolve/plan";
import { strategyFor } from "../src/lib/sync/resolve/strategy";
import { buildTaxonomy } from "../src/lib/taxonomy";
import { MERGE_STRATEGIES, PAIR_DECISIONS, type MergeStrategy, type PairDecision } from "../src/lib/sync/types";

const ROOT = resolve(import.meta.dir, "../fixtures/sync-merge");
const taxonomy = buildTaxonomy({});

interface CaseSpec {
  path: string;
  strategy?: MergeStrategy;
  decisions?: { ours: string; decision: PairDecision }[];
  exists?: string[];
  /** Where THEIRS' copy goes (`keep-both`). */
  remote?: string;
  pairs?: number;
  notes?: string[];
  unresolved?: string;
}

const read = (dir: string, name: string) => (existsSync(join(dir, name)) ? readFileSync(join(dir, name), "utf8") : null);

const cases = MERGE_STRATEGIES.flatMap((strategy) => {
  const dir = join(ROOT, strategy);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => existsSync(join(dir, name, "case.json")))
    .sort()
    .map((name) => ({ strategy, name, dir: join(dir, name) }));
});

describe("sync merge goldens", () => {
  test("every strategy has at least four cases", () => {
    for (const strategy of MERGE_STRATEGIES) {
      expect({ strategy, cases: cases.filter((c) => c.strategy === strategy).length >= 4 }).toEqual({ strategy, cases: true });
    }
  });

  for (const c of cases) {
    test(`${c.strategy}/${c.name}`, () => {
      const spec = JSON.parse(readFileSync(join(c.dir, "case.json"), "utf8")) as CaseSpec;
      const sides = { base: read(c.dir, "base.md"), ours: read(c.dir, "ours.md"), theirs: read(c.dir, "theirs.md") };
      if (!spec.strategy) expect(strategyFor(spec.path, taxonomy, sides)).toBe(c.strategy);
      const strategy = spec.strategy ?? c.strategy;
      const taken = new Set(spec.exists ?? []);
      const plan = planMerge({ path: spec.path, ...sides, exists: (p) => taken.has(p) }, strategy);
      if (spec.pairs !== undefined) expect(plan.pairs.length).toBe(spec.pairs);

      const decisions = new Map<string, PairDecision>();
      for (const { ours, decision } of spec.decisions ?? []) {
        expect(PAIR_DECISIONS).toContain(decision);
        const matching = plan.pairs.filter((pair) => pair.ours.includes(ours));
        expect(matching.length).toBeGreaterThan(0);
        for (const pair of matching) decisions.set(pair.id, decision);
      }
      const outcome = plan.render(decisions);

      if (spec.unresolved !== undefined) {
        expect(outcome.status).toBe("unresolved");
        if (outcome.status === "unresolved") expect(outcome.reason).toContain(spec.unresolved);
        return;
      }
      expect(outcome.status).toBe("resolved");
      if (outcome.status !== "resolved") return;
      expect(outcome.content).toBe(read(c.dir, "expected.md"));
      const remote = read(c.dir, "expected-remote.md");
      expect(outcome.extraFiles.map((f) => f.content)).toEqual(remote === null ? [] : [remote]);
      if (spec.remote !== undefined) expect(outcome.extraFiles.map((f) => f.path)).toEqual([spec.remote]);
      for (const note of spec.notes ?? []) expect(outcome.notes.join("\n")).toContain(note);
    });
  }
});
