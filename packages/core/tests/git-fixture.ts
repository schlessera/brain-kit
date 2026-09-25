/**
 * Git helpers for tests that need a brain inside a real repository. Not a
 * test file itself. Commits use a fixed fictional identity, so no host git
 * config is needed.
 */

import { expect } from "bun:test";

export function git(root: string, ...args: string[]): string {
  const proc = Bun.spawnSync(
    ["git", "-c", "user.name=Alex Example", "-c", "user.email=alex@example.invalid", "-C", root, ...args],
    { stdout: "pipe", stderr: "pipe" }
  );
  const stderr = new TextDecoder().decode(proc.stderr);
  expect(proc.exitCode, `git ${args.join(" ")}: ${stderr}`).toBe(0);
  return new TextDecoder().decode(proc.stdout).trim();
}

/** `git count-objects -v`'s loose-object count. */
export function looseCount(root: string): number {
  return Number(git(root, "count-objects", "-v").match(/^count: (\d+)$/m)![1]);
}

/** Every ref with the object it points at, sorted. */
export function refs(root: string): string[] {
  return git(root, "for-each-ref", "--format=%(refname) %(objectname)").split("\n").filter(Boolean).sort();
}

/**
 * Make `root` a repository with one commit, a tag and a filter-branch style
 * backup ref (unless `backup` is false), all packed, so it starts with no
 * loose objects at all.
 */
export function initRepo(root: string, opts: { backup?: boolean } = {}): void {
  git(root, "init", "-q", "-b", "main");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "fixture");
  git(root, "tag", "v1");
  if (opts.backup !== false) git(root, "update-ref", "refs/original/refs/heads/main", "HEAD");
  git(root, "repack", "-a", "-d", "-q");
  git(root, "prune-packed");
  expect(looseCount(root)).toBe(0);
}

/** Write `n` distinct loose blobs. */
export function writeLooseBlobs(root: string, n: number): void {
  for (let i = 0; i < n; i++) {
    const proc = Bun.spawnSync(["git", "-C", root, "hash-object", "-w", "--stdin"], {
      stdin: new TextEncoder().encode(`loose blob ${i}\n`),
      stdout: "pipe",
    });
    expect(proc.exitCode).toBe(0);
  }
}
