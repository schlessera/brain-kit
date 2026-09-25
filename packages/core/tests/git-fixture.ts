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

/** Write `n` distinct loose blobs; returns each one's object id and content. */
export function writeLooseBlobs(root: string, n: number): { oid: string; content: string }[] {
  const blobs: { oid: string; content: string }[] = [];
  for (let i = 0; i < n; i++) {
    const content = `loose blob ${i}\n`;
    const proc = Bun.spawnSync(["git", "-C", root, "hash-object", "-w", "--stdin"], {
      stdin: new TextEncoder().encode(content),
      stdout: "pipe",
    });
    expect(proc.exitCode).toBe(0);
    blobs.push({ oid: new TextDecoder().decode(proc.stdout).trim(), content });
  }
  return blobs;
}

/** Assert every blob is still in the object store with its exact content. */
export function expectBlobsIntact(root: string, blobs: { oid: string; content: string }[]): void {
  expect(blobs.length).toBeGreaterThan(0);
  for (const { oid, content } of blobs) {
    const proc = Bun.spawnSync(["git", "-C", root, "cat-file", "blob", oid], { stdout: "pipe", stderr: "pipe" });
    expect(proc.exitCode, `blob ${oid} is gone: ${new TextDecoder().decode(proc.stderr)}`).toBe(0);
    expect(new TextDecoder().decode(proc.stdout)).toBe(content);
  }
}

/** Every reflog entry of every ref, so a test can show none was expired. */
export function reflogs(root: string): string[] {
  return git(root, "reflog", "show", "--all", "--format=%gd %H %gs").split("\n").filter(Boolean).sort();
}
