/**
 * The root typecheck (`tsc --noEmit` over tsconfig.json's `include`) sees a
 * file only if a pattern matches it or a checked file imports it. A new source
 * directory outside the patterns is unchecked until someone notices (#4671).
 * This test expands the patterns with TypeScript's own config parser and fails
 * when a tracked `.ts` or `.tsx` file matches none of them and is not under a
 * named exclusion. Tracked JavaScript is held to the checkJs project the same
 * way (#4672, #5065).
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

/** Tracked plain-JavaScript modules outside the checkJs project (#4672, #5065): a directory ending in `/`, or a file, each with its reason. */
const JS_EXCLUSIONS: Array<{ path: string; reason: string }> = [
  { path: "scripts/visual.mjs", reason: "the browser launcher entry point; no declaration file, not yet annotated" },
  { path: "scripts/ci-pack-probe.mjs", reason: "the packed-consumer probe entry point; no declaration file, not yet annotated" },
  { path: "scripts/probes/audio-commit-boundary/probe.mjs", reason: "a standalone probe entry point; not yet annotated" },
  { path: "scripts/probes/audio-commit-boundary/page.js", reason: "the probe's in-page half, which probe.mjs serves to a browser as is; not yet annotated" },
  { path: "packages/ui-kit/tools/dc-parity/probe.js", reason: "an expression compare.ts evaluates in a page after replacing ROOT_SELECTOR as text; not a module" },
  { path: "website/", reason: "the Astro site's config and content modules; website/tsconfig.json checks the site's TypeScript only" },
];
const JS_PROJECT = "scripts/tsconfig.mjs.json";

/** Tracked JavaScript files the checkJs project neither checks nor excludes, and stale exclusions. */
function jsCoverage(tracked: string[], checked: Set<string>, exclusions: Array<{ path: string }>) {
  const covers = (path: string, file: string) => path.endsWith("/") ? file.startsWith(path) : file === path;
  return {
    unchecked: tracked.filter(file => !checked.has(file) && !exclusions.some(entry => covers(entry.path, file))),
    stale: exclusions.filter(entry => !tracked.some(file => covers(entry.path, file) && !checked.has(file))).map(entry => entry.path),
  };
}
function checkJsFiles(config: unknown): Set<string> {
  const parsed = ts.parseJsonConfigFileContent(config, ts.sys, join(ROOT, "scripts"));
  expect(parsed.options.checkJs && parsed.options.allowJs, "the JavaScript project type-checks JavaScript").toBe(true);
  return new Set(parsed.fileNames.map(file => relative(ROOT, file)));
}
const jsConfig = () => ts.readConfigFile(join(ROOT, JS_PROJECT), ts.sys.readFile).config as { include: string[] };
function trackedJs(): string[] {
  const run = Bun.spawnSync(["git", "ls-files", "-z", "--", "*.mjs", "*.js", "*.cjs", "*.jsx"], { cwd: ROOT });
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

  test("every tracked JavaScript file is in the checkJs project or a named exclusion", () => {
    const tracked = trackedJs();
    expect(tracked.length).toBeGreaterThan(20);
    expect(tracked, "FIXTURE_MJS_ENUMERATED").toContain("tests/fixtures/browser-determinism/vitest.config.mjs");
    const { unchecked, stale } = jsCoverage(tracked, checkJsFiles(jsConfig()), JS_EXCLUSIONS);
    expect(unchecked, "EVERY_JAVASCRIPT_FILE_CHECKED_OR_NAMED").toEqual([]);
    expect(stale, "NO_STALE_JAVASCRIPT_EXCLUSION").toEqual([]);
  });

  test("removing a module from the checkJs project uncovers exactly that module", () => {
    const config = jsConfig();
    const without = { ...config, include: config.include.filter(file => file !== "host-admission.mjs") };
    expect(jsCoverage(trackedJs(), checkJsFiles(without), JS_EXCLUSIONS).unchecked).toEqual(["scripts/host-admission.mjs"]);
    const fixtures = { ...config, include: config.include.filter(file => !file.startsWith("../tests/fixtures/browser-determinism/")) };
    expect(jsCoverage(trackedJs(), checkJsFiles(fixtures), JS_EXCLUSIONS).unchecked, "FIXTURE_UNCOVERED_WHEN_DROPPED").toEqual([
      "tests/fixtures/browser-determinism/landing-racy.repeat.js",
      "tests/fixtures/browser-determinism/landing-steady.repeat.js",
      "tests/fixtures/browser-determinism/vitest.config.mjs",
    ]);
  });

  test("a JavaScript exclusion that is gone or already checked is stale", () => {
    expect(jsCoverage(["scripts/a.mjs", "scripts/b.cjs", "website/c.mjs"], new Set(["scripts/a.mjs"]),
      [{ path: "scripts/a.mjs" }, { path: "scripts/b.cjs" }, { path: "scripts/gone.js" }, { path: "website/" }, { path: "evals/" }]).stale)
      .toEqual(["scripts/a.mjs", "scripts/gone.js", "evals/"]);
  });

  test("every JavaScript exclusion carries a reason", () => {
    for (const entry of JS_EXCLUSIONS) expect(entry.reason.length, entry.path).toBeGreaterThan(20);
  });
});
