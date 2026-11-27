// `audit --fix` walks the tree at most once per run for its index-stale
// suggestions (#4777), the way it already shares the registry plan and the
// validation result between findings.
import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { resolve } from "node:path";
import { commandOutput, document, prepare, prepareBenchmark, registryFixture, DAY, type BenchmarkCase } from "./fixtures/audit-fix/prepare";
import { auditFixSuggester } from "../packages/core/src/lib/audit-repair";

const spies: { mockRestore(): void }[] = [];
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});

/** Count the suggester's own walks of `root`: registry planning and validation walk too, and are shared already. */
function countSuggestionWalks(root: string): { walks: number } {
  const target = resolve(root);
  const real = fs.readdirSync;
  const counter = { walks: 0 };
  spies.push(
    spyOn(fs, "readdirSync").mockImplementation(((path: unknown, ...rest: unknown[]) => {
      if (typeof path === "string" && resolve(path) === target) {
        const stack = new Error().stack ?? "";
        if (/suggestAuditFix/.test(stack) && !/planRegistry|validateDetailed/.test(stack)) counter.walks++;
      }
      return (real as (...a: unknown[]) => unknown)(path, ...rest);
    }) as typeof fs.readdirSync)
  );
  return counter;
}

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

test("brain audit --fix walks the tree once for three index-stale findings (#4880)", async () => {
  // Three stale registry indexes, each with one child.
  const files: Record<string, string> = {};
  for (const dir of ["rituals", "rituals/dawn", "rituals/dusk"]) {
    files[`${dir}/_index.md`] = document("index", `Rituals of ${dir}`, "registry: { columns: [title, status] }\n", "Odysseus keeps this prose.\n");
    files[`${dir}/watch.md`] = document("ritual", `The watch of ${dir}`);
  }
  const p = await prepareBenchmark({ id: "three-stale-registries", files, moduleMode: null, modulePath: null } as unknown as BenchmarkCase);
  try {
    const counter = countSuggestionWalks(p.root);
    const fixes = await commandOutput(p, true) as { path: string; canAutoFix: boolean; repair?: { capability: string } }[];
    const stale = fixes.filter((fix) => fix.repair !== undefined);
    expect(stale.map((fix) => [fix.path, fix.canAutoFix])).toEqual([
      ["rituals/_index.md", true],
      ["rituals/dawn/_index.md", true],
      ["rituals/dusk/_index.md", true],
    ]);
    expect(counter.walks).toBe(1);
  } finally {
    p.close();
  }
});
