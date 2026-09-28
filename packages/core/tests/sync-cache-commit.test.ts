/**
 * The derived caches through a sync, against a real repository and remote.
 *
 * The commit must carry the derived caches and nothing else. A path staged
 * before post-sync ran belongs to whoever staged it: it stays staged and
 * uncommitted whether the cache commit succeeds, fails, or cannot be pushed.
 * And a cache this clone rewrote must not stop the pull that precedes it.
 * A pull that cannot merge says whether git refused or stopped on conflicts.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitDerivedCaches } from "../src/cli/commands/sync.js";
import { chunkContextKey } from "../src/lib/indexer.js";
import { saveContextCache } from "../src/lib/indexer/caches.js";
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

  test("a staged change the reindex undid is clean, not a failed commit", () => {
    const { root } = fixture();
    const head = git(root, "rev-parse", "HEAD");
    git(root, "add", CACHE);
    writeFileSync(join(root, CACHE), "");
    expect(commitDerivedCaches(root, [CACHE], "main")).toBe("clean");
    expect(git(root, "rev-parse", "HEAD")).toBe(head);
  });

  test("off main nothing is staged or committed", () => {
    const { root } = fixture();
    const head = git(root, "rev-parse", "HEAD");
    expect(commitDerivedCaches(root, [CACHE], "feature")).toBe("skipped — not on main (feature)");
    expect(git(root, "rev-parse", "HEAD")).toBe(head);
    expect(git(root, "diff", "--cached", "--name-only")).toBe("staged.md");
  });
});

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

/** A second clone of `remote` that commits `files` and pushes. */
function pushFromOtherClone(remote: string, files: Record<string, string>): void {
  const other = join(remote, "..", "other");
  Bun.spawnSync(["git", "clone", "-q", remote, other]);
  for (const [file, text] of Object.entries(files)) writeFileSync(join(other, file), text);
  git(other, "add", "-A");
  git(other, "-c", "user.name=Alex Example", "-c", "user.email=alex@example.test",
    "-c", "commit.gpgsign=false", "commit", "-qm", "from the other clone");
  git(other, "push", "-q", "origin", "main");
}

