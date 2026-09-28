/**
 * Merge state a repository already holds when a sync starts (#328), against
 * real repositories.
 *
 * `pendingState` names the shape git left, and `conclude` finishes it by that
 * shape: a merge or a squash is committed, a conflicted stash pop is only
 * unstaged (its entry stays), and a rebase, am, cherry-pick or revert is never
 * touched. `sync pull` finishes such state before it merges, and a status
 * that says origin/main is in HEAD (synced, fast-forwarded, merged) is true.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { conclude, pendingState } from "../src/lib/sync/merge-state.js";
import { makeTempBrain, runCli } from "./cli-harness";

const CACHE = ".context-cache.jsonl";
const NOTE = "notes/ranger-log.md";
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", "-C", cwd, ...args]);
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

/** Run git where failing is the point (a conflicting merge, pop or rebase). */
function gitMayFail(cwd: string, ...args: string[]): number {
  return Bun.spawnSync(["git", "-C", cwd, ...args]).exitCode ?? 0;
}

function identify(root: string): void {
  git(root, "config", "user.name", "Alex Example");
  git(root, "config", "user.email", "alex@example.test");
  git(root, "config", "commit.gpgsign", "false");
}

function write(root: string, file: string, text: string): void {
  mkdirSync(join(root, file, ".."), { recursive: true });
  writeFileSync(join(root, file), text);
}

function commitAll(root: string, message: string): void {
  git(root, "add", "-A");
  git(root, "commit", "-qm", message);
}

function unmerged(root: string): string {
  return git(root, "diff", "--name-only", "--diff-filter=U");
}

function hasRef(root: string, ref: string): boolean {
  return gitMayFail(root, "rev-parse", "-q", "--verify", ref) === 0;
}

function originInHead(root: string): boolean {
  return gitMayFail(root, "merge-base", "--is-ancestor", "origin/main", "HEAD") === 0;
}

function hook(root: string, name: string, body: string): void {
  const hooks = join(root, ".git", "test-hooks");
  mkdirSync(hooks, { recursive: true });
  writeFileSync(join(hooks, name), `#!/bin/sh\n${body}\n`);
  chmodSync(join(hooks, name), 0o755);
  git(root, "config", "core.hooksPath", hooks);
}

