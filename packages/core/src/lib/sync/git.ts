/**
 * The git plumbing `brain sync` runs on: one synchronous call per command.
 * Nothing here throws; a caller reads `code` and decides what a failure means.
 */

import { existsSync } from "fs";
import { join } from "path";

export interface GitResult {
  stdout: string;
  stderr: string;
  code: number;
}

/** Whether a `git` executable is on PATH. Spawning a missing one throws. */
export function gitInstalled(): boolean {
  return Bun.which("git") !== null;
}

/** Whether `root` has a git directory. Without git on PATH only a `.git` entry counts. */
export function isGitRepo(root: string): boolean {
  if (existsSync(join(root, ".git"))) return true;
  if (!gitInstalled()) return false;
  return Bun.spawnSync(["git", "-C", root, "rev-parse", "--git-dir"]).exitCode === 0;
}

/** One git config value, trimmed; empty when it is unset or there is no git to ask. */
export function gitConfig(root: string, key: string): string {
  if (!gitInstalled()) return "";
  return git(root, ["config", "--get", key]).stdout;
}

/** Run `git -C root …`. stdout is trimmed unless `raw`, which keeps NUL-separated output intact. */
export function git(root: string, args: string[], raw = false): GitResult {
  const proc = Bun.spawnSync(["git", "-C", root, ...args]);
  return {
    stdout: raw ? new TextDecoder().decode(proc.stdout) : new TextDecoder().decode(proc.stdout).trim(),
    stderr: new TextDecoder().decode(proc.stderr).trim(),
    code: proc.exitCode ?? 0,
  };
}

/**
 * The paths the index holds unmerged, once each. `-z` because without it git
 * quotes and escapes a non-ASCII or unusual path (`core.quotePath`), and the
 * quoted form names no file `git show` can find.
 */
export function unmergedPaths(root: string): string[] {
  return git(root, ["diff", "--name-only", "-z", "--diff-filter=U"], true).stdout.split("\0").filter(Boolean);
}

export function currentBranch(root: string): string {
  return git(root, ["branch", "--show-current"]).stdout || "(detached HEAD)";
}

/**
 * Absolute path of `name` under the git directory. `--git-path` follows a
 * linked worktree to its own `.git/worktrees/<name>/` directory, where a
 * plain `join(root, ".git", name)` would name a file that is not there.
 */
export function gitPath(root: string, name: string): string {
  return git(root, ["rev-parse", "--path-format=absolute", "--git-path", name]).stdout;
}

/** True when `ref` resolves to an object. */
export function refExists(root: string, ref: string): boolean {
  return git(root, ["rev-parse", "-q", "--verify", ref]).code === 0;
}

/** True when `ancestor` is reachable from `descendant` (a commit is its own ancestor). */
export function isAncestor(root: string, ancestor: string, descendant: string): boolean {
  return git(root, ["merge-base", "--is-ancestor", ancestor, descendant]).code === 0;
}