describe("sync pull with a locally rewritten cache", () => {
  const OURS = '{"k":"ours","v":"rebuilt from this brain.db"}\n';

  for (const [ahead, hooked] of [[false, false], [true, false], [false, true]] as const) {
    const name = `${ahead ? "merge" : "fast-forward"}${hooked ? " with a reindexing post-checkout hook" : ""}`;
    test(`does not fail the ${name}; the cache keeps both clones' entries`, async () => {
      // Another clone's post-sync pushed its cache while this clone's reindex
      // rewrote the same file. `ahead` adds a local content commit, so the
      // pull has to merge rather than fast-forward.
      const { root, remote } = brainWithRemote();
      const theirs = '{"k":"theirs","v":"from the other clone"}\n';
      pushFromOtherClone(remote, { [CACHE]: theirs });
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

  test("a cache conflict between two committed copies is resolved by union, keeping local-only entries", async () => {
    const { root, remote } = brainWithRemote();
    const theirs = '{"k":"theirs","v":"committed by the other clone"}\n';
    pushFromOtherClone(remote, { [CACHE]: theirs });
    const committed = '{"k":"committed","v":"committed here, not pushed"}\n';
    writeFileSync(join(root, CACHE), committed);
    git(root, "commit", "-qam", "Refresh derived index caches");
    writeFileSync(join(root, CACHE), committed + OURS);

    const body = JSON.parse((await runCli(root, ["sync", "pull", "--json"])).stdout);
    expect(body.status).toBe("merged");
    expect(body.conflicts).toEqual([]);
    expect(body.mergedCaches).toEqual([CACHE]);
    expect(await Bun.file(join(root, CACHE)).text()).toBe(committed + OURS + theirs);
    expect(git(root, "rev-parse", "-q", "--verify", "HEAD^2")).not.toBe("");
  });

  test("when git refuses the merge before it starts, the cache is put back as it was, index and file", async () => {
    const { root, remote } = brainWithRemote();
    writeFileSync(join(root, "shared.md"), "# Shared\n");
    writeFileSync(join(root, CACHE), '{"k":"committed-key","v":"the committed value"}\n');
    git(root, "add", "shared.md", CACHE);
    git(root, "commit", "-qm", "shared");
    git(root, "push", "-q", "origin", "main");
    pushFromOtherClone(remote, { "shared.md": "# Shared, edited there\n", [CACHE]: '{"k":"theirs","v":"x"}\n' });
    writeFileSync(join(root, "local-note.md"), "# Local\n");
    git(root, "add", "local-note.md");
    git(root, "commit", "-qm", "local content");
    // An unstaged edit to a file the merge touches makes git refuse outright.
    writeFileSync(join(root, "shared.md"), "# Shared, edited here and not committed\n");
    const staged = '{"k":"committed-key","v":"staged here"}\n';
    writeFileSync(join(root, CACHE), staged);
    git(root, "add", CACHE);
    const ours = '{"k":"committed-key","v":"regenerated here"}\n';
    writeFileSync(join(root, CACHE), ours);

    const body = JSON.parse((await runCli(root, ["sync", "pull", "--json"])).stdout);
    expect(body.status).not.toBe("merged");
    expect(await Bun.file(join(root, CACHE)).text()).toBe(ours);
    expect(git(root, "show", `:${CACHE}`)).toBe(staged.trim());
  });

  // Local-first used to decide this key, so two clones that generated
  // different text each kept their own and committed it back on every sync.
  // The first line in sorted order is the rule every reader applies (#408).
  for (const [committed, local] of [["alpha", "beta"], ["beta", "alpha"]] as const) {
    test(`a key both copies have keeps its first line in sorted order (committed ${committed}, local ${local})`, async () => {
      const { root, remote } = brainWithRemote();
      writeFileSync(join(root, CACHE), `{"k":"key","v":"${committed}"}\n`);
      git(root, "commit", "-qam", "Refresh derived index caches");
      git(root, "push", "-q", "origin", "main");
      pushFromOtherClone(remote, { "elsewhere.md": "# Elsewhere\n" });
      writeFileSync(join(root, CACHE), `{"k":"key","v":"${local}"}\n`);

      const body = JSON.parse((await runCli(root, ["sync", "pull", "--json"])).stdout);
      expect(body.status).toBe("fast-forwarded");
      expect(await Bun.file(join(root, CACHE)).text()).toBe('{"k":"key","v":"alpha"}\n');
    });
  }

  // `{"k":"key", "v":null}` sorts before the valid line (a space sorts before
  // a quote). If it competed for the key it would win, and every reader
  // rejects it, so the key would be lost.
  for (const file of [".context-cache.jsonl", ".asset-cache.jsonl"]) {
    for (const invalidSide of ["committed", "local"] as const) {
      test(`a line no reader accepts never wins its key (${file}, invalid ${invalidSide})`, async () => {
        const { root, remote } = brainWithRemote();
        const valid = '{"k":"key","v":"good"}';
        const invalid = '{"k":"key", "v":null}';
        expect([valid, invalid].sort()[0]).toBe(invalid);
        writeFileSync(join(root, file), `${invalidSide === "committed" ? invalid : valid}\n`);
        git(root, "add", file);
        git(root, "commit", "-qm", "Refresh derived index caches");
        git(root, "push", "-q", "origin", "main");
        pushFromOtherClone(remote, { "elsewhere.md": "# Elsewhere\n" });
        writeFileSync(join(root, file), `${invalidSide === "committed" ? valid : invalid}\n`);

        const body = JSON.parse((await runCli(root, ["sync", "pull", "--json"])).stdout);
        expect(body.status).toBe("fast-forwarded");
        expect(await Bun.file(join(root, file)).text()).toBe(`${valid}\n`);
      });
    }
  }

  test("a diff3 cache conflict resolves from the two sides, not the ancestor", async () => {
    const { root, remote } = brainWithRemote();
    git(root, "config", "merge.conflictStyle", "diff3");
    writeFileSync(join(root, CACHE), '{"k":"a","v":"base"}\n{"k":"b","v":"base"}\n');
    git(root, "commit", "-qam", "Refresh derived index caches");
    git(root, "push", "-q", "origin", "main");
    // Theirs updates `a`; ours prunes it. The ancestor's `a` must not come back.
    pushFromOtherClone(remote, { [CACHE]: '{"k":"a","v":"theirs"}\n{"k":"b","v":"base"}\n' });
    writeFileSync(join(root, CACHE), '{"k":"b","v":"base"}\n');
    git(root, "commit", "-qam", "Refresh derived index caches");

    const body = JSON.parse((await runCli(root, ["sync", "pull", "--json"])).stdout);
    expect(body.status).toBe("merged");
    expect(body.conflicts).toEqual([]);
    expect(await Bun.file(join(root, CACHE)).text()).toBe('{"k":"a","v":"theirs"}\n{"k":"b","v":"base"}\n');
  });

  test("a pull during an unfinished merge resolves its cache conflict from the stages", async () => {
    const { root, remote } = brainWithRemote();
    git(root, "config", "merge.conflictStyle", "diff3");
    writeFileSync(join(root, CACHE), '{"k":"a","v":"base"}\n{"k":"b","v":"base"}\n');
    git(root, "commit", "-qam", "Refresh derived index caches");
    git(root, "push", "-q", "origin", "main");
    pushFromOtherClone(remote, { [CACHE]: '{"k":"a","v":"theirs"}\n{"k":"b","v":"base"}\n' });
    writeFileSync(join(root, CACHE), '{"k":"b","v":"base"}\n');
    git(root, "commit", "-qam", "Refresh derived index caches");
    git(root, "fetch", "-q", "origin", "main");
    Bun.spawnSync(["git", "-C", root, "merge", "origin/main", "--no-edit"]);
    expect(git(root, "diff", "--name-only", "--diff-filter=U")).toBe(CACHE);

    const body = JSON.parse((await runCli(root, ["sync", "pull", "--json"])).stdout);
    expect(body.conflicts).toEqual([]);
    expect(await Bun.file(join(root, CACHE)).text()).toBe('{"k":"a","v":"theirs"}\n{"k":"b","v":"base"}\n');
  });

  test("a pull with nothing to merge leaves the rewritten cache alone", async () => {
    const { root } = brainWithRemote();
    writeFileSync(join(root, CACHE), OURS);

    const body = JSON.parse((await runCli(root, ["sync", "pull", "--json"])).stdout);
    expect(body.status).toBe("synced");
    expect(body.mergedCaches).toEqual([]);
    expect(await Bun.file(join(root, CACHE)).text()).toBe(OURS);
  });
});

describe("sync pull when the merge does not finish", () => {
  const NOTE = "notes/loose-idea.md";

  /** The remote has a commit editing `NOTE`; this clone holds `ours` there, uncommitted. */
  function diverged(ours: string): string {
    const { root, remote } = brainWithRemote();
    pushFromOtherClone(remote, { [NOTE]: "# Loose idea\n\nEdited on the other clone.\n" });
    writeFileSync(join(root, NOTE), ours);
    return root;
  }

  /** A hook `name` running `body`, in a hooks directory only this clone uses. */
  function hook(root: string, name: string, body: string): void {
    const hooks = join(root, ".git", "test-hooks");
    mkdirSync(hooks, { recursive: true });
    writeFileSync(join(hooks, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(hooks, name), 0o755);
    git(root, "config", "core.hooksPath", hooks);
  }

  /** Both clones committed a different edit to the cache; theirs updates `a`, ours prunes it. */
  function cacheConflict(): { root: string; remote: string } {
    const { root, remote } = brainWithRemote();
    git(root, "config", "merge.conflictStyle", "diff3");
    writeFileSync(join(root, CACHE), '{"k":"a","v":"base"}\n{"k":"b","v":"base"}\n');
    git(root, "commit", "-qam", "Refresh derived index caches");
    git(root, "push", "-q", "origin", "main");
    pushFromOtherClone(remote, { [CACHE]: '{"k":"a","v":"theirs"}\n{"k":"b","v":"base"}\n' });
    writeFileSync(join(root, CACHE), '{"k":"b","v":"base"}\n');
    git(root, "commit", "-qam", "Refresh derived index caches");
    return { root, remote };
  }

  test("git refusing to start the merge is merge-failed, exit 1, not a conflict with nothing to resolve", async () => {
    const root = diverged("# Loose idea\n\nEdited here and not committed.\n");
    writeFileSync(join(root, "local-note.md"), "# Local\n");
    git(root, "add", "local-note.md");
    git(root, "commit", "-qm", "local content");

    const result = await runCli(root, ["sync", "pull", "--json"]);
    const body = JSON.parse(result.stdout);
    expect(body.status).toBe("merge-failed");
    expect(body.conflicts).toEqual([]);
    expect(result.code).toBe(1);
    expect(Bun.spawnSync(["git", "-C", root, "rev-parse", "-q", "--verify", "MERGE_HEAD"]).exitCode).not.toBe(0);
  });

  test("a merge that stops on a conflict is conflicted and lists the path", async () => {
    const root = diverged("# Loose idea\n\nEdited here and committed.\n");
    git(root, "commit", "-qam", "local edit");

    const result = await runCli(root, ["sync", "pull", "--json"]);
    const body = JSON.parse(result.stdout);
    expect(body.status).toBe("conflicted");
    expect(body.conflicts).toEqual([NOTE]);
    expect(result.code).toBe(0);
  });

  test("a conflicted non-ASCII path is listed as the file, not git's quoted form, and its sides are found", async () => {
    const CAFE = "notes/caf\u00e9.md";
    const { root, remote } = brainWithRemote();
    writeFileSync(join(root, CAFE), "# Caf\u00e9\n");
    git(root, "add", CAFE);
    git(root, "commit", "-qm", "cafe");
    git(root, "push", "-q", "origin", "main");
    pushFromOtherClone(remote, { [CAFE]: "# Caf\u00e9\n\nEdited on the other clone.\n" });
    writeFileSync(join(root, CAFE), "# Caf\u00e9\n\nEdited here.\n");
    git(root, "commit", "-qam", "local edit");
    git(root, "config", "core.quotePath", "true");

    const pull = JSON.parse((await runCli(root, ["sync", "pull", "--json"])).stdout);
    expect(pull.status).toBe("conflicted");
    expect(pull.conflicts).toEqual([CAFE]);
    const { files } = JSON.parse((await runCli(root, ["sync", "conflicts", "--json"])).stdout);
    expect(files.map((f: { file: string }) => f.file)).toEqual([CAFE]);
    expect(files[0].ours).toBe("# Caf\u00e9\n\nEdited here.");
    expect(files[0].theirs).toBe("# Caf\u00e9\n\nEdited on the other clone.");
  });

  test("a squash merge (branch.main.mergeOptions) that stops on a conflict is conflicted, though it leaves no MERGE_HEAD", async () => {
    const root = diverged("# Loose idea\n\nEdited here and committed.\n");
    git(root, "commit", "-qam", "local edit");
    git(root, "config", "branch.main.mergeOptions", "--squash");

    const result = await runCli(root, ["sync", "pull", "--json"]);
    const body = JSON.parse(result.stdout);
    expect(body.status).toBe("conflicted");
    expect(body.conflicts).toEqual([NOTE]);
    expect(result.code).toBe(0);
  });

  test("a merge left unfinished before the pull, with nothing unmerged, is merge-failed, not an empty conflict", async () => {
    const { root, remote } = brainWithRemote();
    pushFromOtherClone(remote, { "elsewhere.md": "# Elsewhere\n" });
    writeFileSync(join(root, "local-note.md"), "# Local\n");
    git(root, "add", "local-note.md");
    git(root, "commit", "-qm", "local content");
    git(root, "fetch", "-q", "origin", "main");
    git(root, "merge", "--no-commit", "--no-ff", "origin/main");
    expect(git(root, "rev-parse", "-q", "--verify", "MERGE_HEAD")).not.toBe("");

    const result = await runCli(root, ["sync", "pull", "--json"]);
    const body = JSON.parse(result.stdout);
    expect(body.status).toBe("merge-failed");
    expect(body.conflicts).toEqual([]);
    expect(result.code).toBe(1);
  });

  test("a merge commit a hook rejects is merge-failed, though the merge left a MERGE_HEAD", async () => {
    const { root, remote } = brainWithRemote();
    pushFromOtherClone(remote, { "elsewhere.md": "# Elsewhere\n" });
    writeFileSync(join(root, "local-note.md"), "# Local\n");
    git(root, "add", "local-note.md");
    git(root, "commit", "-qm", "local content");
    hook(root, "pre-merge-commit", "exit 1");

    const result = await runCli(root, ["sync", "pull", "--json"]);
    const body = JSON.parse(result.stdout);
    expect(body.status).toBe("merge-failed");
    expect(body.conflicts).toEqual([]);
    expect(result.code).toBe(1);
  });

  test("a cache-only conflict whose concluding commit a hook rejects is merge-failed, not conflicted with nothing listed", async () => {
    const { root } = cacheConflict();
    hook(root, "pre-commit", "exit 1");

    const result = await runCli(root, ["sync", "pull", "--json"]);
    const body = JSON.parse(result.stdout);
    expect(body.status).toBe("merge-failed");
    expect(body.conflicts).toEqual([]);
    expect(body.mergedCaches).toEqual([CACHE]);
    expect(result.code).toBe(1);
  });

  test("a cache conflict a squash merge left unmerged, without MERGE_HEAD, is resolved from the stages", async () => {
    const { root } = cacheConflict();
    git(root, "fetch", "-q", "origin", "main");
    Bun.spawnSync(["git", "-C", root, "merge", "--squash", "origin/main"]);
    expect(git(root, "diff", "--name-only", "--diff-filter=U")).toBe(CACHE);
    expect(Bun.spawnSync(["git", "-C", root, "rev-parse", "-q", "--verify", "MERGE_HEAD"]).exitCode).not.toBe(0);

    const result = await runCli(root, ["sync", "pull", "--json"]);
    const body = JSON.parse(result.stdout);
    expect(body.conflicts).toEqual([]);
    expect(await Bun.file(join(root, CACHE)).text()).toBe('{"k":"a","v":"theirs"}\n{"k":"b","v":"base"}\n');
    expect(body.status).toBe("merged");
    // A squash commit has no second parent, so "merged" needs the pull to
    // merge origin/main after committing it (#328).
    expect(Bun.spawnSync(["git", "-C", root, "merge-base", "--is-ancestor", "origin/main", "HEAD"]).exitCode).toBe(0);
  });
});

describe("two clones that generated different text for one key (#408)", () => {
  /** A clone of `remote` that can run the CLI, with brain.db kept out of git. */
  function cloneBrain(remote: string): string {
    const root = join(remote, "..", "clone-b");
    Bun.spawnSync(["git", "clone", "-q", remote, root]);
    git(root, "config", "user.name", "Alex Example");
    git(root, "config", "user.email", "alex@example.test");
    git(root, "config", "commit.gpgsign", "false");
    writeFileSync(join(root, ".git", "info", "exclude"), "node_modules\nbrain.db*\n");
    symlinkSync(join(import.meta.dir, "..", "..", "..", "node_modules"), join(root, "node_modules"));
    return root;
  }

  /** Index `root`, give the chunk under `key` this clone's context, and bank it the way an embeddings run does. */
  async function generate(root: string, value: string, key?: string): Promise<string> {
    expect((await runCli(root, ["index", "--json"])).code).toBe(0);
    const db = new Database(join(root, "brain.db"));
    try {
      const chunks = db
        .prepare(
          `SELECT c.id, c.heading, c.content, d.title FROM chunks c JOIN documents d ON d.id = c.document_id
           WHERE d.asset_type = 'markdown' ORDER BY d.path, c.chunk_index`
        )
        .all() as { id: number; heading: string; content: string; title: string }[];
      const chunk = key
        ? chunks.find((c) => chunkContextKey(c.title, c.heading, c.content) === key)
        : chunks[0];
      expect(chunk).toBeDefined();
      db.prepare("UPDATE chunks SET context = ? WHERE id = ?").run(value, chunk!.id);
      saveContextCache(db, root);
      return chunkContextKey(chunk!.title, chunk!.heading, chunk!.content);
    } finally {
      db.close();
    }
  }

  test("end with byte-identical caches and one cache commit between them", async () => {
    const { root: a, remote } = brainWithRemote();
    writeFileSync(join(a, ".git", "info", "exclude"), "node_modules\nbrain.db*\n");
    const b = cloneBrain(remote);

    // Both clones generate a context for the same chunk before either syncs.
    const key = await generate(a, "alpha from clone A");
    await generate(b, "beta from clone B", key);
    expect(readFileSync(join(b, CACHE), "utf-8")).toContain("beta from clone B");

    const postA = JSON.parse((await runCli(a, ["sync", "post-sync", "--json"])).stdout);
    expect(postA.cacheCommit).toBe(`committed + pushed (${CACHE})`);

    const pulled = JSON.parse((await runCli(b, ["sync", "pull", "--json"])).stdout);
    expect(pulled.status).toBe("fast-forwarded");
    // B's database still holds its own text; its next embeddings run banks it.
    await generate(b, "beta from clone B", key);
    const postB = JSON.parse((await runCli(b, ["sync", "post-sync", "--json"])).stdout);
    expect(postB.cacheCommit).toBe("clean");

    const again = JSON.parse((await runCli(a, ["sync", "pull", "--json"])).stdout);
    expect(again.status).toBe("synced");
    const cacheA = readFileSync(join(a, CACHE), "utf-8");
    expect(readFileSync(join(b, CACHE), "utf-8")).toBe(cacheA);
    expect(cacheA).toBe(`${JSON.stringify({ k: key, v: "alpha from clone A" })}\n`);
    expect(git(a, "log", "--format=%s", "origin/main", "--", CACHE).split("\n")).toEqual([
      "Refresh derived index caches",
      "fixture",
    ]);
  }, 120_000);
});