describe("pendingState and conclude", () => {
  /** A repository with one commit holding `NOTE` and `CACHE`. */
  function repo(): string {
    const root = mkdtempSync(join(tmpdir(), "brain-pending-"));
    dirs.push(root);
    git(root, "init", "-q", "-b", "main");
    identify(root);
    write(root, NOTE, "# Ranger log\n\nTrail open.\n");
    write(root, CACHE, "");
    commitAll(root, "base");
    return root;
  }

  /**
   * A branch `side` and `main` that both edited `NOTE`, with main checked out.
   * `side` is also origin/main as a pull fetched it, so a merge of it is a
   * sync's; `feature`, which origin/main lacks, edits `NOTE` too.
   */
  function diverged(): string {
    const root = repo();
    git(root, "switch", "-q", "-c", "feature");
    write(root, NOTE, "# Ranger log\n\nTrail open, feature branch.\n");
    commitAll(root, "feature edit");
    git(root, "switch", "-q", "-c", "side", "main");
    write(root, NOTE, "# Ranger log\n\nTrail closed for rockfall.\n");
    commitAll(root, "side edit");
    git(root, "update-ref", "refs/remotes/origin/main", "side");
    git(root, "switch", "-q", "main");
    write(root, NOTE, "# Ranger log\n\nTrail open, bridge repaired.\n");
    commitAll(root, "main edit");
    return root;
  }

  function staged(root: string, file: string): string {
    return git(root, "show", `:${file}`);
  }

  /** A `git stash pop` that conflicts on `NOTE`, as after a pull moved it. */
  function stashPopConflict(): string {
    const root = repo();
    write(root, NOTE, "# Ranger log\n\nTrail open, stashed note.\n");
    git(root, "stash", "-q");
    write(root, NOTE, "# Ranger log\n\nTrail open, committed note.\n");
    commitAll(root, "committed edit");
    expect(gitMayFail(root, "stash", "pop")).not.toBe(0);
    expect(unmerged(root)).toBe(NOTE);
    return root;
  }

  test("a clean repository has nothing pending and nothing to conclude", () => {
    const root = repo();
    expect(pendingState(root)).toEqual({ kind: "none", unmerged: [] });
    expect(conclude(root)).toEqual({ outcome: "nothing", kind: "none" });
  });

  test("a conflicted merge is merge; conclude refuses it until resolved, then commits it with both parents", () => {
    const root = diverged();
    expect(gitMayFail(root, "merge", "side", "--no-edit")).not.toBe(0);
    expect(pendingState(root)).toEqual({ kind: "merge", unmerged: [NOTE] });
    const head = git(root, "rev-parse", "HEAD");

    expect(conclude(root).outcome).toBe("unresolved");
    expect(git(root, "rev-parse", "HEAD")).toBe(head);

    write(root, NOTE, "# Ranger log\n\nTrail closed for rockfall; bridge repaired.\n");
    git(root, "add", NOTE);
    expect(conclude(root)).toEqual({ outcome: "committed", kind: "merge" });
    expect(git(root, "rev-parse", "HEAD^1")).toBe(head);
    expect(git(root, "rev-parse", "HEAD^2")).toBe(git(root, "rev-parse", "side"));
  });

  test("a merge commit a hook rejects is failed, with git's reason", () => {
    const root = diverged();
    gitMayFail(root, "merge", "side", "--no-edit");
    write(root, NOTE, "# Ranger log\n\nResolved.\n");
    git(root, "add", NOTE);
    hook(root, "pre-commit", "echo 'rejected by the ranger station' >&2; exit 1");

    const done = conclude(root);
    expect(done.outcome).toBe("failed");
    expect(done.detail).toContain("rejected by the ranger station");
    expect(hasRef(root, "MERGE_HEAD")).toBe(true);
  });

  test("a conflicted squash merge, which leaves no MERGE_HEAD, is squash and is committed with one parent", () => {
    const root = diverged();
    expect(gitMayFail(root, "merge", "--squash", "side")).not.toBe(0);
    expect(hasRef(root, "MERGE_HEAD")).toBe(false);
    expect(pendingState(root)).toEqual({ kind: "squash", unmerged: [NOTE] });
    const head = git(root, "rev-parse", "HEAD");

    write(root, NOTE, "# Ranger log\n\nResolved.\n");
    git(root, "add", NOTE);
    expect(conclude(root)).toEqual({ outcome: "committed", kind: "squash" });
    expect(git(root, "rev-parse", "HEAD^1")).toBe(head);
    expect(hasRef(root, "HEAD^2")).toBe(false);
    expect(git(root, "log", "-1", "--format=%s")).toBe("Squashed commit of the following:");
  });

  test("a SQUASH_MSG with nothing staged has nothing left to finish", () => {
    const root = repo();
    git(root, "switch", "-q", "-c", "side");
    write(root, "elsewhere.md", "# Elsewhere\n");
    commitAll(root, "side");
    git(root, "switch", "-q", "main");
    git(root, "merge", "--squash", "side");
    git(root, "commit", "-qm", "squashed side");
    // A second squash of the same branch stages nothing and leaves SQUASH_MSG.
    git(root, "merge", "--squash", "side");
    expect(pendingState(root).kind).toBe("none");
  });

  test("a conflicted stash pop is stash; once resolved it is unstaged, not committed, and its entry stays", () => {
    const root = stashPopConflict();
    const head = git(root, "rev-parse", "HEAD");
    expect(pendingState(root)).toEqual({ kind: "stash", unmerged: [NOTE], stashPaths: [NOTE] });
    expect(conclude(root).outcome).toBe("unresolved");

    // `git add` resolves it and erases every trace git keeps of the pop.
    write(root, NOTE, "# Ranger log\n\nTrail open, both notes.\n");
    git(root, "add", NOTE);
    expect(pendingState(root)).toEqual({ kind: "stash", unmerged: [], stashPaths: [NOTE] });

    expect(conclude(root)).toEqual({ outcome: "unstaged", kind: "stash" });
    expect(git(root, "rev-parse", "HEAD")).toBe(head);
    expect(git(root, "diff", "--cached", "--name-only")).toBe("");
    expect(git(root, "diff", "--name-only")).toBe(NOTE);
    expect(git(root, "stash", "list")).toContain("stash@{0}");
    expect(pendingState(root).kind).toBe("none");
  });

  test("a remembered stash leftover is forgotten once HEAD moves: its paths may have been committed", () => {
    const root = stashPopConflict();
    expect(conclude(root).outcome).toBe("unresolved");
    write(root, NOTE, "# Ranger log\n\nResolved and committed.\n");
    git(root, "add", NOTE);
    git(root, "commit", "-qm", "resolved by hand");
    write(root, "staged.md", "# Staged by someone else\n");
    git(root, "add", "staged.md");

    expect(pendingState(root).kind).toBe("none");
    expect(conclude(root).outcome).toBe("nothing");
    expect(git(root, "diff", "--cached", "--name-only")).toBe("staged.md");
  });

  test("a merge someone started of a branch origin/main lacks is blocked, never committed", () => {
    const root = diverged();
    expect(gitMayFail(root, "merge", "feature", "--no-edit")).not.toBe(0);
    write(root, NOTE, "# Ranger log\n\nResolved.\n");
    git(root, "add", NOTE);
    const head = git(root, "rev-parse", "HEAD");

    const done = conclude(root);
    expect(done.outcome).toBe("blocked");
    expect(done.kind).toBe("merge");
    expect(done.detail).toContain("which is not in origin/main");
    expect(git(root, "rev-parse", "HEAD")).toBe(head);
    expect(hasRef(root, "MERGE_HEAD")).toBe(true);
  });

  test("a squash of a branch origin/main lacks is blocked, read from the commits SQUASH_MSG names", () => {
    const root = diverged();
    expect(gitMayFail(root, "merge", "--squash", "feature")).not.toBe(0);
    write(root, NOTE, "# Ranger log\n\nResolved.\n");
    git(root, "add", NOTE);
    const head = git(root, "rev-parse", "HEAD");
    // The format `incoming` reads: a `commit <sha>` header at column 0.
    const msg = readFileSync(join(root, ".git", "SQUASH_MSG"), "utf-8");
    expect(msg).toContain(`\ncommit ${git(root, "rev-parse", "feature")}\n`);

    const done = conclude(root);
    expect(done.outcome).toBe("blocked");
    expect(done.detail).toContain("which is not in origin/main");
    expect(git(root, "rev-parse", "HEAD")).toBe(head);
  });

  test("a sync's merge with a secret staged beside it is blocked, and the secret stays staged", () => {
    const root = diverged();
    gitMayFail(root, "merge", "side", "--no-edit");
    write(root, NOTE, "# Ranger log\n\nResolved.\n");
    write(root, ".env", "TOKEN=synthetic\n");
    git(root, "add", NOTE, ".env");
    const head = git(root, "rev-parse", "HEAD");

    const done = conclude(root);
    expect(done.outcome).toBe("blocked");
    expect(done.detail).toContain("the index stages .env, which origin/main does not hold");
    expect(git(root, "rev-parse", "HEAD")).toBe(head);
    expect(staged(root, ".env")).toBe("TOKEN=synthetic");
  });

  test("a sync's merge with other work staged beside it is blocked: a commit would take the whole index", () => {
    const root = diverged();
    gitMayFail(root, "merge", "side", "--no-edit");
    write(root, NOTE, "# Ranger log\n\nResolved.\n");
    write(root, "notes/private.md", "# Private\n");
    git(root, "add", NOTE, "notes/private.md");
    const head = git(root, "rev-parse", "HEAD");

    const done = conclude(root);
    expect(done.outcome).toBe("blocked");
    expect(done.detail).toContain("the index stages notes/private.md beside the merge");
    expect(git(root, "rev-parse", "HEAD")).toBe(head);
  });

  test("a stash leftover whose staged resolution the working file no longer has fails, and nothing is unstaged", () => {
    const root = stashPopConflict();
    expect(conclude(root).outcome).toBe("unresolved");
    const resolution = "# Ranger log\n\nTrail open, both notes.\n";
    write(root, NOTE, resolution);
    git(root, "add", NOTE);
    write(root, NOTE, "# Ranger log\n\nEdited again, not staged.\n");

    const done = conclude(root);
    expect(done.outcome).toBe("failed");
    expect(done.detail).toContain(`no longer has the version staged for ${NOTE}`);
    expect(staged(root, NOTE)).toBe(resolution.trimEnd());
    expect(pendingState(root)).toEqual({ kind: "stash", unmerged: [], stashPaths: [NOTE] });
  });

  const blockers: [label: string, blocker: string, start: (root: string) => void][] = [
    ["rebase (merge backend)", "rebase", (root) => expect(gitMayFail(root, "rebase", "side")).not.toBe(0)],
    ["rebase --apply", "rebase", (root) => expect(gitMayFail(root, "rebase", "--apply", "side")).not.toBe(0)],
    [
      "am",
      "am",
      (root) => {
        const patches = join(root, ".git", "patches");
        git(root, "format-patch", "-q", "-1", "side", "-o", patches);
        expect(gitMayFail(root, "am", "-q", join(patches, "0001-side-edit.patch"))).not.toBe(0);
      },
    ],
    ["cherry-pick", "cherry-pick", (root) => expect(gitMayFail(root, "cherry-pick", "side")).not.toBe(0)],
    [
      "revert",
      "revert",
      (root) => {
        // Reverting `main edit` conflicts once a later commit rewrote its line.
        write(root, NOTE, "# Ranger log\n\nTrail open, bridge repaired, sign replaced.\n");
        commitAll(root, "later edit");
        expect(gitMayFail(root, "revert", "--no-edit", "HEAD~1")).not.toBe(0);
      },
    ],
  ];
  for (const [label, blocker, start] of blockers) {
    test(`a ${label} in progress is blocked, and conclude leaves it alone`, () => {
      const root = diverged();
      start(root);
      const head = git(root, "rev-parse", "HEAD");
      const state = pendingState(root);
      expect(state.kind).toBe("blocked");
      expect(state.blocker).toBe(blocker as NonNullable<typeof state.blocker>);

      write(root, NOTE, "# Ranger log\n\nResolved.\n");
      git(root, "add", NOTE);
      expect(conclude(root).outcome).toBe("blocked");
      expect(git(root, "rev-parse", "HEAD")).toBe(head);
    });
  }
});

