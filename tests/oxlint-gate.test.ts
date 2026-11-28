/**
 * The oxlint gate lints every listed file of a linted extension, from the tree
 * every lint gate reads, except the exclusions it names (#5064, #5065). oxlint's
 * own `--debug=files` is the witness: what it would lint from the gate's
 * arguments must be exactly the gate's list, so an `ignorePatterns` entry in
 * `.oxlintrc.json` cannot drop a file the gate does not name.
 */
import { expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { listTree } from "../scripts/lib/source";
import { batches, LINTED, OXLINT_EXCLUSIONS, oxlintFiles } from "../scripts/check-oxlint";

const ROOT = resolve(import.meta.dir, "..");

/**
 * What oxlint would lint when handed `files` as the gate hands them. The pinned
 * binary is run directly: the test preload rewrites a spawned `bun x` into a
 * package-script lookup.
 */
function oxlintSees(files: readonly string[]): string[] {
  return batches(files).flatMap(batch => {
    const run = Bun.spawnSync([join(ROOT, "node_modules/.bin/oxlint"), "-c", join(ROOT, ".oxlintrc.json"), "--debug=files", ...batch], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
    expect(run.exitCode, run.stderr.toString()).toBe(0);
    return run.stdout.toString().split("\n").filter(Boolean);
  });
}

test("oxlint lints exactly the gate's list: no ignore pattern drops a file the gate does not name", () => {
  const files = oxlintFiles(ROOT);
  expect(files.length).toBeGreaterThan(4000);
  expect(files, "WEBSITE_SOURCES_LINTED").toContain("website/src/demo/app.tsx");
  expect(files, "WEBSITE_CONFIG_LINTED").toContain("website/astro.config.mjs");
  const seen = oxlintSees(files), listed = new Set(files), linted = new Set(seen);
  expect(files.filter(file => !linted.has(file)), "EVERY_GATE_FILE_LINTED").toEqual([]);
  expect(seen.filter(file => !listed.has(file)), "NOTHING_LINTED_OUTSIDE_THE_GATE").toEqual([]);
});

test("every listed file of a linted extension is linted or matched by a named exclusion", () => {
  const linted = new Set(oxlintFiles(ROOT));
  const excluded = OXLINT_EXCLUSIONS.map(entry => new Bun.Glob(entry.pattern));
  const outside = listTree(ROOT).filter(file => LINTED.test(file) && !linted.has(file) && !excluded.some(glob => glob.match(file)));
  expect(outside, "NO_UNNAMED_FILE_OUTSIDE_THE_GATE").toEqual([]);
});

test("every exclusion carries a reason and still matches a listed file", () => {
  const listed = listTree(ROOT).filter(file => LINTED.test(file));
  for (const entry of OXLINT_EXCLUSIONS) {
    expect(entry.reason.length, entry.pattern).toBeGreaterThan(20);
    const glob = new Bun.Glob(entry.pattern);
    expect(listed.some(file => glob.match(file)), `STALE_EXCLUSION ${entry.pattern}`).toBe(true);
  }
});

test("batches keep the listing order and stay within the byte limit; a longer path gets a batch of its own", () => {
  const files = ["ithaca/a.ts", "ithaca/b.ts", "troy/c.ts", "a-very-long-path-to-the-wine-dark-sea.ts", "d.ts"];
  const split = batches(files, 24);
  expect(split.flat(), "ORDER_KEPT").toEqual(files);
  expect(split, "BATCHES").toEqual([["ithaca/a.ts", "ithaca/b.ts"], ["troy/c.ts"], ["a-very-long-path-to-the-wine-dark-sea.ts"], ["d.ts"]]);
  expect(batches([]), "NO_FILES_NO_BATCH").toEqual([]);
});
