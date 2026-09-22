/**
 * post-sync's cache commit, against a real repository and remote.
 *
 * The commit must carry the derived caches and nothing else. A path staged
 * before post-sync ran belongs to whoever staged it: it stays staged and
 * uncommitted whether the cache commit succeeds, fails, or cannot be pushed.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitDerivedCaches } from "../src/cli/commands/sync.js";

const CACHE = ".context-cache.jsonl";
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", "-C", cwd, ...args]);
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

/** A clone of a bare remote with one commit, the cache tracked, and an unrelated file staged and another modified. */
function fixture(): { root: string; remote: string } {
  const base = mkdtempSync(join(tmpdir(), "brain-sync-cache-"));
  dirs.push(base);
  const remote = join(base, "remote.git");
  const root = join(base, "brain");
  Bun.spawnSync(["git", "init", "-q", "--bare", "-b", "main", remote]);
  Bun.spawnSync(["git", "clone", "-q", remote, root]);
  git(root, "config", "user.name", "Alex Example");
  git(root, "config", "user.email", "alex@example.test");
  git(root, "config", "commit.gpgsign", "false");
  writeFileSync(join(root, CACHE), "");
  writeFileSync(join(root, "notes.md"), "first\n");
  git(root, "add", CACHE, "notes.md");
  git(root, "commit", "-qm", "fixture");
  git(root, "push", "-q", "origin", "main");

  writeFileSync(join(root, CACHE), '{"rewritten":true}\n');
  writeFileSync(join(root, "staged.md"), "staged by someone else\n");
  git(root, "add", "staged.md");
  writeFileSync(join(root, "notes.md"), "edited, not staged\n");
  return { root, remote };
}

function expectUnrelatedUntouched(root: string): void {
  expect(git(root, "diff", "--cached", "--name-only")).toContain("staged.md");
  expect(git(root, "diff", "--name-only")).toBe("notes.md");
  expect(git(root, "show", "--name-only", "--format=", "HEAD")).not.toContain("staged.md");
  expect(git(root, "show", "--name-only", "--format=", "HEAD")).not.toContain("notes.md");
}

describe("commitDerivedCaches", () => {
  test("commits and pushes only the cache, leaving staged and unstaged work alone", () => {
    const { root, remote } = fixture();
    const outcome = commitDerivedCaches(root, [CACHE], "main");
    expect(outcome).toBe(`committed + pushed (${CACHE})`);
    expect(git(root, "show", "--name-only", "--format=", "HEAD")).toBe(CACHE);
    expect(git(remote, "rev-parse", "main")).toBe(git(root, "rev-parse", "HEAD"));
    expectUnrelatedUntouched(root);
  });

  test("a push the remote rejects still committed only the cache", () => {
    const { root, remote } = fixture();
    const other = join(dirs[0]!, "other");
    Bun.spawnSync(["git", "clone", "-q", remote, other]);
    git(other, "-c", "user.name=Alex Example", "-c", "user.email=alex@example.test",
      "commit", "-q", "--allow-empty", "-m", "remote moved on");
    git(other, "push", "-q", "origin", "main");

    const outcome = commitDerivedCaches(root, [CACHE], "main");
    expect(outcome).toStartWith("committed, push rejected");
    expect(git(root, "show", "--name-only", "--format=", "HEAD")).toBe(CACHE);
    expectUnrelatedUntouched(root);
  });

  test("a commit that fails leaves HEAD and the staged work where they were", () => {
    const { root } = fixture();
    const head = git(root, "rev-parse", "HEAD");
    const hook = join(root, ".git", "hooks", "pre-commit");
    writeFileSync(hook, "#!/bin/sh\nexit 1\n");
    chmodSync(hook, 0o755);

    const outcome = commitDerivedCaches(root, [CACHE], "main");
    expect(outcome).toStartWith("FAILED to commit");
    expect(git(root, "rev-parse", "HEAD")).toBe(head);
    expect(git(root, "diff", "--cached", "--name-only")).toContain("staged.md");
    expect(git(root, "diff", "--name-only")).toContain("notes.md");
  });

  test("off main nothing is staged or committed", () => {
    const { root } = fixture();
    const head = git(root, "rev-parse", "HEAD");
    expect(commitDerivedCaches(root, [CACHE], "feature")).toBe("skipped — not on main (feature)");
    expect(git(root, "rev-parse", "HEAD")).toBe(head);
    expect(git(root, "diff", "--cached", "--name-only")).toBe("staged.md");
  });
});
