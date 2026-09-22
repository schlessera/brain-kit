/**
 * The derived caches through a sync, against a real repository and remote.
 *
 * The commit must carry the derived caches and nothing else. A path staged
 * before post-sync ran belongs to whoever staged it: it stays staged and
 * uncommitted whether the cache commit succeeds, fails, or cannot be pushed.
 * And a cache this clone rewrote must not stop the pull that precedes it.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitDerivedCaches } from "../src/cli/commands/sync.js";
import { makeTempBrain, runCli } from "./cli-harness";

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
      "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "remote moved on");
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

  test("a cache deletion that is already staged is committed, not a staging failure", () => {
    const { root } = fixture();
    git(root, "rm", "-qf", CACHE);
    const outcome = commitDerivedCaches(root, [CACHE], "main");
    expect(outcome).toBe(`committed + pushed (${CACHE})`);
    expect(git(root, "show", "--name-status", "--format=", "HEAD")).toBe(`D\t${CACHE}`);
    expectUnrelatedUntouched(root);
  });

  test("off main nothing is staged or committed", () => {
    const { root } = fixture();
    const head = git(root, "rev-parse", "HEAD");
    expect(commitDerivedCaches(root, [CACHE], "feature")).toBe("skipped — not on main (feature)");
    expect(git(root, "rev-parse", "HEAD")).toBe(head);
    expect(git(root, "diff", "--cached", "--name-only")).toBe("staged.md");
  });
});

describe("sync pull with a locally rewritten cache", () => {
  const OURS = '{"k":"ours","v":"rebuilt from this brain.db"}\n';

  /** The fixture corpus, committed with an empty cache and pushed to a bare remote. */
  function brainWithRemote(): { root: string; remote: string } {
    const root = makeTempBrain();
    const base = mkdtempSync(join(tmpdir(), "brain-sync-remote-"));
    dirs.push(root, base);
    const remote = join(base, "remote.git");
    Bun.spawnSync(["git", "init", "-q", "--bare", "-b", "main", remote]);
    git(root, "init", "-q", "-b", "main");
    git(root, "config", "user.name", "Alex Example");
    git(root, "config", "user.email", "alex@example.test");
    git(root, "config", "commit.gpgsign", "false");
    writeFileSync(join(root, ".git", "info", "exclude"), "node_modules\n");
    writeFileSync(join(root, CACHE), "");
    git(root, "add", "-A");
    git(root, "commit", "-qm", "fixture");
    git(root, "remote", "add", "origin", remote);
    git(root, "push", "-q", "origin", "main");
    return { root, remote };
  }

  for (const [ahead, hooked] of [[false, false], [true, false], [false, true]] as const) {
    const name = `${ahead ? "merge" : "fast-forward"}${hooked ? " with a reindexing post-checkout hook" : ""}`;
    test(`does not fail the ${name}; the cache keeps both clones' entries`, async () => {
      // Another clone's post-sync pushed its cache while this clone's reindex
      // rewrote the same file. `ahead` adds a local content commit, so the
      // pull has to merge rather than fast-forward.
      const { root, remote } = brainWithRemote();
      const other = join(remote, "..", "other");
      Bun.spawnSync(["git", "clone", "-q", remote, other]);
      const theirs = '{"k":"theirs","v":"from the other clone"}\n';
      writeFileSync(join(other, CACHE), theirs);
      git(other, "-c", "user.name=Alex Example", "-c", "user.email=alex@example.test",
        "-c", "commit.gpgsign=false", "commit", "-qam", "Refresh derived index caches");
      git(other, "push", "-q", "origin", "main");
      if (ahead) {
        writeFileSync(join(root, "local-note.md"), "# Local\n");
        git(root, "add", "local-note.md");
        git(root, "commit", "-qm", "local content");
      }
      writeFileSync(join(root, CACHE), OURS);
      if (hooked) {
        // The shipped post-checkout reindexes, and an index run can rewrite
        // the cache. Restoring it must not fire that and re-dirty it.
        const hooks = join(root, ".git", "test-hooks");
        mkdirSync(hooks);
        writeFileSync(join(hooks, "post-checkout"), `#!/bin/sh\nprintf 'pruned\\n' > "${CACHE}"\n`);
        chmodSync(join(hooks, "post-checkout"), 0o755);
        git(root, "config", "core.hooksPath", hooks);
      }

      const result = await runCli(root, ["sync", "pull", "--json"]);
      const body = JSON.parse(result.stdout);
      expect(body.status).toBe(ahead ? "merged" : "fast-forwarded");
      expect(body.conflicts).toEqual([]);
      expect(body.mergedCaches).toEqual([CACHE]);
      expect(result.code).toBe(0);
      // Both clones' entries survive: the merge can re-chunk a document whose
      // context only this clone generated, and the file is where it comes back from.
      expect(await Bun.file(join(root, CACHE)).text()).toBe(OURS + theirs);
    });
  }

  test("a pull with nothing to merge leaves the rewritten cache alone", async () => {
    const { root } = brainWithRemote();
    writeFileSync(join(root, CACHE), OURS);

    const body = JSON.parse((await runCli(root, ["sync", "pull", "--json"])).stdout);
    expect(body.status).toBe("synced");
    expect(body.mergedCaches).toEqual([]);
    expect(await Bun.file(join(root, CACHE)).text()).toBe(OURS);
  });
});
