/**
 * The root typecheck (`tsc --noEmit` over tsconfig.json's `include`) sees a
 * file only if a pattern matches it or a checked file imports it. A new source
 * directory outside the patterns is unchecked until someone notices (#4671).
 * This test expands the patterns with TypeScript's own config parser and fails
 * when a tracked `.ts` or `.tsx` file matches none of them and is not under a
 * named exclusion.
 */
import { describe, expect, test } from "bun:test";
import { join, relative } from "node:path";
import ts from "typescript";

const ROOT = join(import.meta.dir, "..");

/** Paths (a directory ending in `/`, or a file) the root typecheck does not include, each with its reason. */
const EXCLUSIONS: Array<{ path: string; reason: string }> = [
  { path: "website/", reason: "its own project (website/tsconfig.json), type-checked by the publication workflow" },
];

/** Repository-relative files the config's `include`/`exclude` patterns select. */
function includedFiles(root: string, config: unknown): Set<string> {
  const parsed = ts.parseJsonConfigFileContent(config, ts.sys, root);
  return new Set(parsed.fileNames.map(file => relative(root, file)));
}

/** Tracked files no pattern includes and no exclusion covers, and exclusions that cover nothing. */
function coverage(tracked: string[], included: Set<string>, exclusions: Array<{ path: string }>) {
  const covers = (path: string, file: string) => path.endsWith("/") ? file.startsWith(path) : file === path;
  return {
    uncovered: tracked.filter(file => !included.has(file) && !exclusions.some(entry => covers(entry.path, file))),
    stale: exclusions.filter(entry => !tracked.some(file => covers(entry.path, file))).map(entry => entry.path),
  };
}

function trackedSources(): string[] {
  const run = Bun.spawnSync(["git", "ls-files", "-z", "--", "*.ts", "*.tsx"], { cwd: ROOT });
  expect(run.exitCode).toBe(0);
  return run.stdout.toString().split("\0").filter(Boolean);
}

/** Plain-JavaScript modules under scripts/ outside the checkJs project (#4672), each with its reason. */
const MJS_EXCLUSIONS: Array<{ path: string; reason: string }> = [
  { path: "scripts/visual.mjs", reason: "the browser launcher entry point; no declaration file, not yet annotated" },
  { path: "scripts/ci-pack-probe.mjs", reason: "the packed-consumer probe entry point; no declaration file, not yet annotated" },
  { path: "scripts/probes/audio-commit-boundary/probe.mjs", reason: "a standalone probe entry point; not yet annotated" },
];
const MJS_PROJECT = "scripts/tsconfig.mjs.json";

/** Tracked scripts/ .mjs files the checkJs project neither checks nor excludes, and stale exclusions. */
function mjsCoverage(tracked: string[], checked: Set<string>, exclusions: Array<{ path: string }>) {
  return {
    unchecked: tracked.filter(file => !checked.has(file) && !exclusions.some(entry => entry.path === file)),
    stale: exclusions.filter(entry => !tracked.includes(entry.path) || checked.has(entry.path)).map(entry => entry.path),
  };
}
function checkJsFiles(config: unknown): Set<string> {
  const parsed = ts.parseJsonConfigFileContent(config, ts.sys, join(ROOT, "scripts"));
  expect(parsed.options.checkJs && parsed.options.allowJs, "the .mjs project type-checks JavaScript").toBe(true);
  return new Set(parsed.fileNames.map(file => relative(ROOT, file)));
}
const mjsConfig = () => ts.readConfigFile(join(ROOT, MJS_PROJECT), ts.sys.readFile).config as { include: string[] };
function trackedMjs(): string[] {
  const run = Bun.spawnSync(["git", "ls-files", "-z", "--", "scripts/*.mjs"], { cwd: ROOT });
  expect(run.exitCode).toBe(0);
  return run.stdout.toString().split("\0").filter(Boolean);
}

const rootConfig = () => ts.readConfigFile(join(ROOT, "tsconfig.json"), ts.sys.readFile).config as { include: string[] };

describe("typecheck coverage", () => {
  test("every tracked .ts and .tsx file is in the root typecheck's include patterns or a named exclusion", () => {
    const tracked = trackedSources();
    expect(tracked.length).toBeGreaterThan(1000);
    const { uncovered, stale } = coverage(tracked, includedFiles(ROOT, rootConfig()), EXCLUSIONS);
    expect(uncovered).toEqual([]);
    expect(stale).toEqual([]);
  });

  test("the expansion is TypeScript's: dropping a pattern uncovers exactly its files", () => {
    const config = rootConfig();
    const without = { ...config, include: config.include.filter(pattern => pattern !== "evals/**/*.ts") };
    const { uncovered } = coverage(trackedSources(), includedFiles(ROOT, without), EXCLUSIONS);
    expect(uncovered.length).toBeGreaterThan(0);
    expect(uncovered.every(file => file.startsWith("evals/"))).toBe(true);
  });

  test("an exclusion with no tracked source file under it is stale", () => {
    const { uncovered, stale } = coverage(["website/a.ts", "evals/x/run.ts"], new Set(["evals/x/run.ts"]),
      [{ path: "website/" }, { path: "packages/odysseus/scripts/" }, { path: "packages/odysseus/vite.config.ts" }]);
    expect(uncovered).toEqual([]);
    expect(stale).toEqual(["packages/odysseus/scripts/", "packages/odysseus/vite.config.ts"]);
  });

  test("every exclusion carries a reason, and each package-level one names its follow-up issue", () => {
    for (const entry of EXCLUSIONS) {
      expect(entry.reason.length).toBeGreaterThan(20);
      if (entry.path.startsWith("packages/")) expect(entry.reason).toMatch(/#\d+/);
    }
  });

  test("every tracked .mjs under scripts/ is in the checkJs project or a named exclusion", () => {
    const tracked = trackedMjs();
    expect(tracked.length).toBeGreaterThan(8);
    const { unchecked, stale } = mjsCoverage(tracked, checkJsFiles(mjsConfig()), MJS_EXCLUSIONS);
    expect(unchecked).toEqual([]);
    expect(stale).toEqual([]);
  });

  test("removing a module from the checkJs project uncovers exactly that module", () => {
    const config = mjsConfig();
    const without = { ...config, include: config.include.filter(file => file !== "host-admission.mjs") };
    expect(mjsCoverage(trackedMjs(), checkJsFiles(without), MJS_EXCLUSIONS).unchecked).toEqual(["scripts/host-admission.mjs"]);
  });

  test("an .mjs exclusion that is gone or already checked is stale", () => {
    expect(mjsCoverage(["scripts/a.mjs", "scripts/b.mjs"], new Set(["scripts/a.mjs"]), [{ path: "scripts/a.mjs" }, { path: "scripts/b.mjs" }, { path: "scripts/gone.mjs" }]).stale)
      .toEqual(["scripts/a.mjs", "scripts/gone.mjs"]);
  });
});
