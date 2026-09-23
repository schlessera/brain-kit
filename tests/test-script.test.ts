// `bun run test <path>` must run only that path (#264). `bun test` ORs its
// positional paths, so a root script that hardcoded `packages tests` ran the
// whole suite whatever the caller narrowed it to.
import { describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_ROOTS, testArgv } from "../scripts/test";

const ROOT = join(import.meta.dir, "..");
const rootScript = (JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
  scripts: { test: string };
}).scripts.test;

const FIXTURES = ["packages/a", "packages/b", "tests", "other"] as const;
const DEFAULT_SET = ["packages/a", "packages/b", "tests"];

/**
 * Runs `bun run test ...args` with the repository's own root `test` script in
 * a scratch project holding one test file under each fixture directory, and
 * returns which ran and the exit code. Each file's test is named after its
 * directory, and `other`'s fails when `FAIL_OTHER` is set.
 */
async function run(args: string[], env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "root-test-script-"));
  try {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "scratch", scripts: { test: rootScript } }));
    const script = join(ROOT, "scripts/test.ts");
    if (existsSync(script)) {
      mkdirSync(join(dir, "scripts"));
      cpSync(script, join(dir, "scripts/test.ts"));
    }
    for (const where of FIXTURES) {
      mkdirSync(join(dir, where), { recursive: true });
      writeFileSync(
        join(dir, where, "x.test.ts"),
        `import { expect, test } from "bun:test";\n` +
          `test("case-${where.replace("/", "-")}", () => {\n` +
          // Split so a failure's printed source excerpt cannot match the marker.
          `  console.log("R" + "AN ${where}");\n` +
          `  expect(${where === "other" ? "process.env.FAIL_OTHER" : "undefined"}).toBeUndefined();\n` +
          `});\n`
      );
    }
    const proc = Bun.spawn([process.execPath, "run", "test", ...args], {
      cwd: dir,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, ...env },
    });
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    const code = await proc.exited;
    const ran = [...`${out}\n${err}`.matchAll(/RAN (\S+)/g)].map((m) => m[1]!).sort();
    return { ran, code, output: `${out}\n${err}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The files that ran, asserting the run itself succeeded. */
async function ran(args: string[]): Promise<string[]> {
  const result = await run(args);
  if (result.code !== 0) throw new Error(`bun run test ${args.join(" ")} exited ${result.code}:\n${result.output}`);
  return result.ran;
}

describe("root test script, run for real", () => {
  test("a path narrows the run to that path", async () => {
    expect(await ran(["other"])).toEqual(["other"]);
    expect(await ran(["packages/a"])).toEqual(["packages/a"]);
  });

  test("no arguments runs packages and tests, and nothing else", async () => {
    expect(await ran([])).toEqual(DEFAULT_SET);
  });

  test("flags alone keep the default roots, and reach bun test", async () => {
    // Two shards split the default set between them: disjoint, and together
    // all of it. A dropped --shard would run everything in both.
    const first = await ran(["--shard=1/2"]);
    const second = await ran(["--shard=2/2"]);
    expect(first.length).toBeGreaterThan(0);
    expect(second.length).toBeGreaterThan(0);
    expect(first.filter((f) => second.includes(f))).toEqual([]);
    expect([...first, ...second].sort()).toEqual(DEFAULT_SET);
    // A flag's separate value is not a path, and the filter applies.
    expect(await ran(["-t", "case-tests"])).toEqual(["tests"]);
  });

  test("flags pass through alongside a path", async () => {
    expect(await ran(["-t", "case-packages-b", "packages"])).toEqual(["packages/b"]);
  });

  test("a failing test fails the command", async () => {
    const result = await run(["other"], { FAIL_OTHER: "1" });
    expect(result.ran).toEqual(["other"]);
    expect(result.code).not.toBe(0);
  });
});

describe("testArgv", () => {
  const withDefaults = (args: string[]) => [...DEFAULT_ROOTS, ...args];

  test("adds the default roots only when no path was named", () => {
    expect(testArgv([])).toEqual(withDefaults([]));
    expect(testArgv(["packages/scrape"])).toEqual(["packages/scrape"]);
    expect(testArgv(["--timeout", "30000", "packages/scrape"])).toEqual(["--timeout", "30000", "packages/scrape"]);
  });

  test("a value-taking flag's separate value is not a path", () => {
    for (const args of [
      ["--timeout", "30000"],
      ["-t", "name"],
      ["--test-name-pattern", "name"],
      ["--grep", "name"],
      ["--console-depth", "5"],
      ["--preload", "./setup.ts"],
      ["-ut", "name"],
      ["--shard=1/2"],
      ["-t=name"],
      ["--bail"],
      ["--"],
    ]) {
      expect(testArgv(args)).toEqual(withDefaults(args));
    }
  });

  test("an optional-valued flag takes its value only through =, as in Bun", () => {
    // Bun reads the argument after `--bail`/`--config` as a positional path.
    expect(testArgv(["--bail", "packages/scrape"])).toEqual(["--bail", "packages/scrape"]);
    expect(testArgv(["--config", "packages/scrape"])).toEqual(["--config", "packages/scrape"]);
    expect(testArgv(["--bail=2"])).toEqual(withDefaults(["--bail=2"]));
  });

  test("paths after -- and a bare - are paths", () => {
    expect(testArgv(["--", "packages/scrape"])).toEqual(["--", "packages/scrape"]);
    expect(testArgv(["-"])).toEqual(["-"]);
  });
});
