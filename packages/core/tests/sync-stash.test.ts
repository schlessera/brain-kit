/**
 * Settling the stash, against real repositories. An entry the working tree
 * already holds is dropped, whoever made it; an autostash that applies
 * cleanly is popped; everything else is kept with a reason. Nothing clears
 * the stash, and no working-tree file is overwritten.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { reconcileStashes } from "../src/lib/sync/stash.js";
import { mergeFileMarkers } from "./sync-fixture";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function run(cwd: string, ...args: string[]): { out: string; code: number } {
  const result = Bun.spawnSync(["git", "-C", cwd, ...args]);
  return { out: (result.stdout.toString() + result.stderr.toString()).trim(), code: result.exitCode ?? 0 };
}

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", "-C", cwd, ...args]);
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

/** A repository with one commit, a local empty hooks directory, and Alex Example as its author. */
function repo(files: Record<string, string>): string {
  const base = mkdtempSync(join(tmpdir(), "brain-sync-stash-"));
  dirs.push(base);
  const root = join(base, "brain");
  mkdirSync(join(base, "hooks"));
  Bun.spawnSync(["git", "init", "-q", "-b", "main", root]);
  git(root, "config", "user.name", "Alex Example");
  git(root, "config", "user.email", "alex@example.test");
  git(root, "config", "commit.gpgsign", "false");
  git(root, "config", "core.hooksPath", join(base, "hooks"));
  for (const [path, text] of Object.entries(files)) write(root, path, text);
  git(root, "add", "-A");
  git(root, "commit", "-qm", "fixture");
  return root;
}

function write(root: string, path: string, text: string): void {
  mkdirSync(join(root, path, ".."), { recursive: true });
  writeFileSync(join(root, path), text);
}

const read = (root: string, path: string) => readFileSync(join(root, path), "utf-8");
const stashes = (root: string) => git(root, "stash", "list", "--format=%H %gs").split("\n").filter(Boolean);

/** Stash the working tree as an autostash, the way `git rebase --autostash` saves one it cannot re-apply. */
function autostash(root: string): string {
  const sha = git(root, "stash", "create");
  git(root, "stash", "store", "-m", "autostash", sha);
  git(root, "reset", "-q", "--hard");
  return sha;
}

const TRAIL = "# Ridge Loop\n\nStatus: open\n\nWashout at mile 3.\n";
/** Twelve lines, so that edits at lines 2-3 and 10-11 have separate contexts. */
const LONG = Array.from({ length: 12 }, (_, i) => `Line ${i + 1}.`).join("\n") + "\n";

