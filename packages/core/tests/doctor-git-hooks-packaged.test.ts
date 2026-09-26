/**
 * `brain doctor`'s `git-hooks` check compares each installed hook with the
 * packaged one. When a packaged hook is missing or unreadable, there is
 * nothing to compare with, so the check must not pass: it fails and names the
 * hook. The check runs in process against a copy of the packaged hooks that
 * the test can break.
 */

import { afterEach, expect, test } from "bun:test";
import { chmodSync, cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { checkGitHooks } from "../src/cli/commands/doctor";
import { installGitHooks, packagedHooksDir } from "../src/cli/hooks-util";
import { cleanup, makeTempBrain } from "./cli-harness";

const temps: string[] = [];
afterEach(() => {
  while (temps.length) cleanup(temps.pop()!);
});

/** A git brain with hooks installed from a private copy of the packaged hooks, which is returned. */
function hooked(): { root: string; packaged: string } {
  const root = makeTempBrain();
  temps.push(root);
  const packaged = mkdtempSync(join(tmpdir(), "brain-packaged-hooks-"));
  temps.push(packaged);
  cpSync(packagedHooksDir(), packaged, { recursive: true });
  expect(Bun.spawnSync(["git", "init", "--quiet"], { cwd: root }).exitCode).toBe(0);
  expect(installGitHooks(root, packaged).installed).toBe(true);
  return { root, packaged };
}

test("the untouched copy passes, so the harness itself is sound", () => {
  const { root, packaged } = hooked();
  expect(checkGitHooks(root, packaged).status).toBe("pass");
});

test("a missing packaged hook fails the check and names it, even with a stale installed copy", () => {
  const { root, packaged } = hooked();
  writeFileSync(join(root, ".githooks", "post-commit"), "#!/bin/sh\n# stale\n");
  rmSync(join(packaged, "post-commit"));
  const check = checkGitHooks(root, packaged);
  expect(check.status).toBe("fail");
  expect(check.detail).toBe("cannot verify post-commit: the packaged hook is missing or unreadable (ENOENT)");
  expect(check.fix).toContain("bun install");
});

test("an unreadable packaged hook fails the check and names it", () => {
  const { root, packaged } = hooked();
  const hook = join(packaged, "pre-commit");
  chmodSync(hook, 0o000);
  try {
    // Root reads anything; then there is nothing to observe.
    expect(() => readFileSync(hook)).toThrow();
    const check = checkGitHooks(root, packaged);
    expect(check.status).toBe("fail");
    expect(check.detail).toBe("cannot verify pre-commit: the packaged hook is missing or unreadable (EACCES)");
  } finally {
    chmodSync(hook, 0o644);
  }
});
