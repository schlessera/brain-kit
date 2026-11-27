// `audit --fix` walks the tree at most once per run for its index-stale
// suggestions (#4777), the way it already shares the registry plan and the
// validation result between findings.
import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { resolve } from "node:path";
import { prepare, registryFixture, DAY } from "./fixtures/audit-fix/prepare";
import { auditFixSuggester } from "../packages/core/src/lib/audit-repair";

const spies: { mockRestore(): void }[] = [];
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});

test("three index-stale findings share one suggestion walk", () => {
  const p = prepare(registryFixture.files);
  try {
    const target = resolve(p.root);
    const real = fs.readdirSync;
    let walks = 0;
    spies.push(
      spyOn(fs, "readdirSync").mockImplementation(((path: unknown, ...rest: unknown[]) => {
        // Only the suggester's own walk: registry planning and validation
        // walk too, and are shared already.
        if (typeof path === "string" && resolve(path) === target) {
          const stack = new Error().stack ?? "";
          if (!/planRegistry|validateDetailed/.test(stack)) walks++;
        }
        return (real as (...a: unknown[]) => unknown)(path, ...rest);
      }) as typeof fs.readdirSync)
    );
    const suggest = auditFixSuggester(p.root, p.taxonomy, DAY);
    const results = [0, 1, 2].map(() => suggest(registryFixture.finding));
    expect(results.map((r) => r.canAutoFix)).toEqual([true, true, true]);
    expect(walks).toBe(1);
  } finally { p.close(); }
});