describe("reconcileStashes: the F8 shape", () => {
  /**
   * A stash of a local edit, then an upstream edit to the same line, so
   * `git stash pop` conflicts and leaves the entry in the stash. The conflict
   * is resolved by hand and unstaged (`git restore --staged`), as a pull
   * concluding a stash-pop leftover does.
   */
  function conflictedPop(): string {
    const root = repo({ "trails/ridge.md": TRAIL });
    write(root, "trails/ridge.md", TRAIL.replace("Status: open", "Status: closed for bears"));
    git(root, "stash", "-q");
    write(root, "trails/ridge.md", TRAIL.replace("Status: open", "Status: open, detour at mile 2"));
    git(root, "commit", "-qam", "upstream");
    expect(run(root, "stash", "pop").code).not.toBe(0);
    expect(stashes(root)).toHaveLength(1);
    return root;
  }

  test("a pop resolved by hand to keep the stash's change leaves the entry subsumed, and it is dropped", () => {
    const root = conflictedPop();
    const resolved = TRAIL.replace("Status: open", "Status: closed for bears");
    write(root, "trails/ridge.md", resolved);
    git(root, "restore", "--staged", "trails/ridge.md");

    const report = reconcileStashes(root);
    expect(report.dropped.map((e) => e.ref)).toEqual(["stash@{0}"]);
    expect(report.kept).toEqual([]);
    expect(stashes(root)).toEqual([]);
    expect(read(root, "trails/ridge.md")).toBe(resolved);
  });

  // Its line is there, but not where the stash put it: the line above it is
  // new. Keeping an entry costs a stash entry; dropping a wrong one, a change.
  test("a pop resolved to both sides' lines keeps the entry: the stash's change is not in its context", () => {
    const root = conflictedPop();
    const resolved = TRAIL.replace("Status: open", "Status: open, detour at mile 2\nStatus: closed for bears");
    write(root, "trails/ridge.md", resolved);
    git(root, "restore", "--staged", "trails/ridge.md");

    const report = reconcileStashes(root);
    expect(report.dropped).toEqual([]);
    expect(report.kept.map((e) => e.reason)).toEqual([
      "not an autostash, and trails/ridge.md lacks the stash's change in its context",
    ]);
    expect(read(root, "trails/ridge.md")).toBe(resolved);
  });

  test("a pop resolved without the stash's change keeps the entry", () => {
    const root = conflictedPop();
    const resolved = TRAIL.replace("Status: open", "Status: open, detour at mile 2");
    write(root, "trails/ridge.md", resolved);
    git(root, "restore", "--staged", "trails/ridge.md");

    const report = reconcileStashes(root);
    expect(report.dropped).toEqual([]);
    expect(report.kept.map((e) => e.reason)).toEqual(["not an autostash, and trails/ridge.md lacks the stash's change in its context"]);
    expect(stashes(root)).toHaveLength(1);
    expect(read(root, "trails/ridge.md")).toBe(resolved);
  });

  test("while the pop is still unmerged, every entry is kept", () => {
    const root = conflictedPop();
    const report = reconcileStashes(root);
    expect(report.kept.map((e) => e.reason)).toEqual(["the index has unmerged paths"]);
    expect(stashes(root)).toHaveLength(1);
  });

  test("markers of another size (conflict-marker-size=10) prove nothing either", () => {
    const root = conflictedPop();
    const upstream = TRAIL.replace("Status: open", "Status: open, detour at mile 2");
    const marked = mergeFileMarkers(TRAIL, upstream, TRAIL.replace("Status: open", "Status: closed for bears"), 10);
    expect(marked).toContain(`${"<".repeat(10)} HEAD\n`);
    write(root, "trails/ridge.md", marked);
    git(root, "restore", "--staged", "trails/ridge.md");

    const report = reconcileStashes(root);
    expect(report.dropped).toEqual([]);
    expect(report.kept.map((e) => e.reason)).toEqual(["not an autostash, and trails/ridge.md holds conflict markers"]);
  });

  test("a resolution that still holds conflict markers proves nothing", () => {
    const root = conflictedPop();
    // The file as the conflicted pop left it: both lines, between markers.
    git(root, "restore", "--staged", "trails/ridge.md");
    expect(read(root, "trails/ridge.md")).toContain("<<<<<<<");
    const report = reconcileStashes(root);
    expect(report.dropped).toEqual([]);
    expect(report.kept[0]!.reason).toContain("holds conflict markers");
  });
});

