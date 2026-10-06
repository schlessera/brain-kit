/**
 * #1043: a test process that launched Chrome through Playwright could later
 * lose an unrelated child's pidfd and pipes, and hang waiting for it. Bun
 * before 1.4.0 closes a collected subprocess's extra stdio fds a second time
 * (oven-sh/bun#33828). The test guard retains those subprocesses; the probe
 * checks the recycled fd number in a fresh process, whatever shard runs this.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const probe = join(import.meta.dir, "helpers/extra-stdio-fd-probe.ts");
const staleClose = Bun.semver.order(Bun.version, "1.4.0") < 0;

async function runProbe(executable: string, cwd: string): Promise<{ fd: number; survived: boolean }> {
  const child = Bun.spawn([executable, probe], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(code, stderr).toBe(0);
  const result = JSON.parse(stdout.trim()) as { fd: number; survived: boolean };
  expect(result.fd).toBeGreaterThan(2);
  return result;
}

describe("extra stdio fds of collected subprocesses", () => {
  test("a guarded test process keeps the recycled fd open", async () => {
    // process.execPath is a recognized Bun, so the guard preloads itself here.
    const dir = mkdtempSync(join(tmpdir(), "extra-stdio-"));
    try {
      expect((await runProbe(process.execPath, dir)).survived).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test(`the unguarded probe ${staleClose ? "detects the stale close on this Bun" : "sees no stale close on this Bun"}`, async () => {
    // An alias the guard does not recognize runs without its preload. On the
    // affected runtimes this proves the probe can observe the bug, so the
    // guarded case above is evidence there and not a vacuous pass.
    const dir = mkdtempSync(join(tmpdir(), "extra-stdio-"));
    try {
      const alias = join(dir, "unguarded-runtime");
      symlinkSync(process.execPath, alias);
      expect((await runProbe(alias, dir)).survived).toBe(!staleClose);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
