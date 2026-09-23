// `bun run test <path>` must run only that path (#264). `bun test` ORs its
// positional paths, so a root script that hardcoded `packages tests` ran the
// whole suite whatever the caller narrowed it to.
import { describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const rootScript = (JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
  scripts: { test: string };
}).scripts.test;

/**
 * Runs `bun run test ...args` with the repository's own root `test` script in
 * a scratch project holding one test file under each of `packages/`, `tests/`
 * and `other/`, and returns the relative paths of the files that ran.
 */
async function filesRun(args: string[]): Promise<string[]> {
  const dir = mkdtempSync(join(tmpdir(), "root-test-script-"));
  try {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "scratch", scripts: { test: rootScript } }));
    const script = join(ROOT, "scripts/test.ts");
    if (existsSync(script)) {
      mkdirSync(join(dir, "scripts"));
      cpSync(script, join(dir, "scripts/test.ts"));
    }
    for (const where of ["packages/a", "tests", "other"]) {
      mkdirSync(join(dir, where), { recursive: true });
      const name = `${where.replace("/", "-")}.test.ts`;
      writeFileSync(
        join(dir, where, name),
        `import { test } from "bun:test";\ntest("ran", () => { console.log("RAN ${where}/${name}"); });\n`
      );
    }
    const proc = Bun.spawn([process.execPath, "run", "test", ...args], {
      cwd: dir,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    await proc.exited;
    return [...`${out}\n${err}`.matchAll(/RAN (\S+)/g)].map((m) => m[1]!).sort();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("root test script", () => {
  test("a path narrows the run to that path", async () => {
    expect(await filesRun(["other"])).toEqual(["other/other.test.ts"]);
    expect(await filesRun(["packages/a"])).toEqual(["packages/a/packages-a.test.ts"]);
  });

  test("no arguments runs packages and tests, and nothing else", async () => {
    expect(await filesRun([])).toEqual(["packages/a/packages-a.test.ts", "tests/tests.test.ts"]);
  });

  test("flags alone still run the default roots", async () => {
    // Shard 1 of 1 is every file, so this is exactly the unsharded default set.
    expect(await filesRun(["--shard=1/1"])).toEqual(["packages/a/packages-a.test.ts", "tests/tests.test.ts"]);
    // A flag's separate value is not a path.
    expect(await filesRun(["-t", "ran"])).toEqual(["packages/a/packages-a.test.ts", "tests/tests.test.ts"]);
  });

  test("flags pass through alongside a path", async () => {
    expect(await filesRun(["--shard=1/1", "other"])).toEqual(["other/other.test.ts"]);
    expect(await filesRun(["-t", "nothing-matches-this", "other", "--pass-with-no-tests"])).toEqual([]);
  });
});