describe("reconcileStashes", () => {
  test("a user's entry that applies cleanly is kept, not popped", () => {
    const root = repo({ "trails/ridge.md": TRAIL });
    write(root, "trails/ridge.md", TRAIL + "\nBridge planks loose.\n");
    git(root, "stash", "push", "-q", "-m", "bridge notes");

    const report = reconcileStashes(root);
    expect(report.popped).toEqual([]);
    expect(report.kept.map((e) => [e.message, e.reason])).toEqual([
      ["On main: bridge notes", "not an autostash, and trails/ridge.md lacks the stash's change in its context"],
    ]);
    expect(stashes(root)).toHaveLength(1);
    expect(read(root, "trails/ridge.md")).toBe(TRAIL);
  });

  test("an autostash that applies cleanly is popped", () => {
    const root = repo({ "trails/ridge.md": TRAIL });
    write(root, "trails/ridge.md", TRAIL + "\nBridge planks loose.\n");
    const sha = autostash(root);

    const report = reconcileStashes(root);
    expect(report.popped).toEqual([{ ref: "stash@{0}", sha, message: "autostash" }]);
    expect(stashes(root)).toEqual([]);
    expect(read(root, "trails/ridge.md")).toBe(TRAIL + "\nBridge planks loose.\n");
  });

  // `git stash pop` without `--index` would restore the working version and
  // drop the entry holding the staged one.
  test("an autostash that stages a version other than its working one is kept, not popped", () => {
    const root = repo({ "trails/ridge.md": TRAIL });
    write(root, "trails/ridge.md", TRAIL.replace("Status: open", "Status: closed"));
    git(root, "add", "trails/ridge.md");
    write(root, "trails/ridge.md", TRAIL.replace("Status: open", "Status: flooded"));
    const sha = autostash(root);
    expect(git(root, "show", `${sha}^2:trails/ridge.md`)).toContain("Status: closed");

    const report = reconcileStashes(root);
    expect(report.popped).toEqual([]);
    expect(report.kept.map((e) => [e.sha, e.reason])).toEqual([
      [sha, "trails/ridge.md lacks the stash's change in its context, and it stages a version of trails/ridge.md that a pop would lose"],
    ]);
    expect(stashes(root)).toHaveLength(1);
    expect(read(root, "trails/ridge.md")).toBe(TRAIL);
  });

  test("an autostash whose staged version is its working one is popped", () => {
    const root = repo({ "trails/ridge.md": TRAIL });
    write(root, "trails/ridge.md", TRAIL.replace("Status: open", "Status: closed"));
    git(root, "add", "trails/ridge.md");
    autostash(root);

    const report = reconcileStashes(root);
    expect(report.popped).toHaveLength(1);
    expect(read(root, "trails/ridge.md")).toBe(TRAIL.replace("Status: open", "Status: closed"));
  });

  test("a drop or pop git refuses (refs/stash locked) is failed, not kept", () => {
    const root = repo({ "trails/ridge.md": TRAIL, "trails/lake.md": "# Lake Path\n" });
    write(root, "trails/ridge.md", TRAIL + "\nBridge planks loose.\n");
    autostash(root);
    write(root, "trails/lake.md", "# Lake Path\n\nIce out.\n");
    git(root, "stash", "push", "-q", "-m", "lake");
    // The tree holds the lake entry's change again, so it is dropped.
    write(root, "trails/lake.md", "# Lake Path\n\nIce out.\n");
    writeFileSync(join(root, ".git", "refs", "stash.lock"), "");

    const report = reconcileStashes(root);
    expect(report.kept).toEqual([]);
    expect(report.dropped).toEqual([]);
    expect(report.popped).toEqual([]);
    expect(report.failed.map((e) => [e.ref, e.reason.split(":")[0]])).toEqual([
      ["stash@{1}", "pop failed"],
      ["stash@{0}", "drop failed"],
    ]);
    expect(stashes(root)).toHaveLength(2);
  });

  test("an autostash whose path has local changes is kept, and the file is not touched", () => {
    const root = repo({ "trails/ridge.md": TRAIL });
    write(root, "trails/ridge.md", TRAIL + "\nBridge planks loose.\n");
    autostash(root);
    const local = TRAIL + "\nTrail crew booked.\n";
    write(root, "trails/ridge.md", local);

    const report = reconcileStashes(root);
    expect(report.popped).toEqual([]);
    expect(report.kept[0]!.reason).toContain("its paths have local changes: trails/ridge.md");
    expect(stashes(root)).toHaveLength(1);
    expect(read(root, "trails/ridge.md")).toBe(local);
  });

  test("an autostash that does not apply is kept", () => {
    const root = repo({ "trails/ridge.md": TRAIL });
    write(root, "trails/ridge.md", TRAIL.replace("Status: open", "Status: closed"));
    autostash(root);
    write(root, "trails/ridge.md", TRAIL.replace("Status: open", "Status: flooded"));
    git(root, "commit", "-qam", "upstream");

    const report = reconcileStashes(root);
    expect(report.popped).toEqual([]);
    expect(report.kept[0]!.reason).toContain("it does not apply cleanly");
    expect(read(root, "trails/ridge.md")).toBe(TRAIL.replace("Status: open", "Status: flooded"));
  });

  test("an entry that deletes a file is subsumed only while the file is absent", () => {
    const root = repo({ "trails/ridge.md": TRAIL, "trails/old.md": "# Old\n" });
    rmSync(join(root, "trails/old.md"));
    git(root, "stash", "-q");
    // Absent now (deleted and committed): subsumed.
    git(root, "rm", "-q", "trails/old.md");
    git(root, "commit", "-qm", "drop old");
    expect(reconcileStashes(root).dropped).toHaveLength(1);

    const again = repo({ "trails/ridge.md": TRAIL, "trails/old.md": "# Old\n" });
    rmSync(join(again, "trails/old.md"));
    git(again, "stash", "-q");
    const report = reconcileStashes(again);
    expect(report.kept.map((e) => e.reason)).toEqual(["not an autostash, and trails/old.md is deleted in the stash but present"]);
    expect(existsSync(join(again, "trails/old.md"))).toBe(true);
  });

  test("an untracked file in the entry is held only while the tree has it as the stash does", () => {
    const root = repo({ "trails/ridge.md": TRAIL });
    write(root, "trails/lake.md", "# Lake Path\n");
    git(root, "stash", "push", "-q", "--include-untracked");
    expect(existsSync(join(root, "trails/lake.md"))).toBe(false);
    write(root, "trails/lake.md", "# Lake Path\n\nAdded later.\n");
    expect(reconcileStashes(root).kept.map((e) => e.reason)).toEqual([
      "not an autostash, and trails/lake.md is not the file the stash adds",
    ]);

    write(root, "trails/lake.md", "# Lake Path\n");
    expect(reconcileStashes(root).dropped).toHaveLength(1);
    expect(read(root, "trails/lake.md")).toBe("# Lake Path\n");
  });

  test("an untracked file in the entry that the tree lacks keeps it", () => {
    const root = repo({ "trails/ridge.md": TRAIL });
    write(root, "trails/lake.md", "# Lake Path\n");
    git(root, "stash", "push", "-q", "--include-untracked");
    const report = reconcileStashes(root);
    expect(report.kept.map((e) => e.reason)).toEqual(["not an autostash, and trails/lake.md is missing"]);
  });

  test("a derived cache is held when the current one has every key", () => {
    const line = (k: string, v: string) => JSON.stringify({ k, v });
    const root = repo({ ".context-cache.jsonl": line("a", "1") + "\n" });
    write(root, ".context-cache.jsonl", [line("a", "1"), line("b", "2")].join("\n") + "\n");
    git(root, "stash", "-q");
    // The same keys, other values and order: a regenerated cache.
    write(root, ".context-cache.jsonl", [line("c", "3"), line("b", "2x"), line("a", "1x")].join("\n") + "\n");
    expect(reconcileStashes(root).dropped).toHaveLength(1);

    const lacking = repo({ ".context-cache.jsonl": line("a", "1") + "\n" });
    write(lacking, ".context-cache.jsonl", [line("a", "1"), line("b", "2")].join("\n") + "\n");
    git(lacking, "stash", "-q");
    write(lacking, ".context-cache.jsonl", [line("a", "1"), line("c", "3")].join("\n") + "\n");
    expect(reconcileStashes(lacking).kept.map((e) => e.reason)).toEqual([
      "not an autostash, and .context-cache.jsonl lacks cache entries the stash has",
    ]);
  });

  test("a line the stash removes must be gone from the tree", () => {
    const root = repo({ "trails/ridge.md": TRAIL });
    write(root, "trails/ridge.md", TRAIL.replace("Washout at mile 3.\n", ""));
    git(root, "stash", "-q");
    const report = reconcileStashes(root);
    expect(report.kept.map((e) => e.reason)).toEqual(["not an autostash, and trails/ridge.md lacks the stash's change in its context"]);
  });

  // A line count calls both of these held: every line is there as often.
  test("a stash that reorders lines is kept while the tree has them in the old order", () => {
    const root = repo({ "trails/order.md": "first\nsecond\n" });
    write(root, "trails/order.md", "second\nfirst\n");
    git(root, "stash", "-q");
    const report = reconcileStashes(root);
    expect(report.dropped).toEqual([]);
    expect(report.kept.map((e) => e.reason)).toEqual(["not an autostash, and trails/order.md lacks the stash's change in its context"]);
    expect(stashes(root)).toHaveLength(1);
  });

  test("a stash that moves a line to another section is kept while the tree has it where it was", () => {
    const before = "# Old\nvalue\n# New\n";
    const root = repo({ "trails/moved.md": before });
    write(root, "trails/moved.md", "# Old\n# New\nvalue\n");
    git(root, "stash", "-q");
    const report = reconcileStashes(root);
    expect(report.dropped).toEqual([]);
    expect(report.kept.map((e) => e.reason)).toEqual(["not an autostash, and trails/moved.md lacks the stash's change in its context"]);
    expect(read(root, "trails/moved.md")).toBe(before);
  });

  test("a stash's change is held where the tree has it in context, whatever changed elsewhere", () => {
    const root = repo({ "trails/long.md": LONG });
    write(root, "trails/long.md", LONG.replace("Line 3.", "Line 3, stashed."));
    git(root, "stash", "-q");
    write(root, "trails/long.md", LONG.replace("Line 3.", "Line 3, stashed.").replace("Line 10.", "Line 10, later."));
    expect(reconcileStashes(root).dropped).toHaveLength(1);
  });

  test("entries are settled from the highest index down, each by its own ref", () => {
    const root = repo({ "trails/long.md": LONG, "trails/lake.md": "# Lake Path\n" });
    // stash@{2}: subsumed once committed; stash@{1}: a user's, kept; stash@{0}: subsumed.
    write(root, "trails/long.md", LONG.replace("Line 2.", "Line 2, one."));
    git(root, "stash", "-q");
    write(root, "trails/lake.md", "# Lake Path\n\nKeep me.\n");
    git(root, "stash", "push", "-q", "-m", "keep");
    write(root, "trails/long.md", LONG.replace("Line 11.", "Line 11, two."));
    git(root, "stash", "-q");
    write(root, "trails/long.md", LONG.replace("Line 2.", "Line 2, one.").replace("Line 11.", "Line 11, two."));
    git(root, "commit", "-qam", "both");
    const kept = git(root, "rev-parse", "stash@{1}");

    const report = reconcileStashes(root);
    expect(report.dropped.map((e) => e.ref)).toEqual(["stash@{2}", "stash@{0}"]);
    expect(report.kept.map((e) => [e.ref, e.sha])).toEqual([["stash@{1}", kept]]);
    expect(stashes(root)).toEqual([`${kept} On main: keep`]);
  });

  test("dryRun reports and changes nothing", () => {
    const root = repo({ "trails/ridge.md": TRAIL });
    write(root, "trails/ridge.md", TRAIL + "\nBridge planks loose.\n");
    autostash(root);
    write(root, "trails/lake.md", "# Lake Path\n");
    git(root, "stash", "push", "-q", "--include-untracked", "-m", "lake");
    write(root, "trails/lake.md", "# Lake Path\n");
    const before = stashes(root);

    const report = reconcileStashes(root, { dryRun: true });
    expect(report.popped.map((e) => e.ref)).toEqual(["stash@{1}"]);
    expect(report.dropped.map((e) => e.ref)).toEqual(["stash@{0}"]);
    expect(stashes(root)).toEqual(before);
    expect(read(root, "trails/ridge.md")).toBe(TRAIL);
  });

  test("during a merge every entry is kept", () => {
    const root = repo({ "trails/ridge.md": TRAIL });
    write(root, "trails/ridge.md", TRAIL + "\nBridge planks loose.\n");
    autostash(root);
    // A merge stopped before committing: MERGE_HEAD is set, nothing unmerged.
    git(root, "checkout", "-qb", "side");
    write(root, "trails/lake.md", "# Lake Path\n");
    git(root, "add", "trails/lake.md");
    git(root, "commit", "-qm", "side");
    git(root, "checkout", "-q", "main");
    git(root, "merge", "-q", "--no-ff", "--no-commit", "side");

    const report = reconcileStashes(root);
    expect(report.kept.map((e) => e.reason)).toEqual(["a merge is in progress"]);
    expect(stashes(root)).toHaveLength(1);
  });

  /** A branch `side` with one commit adding `file`, and main checked out, with an autostash that would pop cleanly. */
  function sideAndAutostash(files: Record<string, string>): string {
    const root = repo({ "trails/ridge.md": TRAIL, "trails/lake.md": "# Lake Path\n" });
    write(root, "trails/ridge.md", TRAIL + "\nBridge planks loose.\n");
    autostash(root);
    git(root, "checkout", "-qb", "side");
    for (const [path, text] of Object.entries(files)) write(root, path, text);
    git(root, "commit", "-qam", "side");
    git(root, "checkout", "-q", "main");
    return root;
  }

  test("during a squash with something staged every entry is kept, though it leaves no MERGE_HEAD", () => {
    const root = sideAndAutostash({ "trails/lake.md": "# Lake Path\n\nSide.\n" });
    git(root, "merge", "-q", "--squash", "side");

    const report = reconcileStashes(root);
    expect(report.kept.map((e) => e.reason)).toEqual(["a squash is in progress"]);
    expect(stashes(root)).toHaveLength(1);
  });

  test("between the stops of a cherry-pick of several commits every entry is kept, though CHERRY_PICK_HEAD is gone", () => {
    const root = sideAndAutostash({ "trails/lake.md": "# Lake Path\n\nSide.\n" });
    git(root, "checkout", "-q", "side");
    write(root, "trails/lake.md", "# Lake Path\n\nSide, again.\n");
    git(root, "commit", "-qam", "side again");
    git(root, "checkout", "-q", "main");
    write(root, "trails/lake.md", "# Lake Path\n\nMain.\n");
    git(root, "commit", "-qam", "main");
    expect(run(root, "cherry-pick", "side~1", "side").code).not.toBe(0);
    write(root, "trails/lake.md", "# Lake Path\n\nResolved.\n");
    git(root, "add", "trails/lake.md");
    git(root, "commit", "-q", "--no-edit");
    expect(run(root, "rev-parse", "-q", "--verify", "CHERRY_PICK_HEAD").code).not.toBe(0);

    const report = reconcileStashes(root);
    expect(report.kept.map((e) => e.reason)).toEqual(["a cherry-pick is in progress"]);
    expect(stashes(root)).toHaveLength(1);
  });
});
