import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { assertBrowserPartition, balanceBrowserSpecs, browserCostsFromLogs, readBrowserCosts, UNKNOWN_BROWSER_SECONDS } from "../scripts/browser-shards";
import { MeasuredBrowserSequencer } from "../scripts/browser-sequencer";
import type { TestSpecification, Vitest } from "vitest/node";

const roots: string[] = [];
afterEach(() => { for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const specs = ["fine", "coarse", "mixed"].flatMap(project => ["navigation", "tray", "unknown"].map(file => ({ project, key: `${project}::${file}` })));
const costs = { seconds: Object.fromEntries(specs.filter(spec => !spec.key.endsWith("unknown")).map(spec => [spec.key, spec.key.endsWith("navigation") ? 300 : 90])) };

test("browser partition separates expensive project/file specs and discovers unknowns offline", () => {
  const shards = balanceBrowserSpecs(specs, 2, costs);
  expect(shards.flat().map(spec => spec.key).sort()).toEqual(specs.map(spec => spec.key).sort());
  expect(new Set(shards.flat().map(spec => spec.key)).size).toBe(specs.length);
  expect(shards.every(shard => shard.some(spec => spec.key.endsWith("navigation")))).toBe(true);
  expect(shards.flat().filter(spec => spec.key.endsWith("unknown"))).toHaveLength(3);
  expect(UNKNOWN_BROWSER_SECONDS).toBeGreaterThan(0);
  expect(balanceBrowserSpecs([...specs].reverse(), 2, costs)).toEqual(shards);
});

test("the coverage assertion fails on an omitted or duplicated nonempty spec", () => {
  const shards = balanceBrowserSpecs(specs, 2, costs);
  const omitted = shards.map(shard => [...shard]); omitted[0]!.pop();
  expect(() => assertBrowserPartition(specs, omitted)).toThrow("exactly once");
  const duplicate = shards.map(shard => [...shard]); duplicate[1]![0] = duplicate[0]![0]!;
  expect(() => assertBrowserPartition(specs, duplicate)).toThrow("exactly once");
});

test("invalid or missing costs fail loudly without discarding specs", () => {
  for (const value of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) expect(() => balanceBrowserSpecs(specs, 2, { seconds: { "fine::navigation": value } })).toThrow("positive finite");
  expect(() => balanceBrowserSpecs(specs, 2, { seconds: {} })).toThrow("nonempty");
  expect(() => balanceBrowserSpecs(specs, 20, costs)).toThrow("Invalid browser shard count");
  const dir = mkdtempSync(join(tmpdir(), "browser-costs-")); roots.push(dir);
  expect(() => readBrowserCosts(join(dir, "missing.json"))).toThrow();
  writeFileSync(join(dir, "invalid.json"), '{"seconds":{"bad":0}}');
  expect(() => readBrowserCosts(join(dir, "invalid.json"))).toThrow("positive finite");
});

test("recorded report refresh normalizes repo paths and aggregates duplicate samples by median", () => {
  const first = "✓ rail-fine (chromium) ../ui-react/tests/browser/navigation-reach.pointer.tsx (12 tests) 300000ms\n✓ visual (chromium) tests/visual/answer.visual.tsx (4 tests | 1 skipped) 2000ms";
  const second = "✓ rail-fine (chromium) ../ui-react/tests/browser/navigation-reach.pointer.tsx (12 tests) 100000ms";
  expect(browserCostsFromLogs([first, second])).toEqual({
    "rail-fine::packages/ui-react/tests/browser/navigation-reach.pointer.tsx": 200,
    "visual::packages/ui-kit/tests/visual/answer.visual.tsx": 2,
  });
  expect(() => browserCostsFromLogs(["no test report"])).toThrow("timing evidence");
});

test("actual sequencer keeps every emitted specification once and leaves unsharded discovery unchanged", async () => {
  const root = resolve(import.meta.dir, "..");
  const files = ["fine", "coarse", "mixed"].map(mode => ({ project: { name: `rail-${mode} (chromium)` },
    moduleId: join(root, "packages/ui-react/tests/browser/navigation-reach.pointer.tsx") }) as TestSpecification);
  const selected: TestSpecification[] = [];
  for (const index of [1, 2]) {
    const sequencer = new MeasuredBrowserSequencer({ config: { shard: { index, count: 2 } } } as Vitest);
    selected.push(...await sequencer.shard(files));
  }
  expect(selected).toHaveLength(files.length); expect(new Set(selected).size).toBe(files.length);
  expect(new Set(selected)).toEqual(new Set(files));
  const unsharded = new MeasuredBrowserSequencer({ config: {} } as Vitest);
  expect(await unsharded.shard(files)).toBe(files);
});
