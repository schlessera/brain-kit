/**
 * Bun 1.4.2 regression for oven-sh/bun#33828: collecting an exited extra-pipe
 * child must not close an unrelated recycled fd. Both guarded and native
 * transports run the same fresh-process probe, with no retention workaround.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const probe = join(import.meta.dir, "helpers/extra-stdio-fd-probe.ts");

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

  test("the native unguarded transport keeps the recycled fd open", async () => {
    // An alias the guard does not recognize runs without its preload. On the
    // pinned runtime both paths must survive. Running this under Bun 1.3.14
    // is a negative control for the upstream fix, not a passing expectation.
    const dir = mkdtempSync(join(tmpdir(), "extra-stdio-"));
    try {
      const alias = join(dir, "unguarded-runtime");
      symlinkSync(process.execPath, alias);
      expect((await runProbe(alias, dir)).survived).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
