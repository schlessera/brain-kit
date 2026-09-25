/**
 * `brain maintain`'s git step: git's non-destructive maintenance tasks pack
 * loose objects in a brain that is a git work tree, and nothing under refs/
 * is removed.
 */

import { afterEach, expect, test } from "bun:test";
import { chmodSync } from "fs";
import { join } from "path";

import { cleanup, makeTempBrain, runCli } from "./cli-harness";
import { initRepo, looseCount, refs, writeLooseBlobs } from "./git-fixture";

const temps: string[] = [];
afterEach(() => {
  while (temps.length) cleanup(temps.pop()!);
});

function tempBrain(): string {
  const root = makeTempBrain();
  temps.push(root);
  return root;
}

async function maintain(root: string, ...flags: string[]) {
  const { stdout, stderr, code } = await runCli(root, ["maintain", "--json", ...flags]);
  const steps = JSON.parse(stdout) as { step: string; result: string }[];
  return { code, stderr, steps, git: steps.find((s) => s.step === "git") };
}

test("packs 20 loose blobs, leaves none loose, and removes no ref", async () => {
  const root = tempBrain();
  initRepo(root);
  writeLooseBlobs(root, 20);
  expect(looseCount(root)).toBe(20);
  const before = refs(root);
  expect(before.map((r) => r.split(" ")[0])).toEqual([
    "refs/heads/main",
    "refs/original/refs/heads/main",
    "refs/tags/v1",
  ]);

  const { code, git } = await maintain(root);
  expect(code).toBe(0);
  expect(git?.result).toBe("ok — packed 20 loose object(s)");
  expect(looseCount(root)).toBe(0);
  expect(refs(root)).toEqual(before);
});

test("runs the git step between the audit and the scratch prune", async () => {
  const root = tempBrain();
  const { steps } = await maintain(root);
  expect(steps.map((s) => s.step)).toEqual(["index", "audit", "git", "scratch"]);
});

test("a brain that is not a git repository skips the step and exits 0", async () => {
  const root = tempBrain();
  const { code, git } = await maintain(root);
  expect(code).toBe(0);
  expect(git?.result).toBe("skipped — not a git repository");
});

test("--no-git skips the step and leaves the objects loose", async () => {
  const root = tempBrain();
  initRepo(root);
  writeLooseBlobs(root, 3);
  const { code, git } = await maintain(root, "--no-git");
  expect(code).toBe(0);
  expect(git?.result).toBe("skipped — --no-git");
  expect(looseCount(root)).toBe(3);
});

// A read-only pack directory makes git's own pack-objects fail. Root writes
// through the mode, so this cannot be staged there.
test.skipIf(process.getuid?.() === 0)("a git failure is a FAILED step with git's message, and exit 2", async () => {
  const root = tempBrain();
  initRepo(root);
  writeLooseBlobs(root, 2);
  const pack = join(root, ".git", "objects", "pack");
  chmodSync(pack, 0o555);
  try {
    const { code, git } = await maintain(root);
    expect(git?.result).toStartWith("FAILED — fatal: Unable to create temporary file");
    expect(code).toBe(2);
  } finally {
    chmodSync(pack, 0o755);
  }
});
