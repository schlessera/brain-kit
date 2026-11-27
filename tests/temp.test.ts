/**
 * The shared temporary-directory owner (tests/helpers/temp.ts, #4840): each
 * directory is a fresh `mkdtemp` under `os.tmpdir()` and is gone after its
 * test, or after its file, even when the test throws.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { tempDirs } from "./helpers/temp";

const HELPER = resolve(import.meta.dir, "helpers/temp.ts");
const PRELOAD = resolve(import.meta.dir, "../scripts/test-network-child-preload.ts");
const tempDir = tempDirs();
const scratches: string[] = [];
afterEach(() => { for (const dir of scratches.splice(0)) rmSync(dir, { recursive: true, force: true }); });

/** Run one child test file under Bun's runner and the repository's child preload. */
async function child(body: string) {
  const scratch = mkdtempSync(join(tmpdir(), "temp-helper-parent-"));
  scratches.push(scratch);
  writeFileSync(join(scratch, "temp-child.test.ts"), `import { expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDirs } from ${JSON.stringify(HELPER)};
${body}
`);
  const run = Bun.spawn([process.execPath, "test", "--preload", PRELOAD, "./temp-child.test.ts"], { cwd: scratch, stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([run.exited, new Response(run.stdout).text(), new Response(run.stderr).text()]);
  const dirs = stdout.split("\n").filter((line) => line.startsWith("TEMP_DIR ")).map((line) => line.slice("TEMP_DIR ".length));
  return { code, dirs, output: stdout + stderr };
}

describe("tempDirs", () => {
  test("a directory made by a test that throws is removed after that test", async () => {
    const run = await child(`const tempDir = tempDirs();
test("Odysseus drops the bag of winds", () => {
  const dir = tempDir("temp-helper-child-");
  writeFileSync(join(dir, "winds.txt"), "every wind but the west");
  console.log("TEMP_DIR " + dir);
  throw new Error("the crew opened the bag");
});`);
    expect(run.code, run.output).toBe(1);
    expect(run.output).toContain("the crew opened the bag");
    expect(run.dirs).toHaveLength(1);
    expect(existsSync(run.dirs[0]!)).toBe(false);
  });

  test("a file-scoped directory survives into the next test and is removed after the file", async () => {
    const run = await child(`const fileDir = tempDirs({ scope: "file" });
let kept = "";
test("the first makes it", () => { kept = fileDir("temp-helper-file-"); console.log("TEMP_DIR " + kept); });
test("the second still finds it", () => { expect(existsSync(kept)).toBe(true); });`);
    expect(run.code, run.output).toBe(0);
    expect(run.output).toContain("2 pass");
    expect(run.dirs).toHaveLength(1);
    expect(existsSync(run.dirs[0]!)).toBe(false);
  });

  test("two directories from one prefix differ, and each is under the prefix", () => {
    const [first, second] = [tempDir("temp-helper-twin-"), tempDir("temp-helper-twin-")];
    expect(first).not.toBe(second);
    for (const dir of [first, second]) {
      expect(dir.startsWith(join(tmpdir(), "temp-helper-twin-"))).toBe(true); // tmp-path: the prefix a made directory starts with
      expect(existsSync(dir)).toBe(true);
    }
  });

  test("a directory is made under os.tmpdir() when TMPDIR is redirected", () => {
    const redirected = realpathSync(mkdtempSync(join(tmpdir(), "temp-helper-tmpdir-")));
    scratches.push(redirected);
    const saved = process.env.TMPDIR;
    try {
      process.env.TMPDIR = redirected;
      expect(tmpdir()).toBe(redirected);
      const dir = tempDir("temp-helper-redirected-");
      expect(dirname(dir)).toBe(redirected);
    } finally {
      if (saved === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = saved;
    }
  });
});
