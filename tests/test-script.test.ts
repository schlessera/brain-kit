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
      for (const helper of ["test-shards.ts", "test-shard-costs.json", "test-network-preload.ts", "test-network-guard.ts", "test-network-child-preload.ts"]) {
        cpSync(join(ROOT, "scripts", helper), join(dir, "scripts", helper));
      }
      // The actual preload also owns cleanup for the shared CLI harness.
      mkdirSync(join(dir, "packages/core/tests"), { recursive: true });
      cpSync(join(ROOT, "packages/core/tests/cli-harness.ts"), join(dir, "packages/core/tests/cli-harness.ts"));
    }
    for (const where of FIXTURES) {
      mkdirSync(join(dir, where), { recursive: true });
      writeFileSync(
        join(dir, where, "x.test.ts"),
        `import { expect, test } from "bun:test";\n` +
        `test("case-${where.replace("/", "-")}${where === "other" ? " --balanced-shard=1/3" : ""}", () => {\n` +
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
    // The old two-way and current three-way CI layouts must both partition
    // real test execution. A dropped --shard runs everything in every shard.
    for (const [flag, total] of [["--shard", 2], ["--shard", 3], ["--balanced-shard", 3]] as const) {
      const shards: string[][] = [];
      for (let shard = 1; shard <= total; shard++) {
        const files = await ran([`${flag}=${shard}/${total}`]);
        expect(files.length).toBeGreaterThan(0);
        shards.push(files);
      }
      const files = shards.flat();
      expect(new Set(files).size).toBe(files.length);
      expect(files.sort()).toEqual(DEFAULT_SET);
    }
    // A flag's separate value is not a path, and the filter applies.
    expect(await ran(["-t", "case-tests"])).toEqual(["tests"]);
  });

  test("flags pass through alongside a path", async () => {
    expect(await ran(["-t", "case-packages-b", "packages"])).toEqual(["packages/b"]);
  });

  test("a name pattern resembling the balanced option stays a Bun flag value", async () => {
    expect(await ran(["-t", "--balanced-shard=1/3", "other"])).toEqual(["other"]);
    expect(await ran(["--test-name-pattern", "--balanced-shard=1/3", "other"])).toEqual(["other"]);
  });

  test("a failing test fails the command", async () => {
    const result = await run(["other"], { FAIL_OTHER: "1" });
    expect(result.ran).toEqual(["other"]);
    expect(result.code).not.toBe(0);
  });

  test("balanced sharding rejects a path or a second shard selector", async () => {
    for (const args of [
      ["--balanced-shard=1/3", "packages"],
      ["--balanced-shard=1/3", "--shard=1/3"],
      ["--balanced-shard=1/3", "--balanced-shard=2/3"],
      ["--balanced-shard=1/3", "--cwd=other"],
      ["--balanced-shard=0/3"],
      ["--balanced-shard"],
    ]) {
      const result = await run(args);
      expect(result.code).not.toBe(0);
      expect(result.ran).toEqual([]);
      expect(result.output).toContain("--balanced-shard");
    }
  });
});

test("a signal sent to the wrapper stops the tests it started", async () => {
  // CI cancels a step by signalling its process; without a relay the child
  // `bun test` outlived the wrapper and kept running.
  const dir = mkdtempSync(join(tmpdir(), "root-test-signal-"));
  let wrapper: ReturnType<typeof Bun.spawn> | undefined;
  let child = 0;
  try {
    mkdirSync(join(dir, "tests"));
    const marker = join(dir, "child.pid");
    writeFileSync(
      join(dir, "tests/slow.test.ts"),
      `import { test } from "bun:test";\n` +
        `test("slow", async () => {\n` +
        // Written then renamed, so the marker never exists half-written.
        `  await Bun.write(${JSON.stringify(marker + ".tmp")}, String(process.pid));\n` +
        `  require("node:fs").renameSync(${JSON.stringify(marker + ".tmp")}, ${JSON.stringify(marker)});\n` +
        `  await Bun.sleep(20_000);\n` +
        `}, 30_000);\n`
    );
    wrapper = Bun.spawn([process.execPath, join(ROOT, "scripts/test.ts"), "tests"], {
      cwd: dir,
      stdout: "ignore",
      stderr: "ignore",
    });
    const deadline = Date.now() + 10_000;
    while (!existsSync(marker) && Date.now() < deadline) await Bun.sleep(20);
    child = Number(readFileSync(marker, "utf8"));
    // Never signal 0 or a negative: those address whole process groups.
    expect(Number.isInteger(child) && child > 0).toBe(true);
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    expect(alive(child)).toBe(true);
    wrapper.kill("SIGTERM");
    expect(await wrapper.exited).not.toBe(0);
    const gone = Date.now() + 5_000;
    while (alive(child) && Date.now() < gone) await Bun.sleep(20);
    expect(alive(child)).toBe(false);
  } finally {
    wrapper?.kill("SIGKILL");
    if (child > 0) {
      try {
        process.kill(child, "SIGKILL");
      } catch {}
    }
    rmSync(dir, { recursive: true, force: true });
  }
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
      ["--install", "fallback"],
      ["--origin", "http://localhost"],
      ["--cron-title", "nightly"],
      ["--shard=1/3"],
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
    expect(testArgv(["--parallel", "packages/scrape"])).toEqual(["--parallel", "packages/scrape"]);
    expect(testArgv(["--changed", "packages/scrape"])).toEqual(["--changed", "packages/scrape"]);
    expect(testArgv(["--bail=2"])).toEqual(withDefaults(["--bail=2"]));
  });

  test("a short cluster's first value letter takes the rest of the token, as in Bun", () => {
    // `-tt` is `-t` with the pattern "t", so the next argument is a path.
    expect(testArgv(["-tt", "packages/scrape"])).toEqual(["-tt", "packages/scrape"]);
    expect(testArgv(["-utt", "packages/scrape"])).toEqual(["-utt", "packages/scrape"]);
    expect(testArgv(["-tname", "packages/scrape"])).toEqual(["-tname", "packages/scrape"]);
    // `-u` is --update-snapshots under bun test and takes no value.
    expect(testArgv(["-u", "packages/scrape"])).toEqual(["-u", "packages/scrape"]);
    // `-c` (config) has an optional value: it ends the cluster, so the `t`
    // after it is never reached and the next argument stays a path.
    expect(testArgv(["-ct", "packages/scrape"])).toEqual(["-ct", "packages/scrape"]);
    expect(testArgv(["-uct", "packages/scrape"])).toEqual(["-uct", "packages/scrape"]);
  });

  test("a long flag bun test does not know takes no value, as in Bun", () => {
    // Build and run flags are not bun test's; Bun skips them and reads the
    // next argument as a path.
    for (const flag of ["--filter", "--outdir", "--target", "--shell", "--elide-lines"]) {
      expect(testArgv([flag, "packages/scrape"])).toEqual([flag, "packages/scrape"]);
    }
  });

  test("paths after -- and a bare - are paths", () => {
    expect(testArgv(["--", "packages/scrape"])).toEqual(["--", "packages/scrape"]);
    expect(testArgv(["-"])).toEqual(["-"]);
  });
});