describe("sync pull over state that was already pending", () => {
  let clones = 0;

  /** The fixture corpus with a two-key cache, committed and pushed to a bare remote. */
  function brainWithRemote(): { root: string; remote: string } {
    const root = makeTempBrain();
    const base = mkdtempSync(join(tmpdir(), "brain-pending-remote-"));
    dirs.push(root, base);
    const remote = join(base, "remote.git");
    Bun.spawnSync(["git", "init", "-q", "--bare", "-b", "main", remote]);
    git(root, "init", "-q", "-b", "main");
    identify(root);
    git(root, "config", "merge.conflictStyle", "diff3");
    writeFileSync(join(root, ".git", "info", "exclude"), "node_modules\n");
    write(root, CACHE, '{"k":"a","v":"base"}\n{"k":"b","v":"base"}\n');
    commitAll(root, "fixture");
    git(root, "remote", "add", "origin", remote);
    git(root, "push", "-q", "origin", "main");
    return { root, remote };
  }

  /** Another clone of `remote` commits `files` and pushes. */
  function pushFromOtherClone(remote: string, files: Record<string, string>): void {
    const other = join(remote, "..", `other-${++clones}`);
    Bun.spawnSync(["git", "clone", "-q", remote, other]);
    identify(other);
    for (const [file, text] of Object.entries(files)) write(other, file, text);
    commitAll(other, "from the other clone");
    git(other, "push", "-q", "origin", "main");
  }

  /** Both clones committed a different cache edit; theirs updates `a`, ours prunes it. */
  function cacheConflict(): { root: string; remote: string } {
    const { root, remote } = brainWithRemote();
    pushFromOtherClone(remote, { [CACHE]: '{"k":"a","v":"theirs"}\n{"k":"b","v":"base"}\n' });
    write(root, CACHE, '{"k":"b","v":"base"}\n');
    commitAll(root, "Refresh derived index caches");
    return { root, remote };
  }

  /**
   * A cache edit stashed here, a pull that fast-forwards over another clone's
   * cache commit, and a `git stash pop` that conflicts on the cache: unmerged
   * entries, no MERGE_HEAD, and nothing local to push.
   */
  function stashPopCacheConflict(): { root: string; remote: string } {
    const { root, remote } = brainWithRemote();
    pushFromOtherClone(remote, { [CACHE]: '{"k":"a","v":"theirs"}\n{"k":"b","v":"base"}\n' });
    write(root, CACHE, '{"k":"a","v":"base"}\n{"k":"b","v":"ours"}\n');
    git(root, "stash", "-q");
    git(root, "pull", "-q", "--ff-only", "origin", "main");
    expect(gitMayFail(root, "stash", "pop")).not.toBe(0);
    expect(unmerged(root)).toBe(CACHE);
    expect(hasRef(root, "MERGE_HEAD")).toBe(false);
    return { root, remote };
  }

  async function pull(root: string): Promise<{ code: number; body: Record<string, unknown> }> {
    const result = await runCli(root, ["sync", "pull", "--json"]);
    return { code: result.code, body: JSON.parse(result.stdout) };
  }

  test("S1: a pending cache-only merge and another remote commit end merged, with origin/main in HEAD", async () => {
    const { root, remote } = cacheConflict();
    git(root, "fetch", "-q", "origin", "main");
    expect(gitMayFail(root, "merge", "origin/main", "--no-edit")).not.toBe(0);
    expect(unmerged(root)).toBe(CACHE);
    pushFromOtherClone(remote, { "notes/trail-report.md": "# Trail report\n\nNorth loop clear.\n" });

    const { code, body } = await pull(root);
    expect(originInHead(root)).toBe(true);
    expect(body.status).toBe("merged");
    expect(body.concluded).toBe("merge");
    expect(body.conflicts).toEqual([]);
    expect(body.mergedCaches).toEqual([CACHE]);
    expect(body.localAhead).toBe(1);
    expect(body.remoteAhead).toBe(2);
    expect(code).toBe(0);
    expect(await Bun.file(join(root, CACHE)).text()).toBe('{"k":"a","v":"theirs"}\n{"k":"b","v":"base"}\n');
  });

  test("S2a: an unmerged cache from a stash pop, with nothing to fetch, is resolved into mergedCaches, not synced with []", async () => {
    const { root } = stashPopCacheConflict();
    const head = git(root, "rev-parse", "HEAD");

    const { code, body } = await pull(root);
    expect(unmerged(root)).toBe("");
    expect(body.mergedCaches).toEqual([CACHE]);
    expect(body.conflicts).toEqual([]);
    expect(body.concluded).toBe("stash");
    expect(body.status).toBe("synced");
    expect(code).toBe(0);
    // Unstaged, not committed: the resolved cache is an ordinary working-tree change.
    expect(git(root, "rev-parse", "HEAD")).toBe(head);
    expect(git(root, "diff", "--cached", "--name-only")).toBe("");
    expect(git(root, "diff", "--name-only")).toBe(CACHE);
    // Each key keeps its first line in sorted order, as in every cache union.
    expect(await Bun.file(join(root, CACHE)).text()).toBe('{"k":"a","v":"base"}\n{"k":"b","v":"base"}\n');
    expect(git(root, "stash", "list")).toContain("stash@{0}");
  });

  test("S2b: the same state plus one remote commit and nothing local fast-forwards, not merge-failed with []", async () => {
    const { root, remote } = stashPopCacheConflict();
    pushFromOtherClone(remote, { "notes/trail-report.md": "# Trail report\n\nNorth loop clear.\n" });

    const { code, body } = await pull(root);
    expect(body.status).toBe("fast-forwarded");
    expect(body.mergedCaches).toEqual([CACHE]);
    expect(body.conflicts).toEqual([]);
    expect(body.concluded).toBe("stash");
    expect(code).toBe(0);
    expect(originInHead(root)).toBe(true);
    expect(unmerged(root)).toBe("");
  });

  test("a stash pop conflict on a note is conflicted and listed; conclude after resolving unstages it and keeps the entry", async () => {
    const { root } = brainWithRemote();
    write(root, NOTE, "# Ranger log\n\nTrail open.\n");
    commitAll(root, "log");
    git(root, "push", "-q", "origin", "main");
    write(root, NOTE, "# Ranger log\n\nTrail open, stashed note.\n");
    git(root, "stash", "-q");
    write(root, NOTE, "# Ranger log\n\nTrail open, committed note.\n");
    commitAll(root, "committed edit");
    expect(gitMayFail(root, "stash", "pop")).not.toBe(0);
    const head = git(root, "rev-parse", "HEAD");

    const pulled = await pull(root);
    expect(pulled.body.status).toBe("conflicted");
    expect(pulled.body.conflicts).toEqual([NOTE]);
    expect(pulled.body.concluded).toBe(null);
    expect(pulled.code).toBe(0);

    write(root, NOTE, "# Ranger log\n\nTrail open, both notes.\n");
    git(root, "add", NOTE);
    const result = await runCli(root, ["sync", "conclude", "--json"]);
    expect(JSON.parse(result.stdout)).toEqual({ outcome: "unstaged", kind: "stash" });
    expect(result.code).toBe(0);
    expect(git(root, "rev-parse", "HEAD")).toBe(head);
    expect(git(root, "diff", "--cached", "--name-only")).toBe("");
    expect(git(root, "diff", "--name-only")).toBe(NOTE);
    expect(git(root, "stash", "list")).toContain("stash@{0}");
  });

  test("conclude with something still unmerged is unresolved and exits 1", async () => {
    const { root } = cacheConflict();
    git(root, "fetch", "-q", "origin", "main");
    gitMayFail(root, "merge", "origin/main", "--no-edit");
    const head = git(root, "rev-parse", "HEAD");

    const result = await runCli(root, ["sync", "conclude", "--json"]);
    const body = JSON.parse(result.stdout);
    expect(body.outcome).toBe("unresolved");
    expect(body.kind).toBe("merge");
    expect(result.code).toBe(1);
    expect(git(root, "rev-parse", "HEAD")).toBe(head);
  });

  test("a rebase in progress is merge-failed with a reason, and HEAD is not moved", async () => {
    const { root, remote } = brainWithRemote();
    write(root, NOTE, "# Ranger log\n\nTrail open.\n");
    commitAll(root, "log");
    git(root, "push", "-q", "origin", "main");
    pushFromOtherClone(remote, { [NOTE]: "# Ranger log\n\nTrail closed for rockfall.\n" });
    write(root, NOTE, "# Ranger log\n\nTrail open, bridge repaired.\n");
    commitAll(root, "local edit");
    git(root, "fetch", "-q", "origin", "main");
    expect(gitMayFail(root, "rebase", "origin/main")).not.toBe(0);
    const head = git(root, "rev-parse", "HEAD");

    const { code, body } = await pull(root);
    expect(body.status).toBe("merge-failed");
    expect(body.reason).toBe("a rebase is in progress");
    expect(code).toBe(1);
    expect(git(root, "rev-parse", "HEAD")).toBe(head);
    expect(unmerged(root)).toBe(NOTE);
  });

  test("a pending cache-only merge with nothing new to fetch is concluded and reported merged, not synced", async () => {
    const { root } = cacheConflict();
    git(root, "fetch", "-q", "origin", "main");
    expect(gitMayFail(root, "merge", "origin/main", "--no-edit")).not.toBe(0);
    const head = git(root, "rev-parse", "HEAD");

    const { code, body } = await pull(root);
    expect(body.status).toBe("merged");
    expect(body.concluded).toBe("merge");
    expect(code).toBe(0);
    expect(git(root, "rev-parse", "HEAD^1")).toBe(head);
    expect(originInHead(root)).toBe(true);
  });

  // With squash configured every merge the pull runs is a squash, which
  // never makes origin/main an ancestor.
  test("a squash leftover under branch.main.mergeOptions=--squash never loops: merge-failed or origin/main in HEAD", async () => {
    const { root, remote } = cacheConflict();
    git(root, "config", "branch.main.mergeOptions", "--squash");
    git(root, "fetch", "-q", "origin", "main");
    expect(gitMayFail(root, "merge", "origin/main", "--no-edit")).not.toBe(0);
    expect(unmerged(root)).toBe(CACHE);
    pushFromOtherClone(remote, { "notes/trail-report.md": "# Trail report\n\nNorth loop clear.\n" });

    for (let run = 0; run < 2; run++) {
      const { code, body } = await pull(root);
      if (body.status === "merge-failed") {
        expect(code).toBe(1);
      } else {
        expect(["synced", "fast-forwarded", "merged"]).toContain(body.status as string);
        expect(originInHead(root)).toBe(true);
      }
    }
  });

  /**
   * `git merge feature`, started by hand, where `feature` is a local branch
   * origin/main lacks: it conflicts only on the cache, and `.env` is staged
   * beside it. HEAD before the merge is returned.
   */
  function foreignCacheMerge(root: string): string {
    git(root, "switch", "-q", "-c", "feature");
    write(root, CACHE, '{"k":"a","v":"feature"}\n{"k":"b","v":"base"}\n');
    write(root, "notes/feature.md", "# Feature\n");
    commitAll(root, "feature work");
    git(root, "switch", "-q", "main");
    write(root, CACHE, '{"k":"a","v":"main"}\n{"k":"b","v":"base"}\n');
    commitAll(root, "main cache");
    const head = git(root, "rev-parse", "HEAD");
    expect(gitMayFail(root, "merge", "feature", "--no-edit")).not.toBe(0);
    expect(unmerged(root)).toBe(CACHE);
    write(root, ".env", "TOKEN=synthetic\n");
    git(root, "add", ".env");
    return head;
  }

  test("a merge the user started, with only a cache conflict, is merge-failed and untouched: not concluded, not unioned", async () => {
    const { root } = brainWithRemote();
    const head = foreignCacheMerge(root);

    const { code, body } = await pull(root);
    expect(body.status).toBe("merge-failed");
    expect(body.reason).toContain("which is not in origin/main");
    expect(body.concluded).toBe(null);
    expect(code).toBe(1);
    expect(git(root, "rev-parse", "HEAD")).toBe(head);
    expect(unmerged(root)).toBe(CACHE);
    expect(git(root, "show", ":.env")).toBe("TOKEN=synthetic");
  });

  test("sync run over a merge the user started and finished resolving pushes nothing", async () => {
    const { root, remote } = brainWithRemote();
    const head = foreignCacheMerge(root);
    write(root, CACHE, '{"k":"a","v":"main"}\n{"k":"b","v":"base"}\n');
    git(root, "add", CACHE);
    const remoteMain = git(remote, "rev-parse", "main");

    const result = await runCli(root, ["sync", "run", "--json"]);
    const body = JSON.parse(result.stdout);
    expect(git(remote, "rev-parse", "main")).toBe(remoteMain);
    expect(git(root, "rev-parse", "HEAD")).toBe(head);
    expect(git(root, "show", ":.env")).toBe("TOKEN=synthetic");
    expect(body.status).toBe("failed");
    expect(body.reason).toContain("which is not in origin/main");
  });

  test("a squash git stopped before committing is not merged over: merge-failed with a reason, and it stays a squash", async () => {
    const { root, remote } = brainWithRemote();
    pushFromOtherClone(remote, { "notes/trail-report.md": "# Trail report\n\nNorth loop clear.\n" });
    write(root, "notes/local.md", "# Local\n");
    commitAll(root, "local content");
    git(root, "config", "branch.main.mergeOptions", "--squash");
    git(root, "fetch", "-q", "origin", "main");
    git(root, "merge", "origin/main", "--no-edit");
    expect(git(root, "diff", "--cached", "--name-only")).toBe("notes/trail-report.md");
    const head = git(root, "rev-parse", "HEAD");

    const { code, body } = await pull(root);
    expect(body.status).toBe("merge-failed");
    expect(body.reason).toBe("a squash is pending with nothing unmerged; finish it with `brain sync conclude`");
    expect(code).toBe(1);
    // A merge over it would delete SQUASH_MSG and leave the squash as anonymous staged work.
    expect(existsSync(join(root, ".git", "SQUASH_MSG"))).toBe(true);
    expect(git(root, "rev-parse", "HEAD")).toBe(head);
  });
});
