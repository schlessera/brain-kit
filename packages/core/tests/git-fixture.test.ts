/**
 * The shared fixture runner keeps the host's Git configuration out of a
 * fixture (#4837): a global file that signs every commit with a signer that
 * does not exist and installs a pre-commit hook that refuses everything must
 * not stop a fixture commit, through either module that exports `git`.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { tempDirs } from "../../../tests/helpers/temp";
import { git, gitResult, initBrainRepo } from "./git-fixture";
import { git as syncGit } from "./sync-fixture";

const tempDir = tempDirs();
let saved: string | undefined;

beforeEach(() => {
  saved = process.env.GIT_CONFIG_GLOBAL;
  const home = tempDir("odysseus-hostile-git-");
  const hooks = join(home, "hooks");
  mkdirSync(hooks);
  writeFileSync(join(hooks, "pre-commit"), "#!/bin/sh\necho 'the suitors refuse this commit' >&2\nexit 1\n");
  chmodSync(join(hooks, "pre-commit"), 0o755);
  const config = join(home, "gitconfig");
  writeFileSync(config, [
    "[commit]", "\tgpgsign = true",
    "[tag]", "\tgpgsign = true",
    "[gpg]", `\tprogram = ${join(home, "no-such-signer")}`,
    "[core]", `\thooksPath = ${hooks}`,
    "",
  ].join("\n"));
  process.env.GIT_CONFIG_GLOBAL = config;
});

afterEach(() => {
  if (saved === undefined) delete process.env.GIT_CONFIG_GLOBAL;
  else process.env.GIT_CONFIG_GLOBAL = saved;
});

function voyage(): string {
  const root = tempDir("odysseus-fixture-repo-");
  writeFileSync(join(root, "ithaca.md"), "# Ithaca\n");
  return root;
}

test("a commit through git-fixture's git ignores a hostile global configuration", () => {
  const root = voyage();
  git(root, "init", "-q", "-b", "main");
  git(root, "add", "-A");
  const commit = gitResult(root, "commit", "-q", "-m", "fixture");
  expect(commit.code, commit.stderr).toBe(0);
  expect(git(root, "log", "-1", "--format=%s %G?")).toBe("fixture N");
});

test("a commit through sync-fixture's git ignores a hostile global configuration", () => {
  const root = voyage();
  syncGit(root, "init", "-q", "-b", "main");
  syncGit(root, "add", "-A");
  syncGit(root, "commit", "-q", "-m", "fixture");
  expect(syncGit(root, "log", "-1", "--format=%s %G?")).toBe("fixture N");
});

test("initBrainRepo makes one commit on main holding every file", () => {
  const root = voyage();
  initBrainRepo(root);
  expect(git(root, "branch", "--show-current")).toBe("main");
  expect(git(root, "ls-files")).toBe("ithaca.md");
  expect(git(root, "rev-list", "--count", "HEAD")).toBe("1");
});

test("gitResult reports a failure instead of asserting", () => {
  const result = gitResult(voyage(), "commit", "-q", "-m", "not a repository");
  expect(result.code).not.toBe(0);
  expect(result.stderr).toContain("not a git repository");
});
