/**
 * Ignoring what `assess` classes ARTIFACT or SENSITIVE, against real
 * repositories. An artifact is ignored by the pattern it matched, a secret by
 * its own path; nothing is deleted, a tracked file is only reported, and the
 * commit carries `.gitignore` alone.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  appendIgnoreLines,
  applyIgnores,
  exactIgnoreLine,
  planIgnores,
  type AssessedFile,
  type IgnorePlan,
} from "../src/lib/sync/artifacts.js";

const ARTIFACT = [".DS_Store", "*.swp", "*~", "*.log", "tmp/*"];
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", "-C", cwd, ...args]);
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

/** A repository with one commit, a local empty hooks directory, and Odysseus as its author. */
function repo(files: Record<string, string> = { "notes.md": "# Notes\n" }): string {
  const base = mkdtempSync(join(tmpdir(), "brain-sync-artifacts-"));
  dirs.push(base);
  const root = join(base, "brain");
  mkdirSync(join(base, "hooks"));
  Bun.spawnSync(["git", "init", "-q", "-b", "main", root]);
  git(root, "config", "user.name", "Odysseus");
  git(root, "config", "user.email", "odysseus@example.test");
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

const untracked = (klass: AssessedFile["class"], path: string): AssessedFile => ({ status: "?", class: klass, path });

describe("planIgnores", () => {
  test("an artifact gets the pattern it matched, once however often it recurs", () => {
    const plan = planIgnores(
      [untracked("ARTIFACT", ".DS_Store"), untracked("ARTIFACT", "trips/.DS_Store"), untracked("ARTIFACT", "draft.md.swp")],
      { artifact: ARTIFACT }
    );
    expect(plan.additions).toEqual([
      { line: ".DS_Store", reason: "artifact", paths: [".DS_Store", "trips/.DS_Store"] },
      { line: "*.swp", reason: "artifact", paths: ["draft.md.swp"] },
    ]);
  });

  test("a sensitive file gets its exact, anchored path and never a glob", () => {
    const plan = planIgnores([untracked("SENSITIVE", "config/.env"), untracked("SENSITIVE", "navigator_token.txt")], {
      artifact: ARTIFACT,
      sensitive: [".env", "*_token*"],
    });
    expect(plan.additions).toEqual([
      { line: "/config/.env", reason: "sensitive", paths: ["config/.env"] },
      { line: "/navigator_token.txt", reason: "sensitive", paths: ["navigator_token.txt"] },
    ]);
  });

  test("a tracked artifact or secret is reported, not given a line", () => {
    const plan = planIgnores(
      [{ status: "M", class: "ARTIFACT", path: "debug.log" }, { status: "A", class: "SENSITIVE", path: ".env" }],
      { artifact: ARTIFACT }
    );
    expect(plan.additions).toEqual([]);
    expect(plan.tracked).toEqual([
      { path: "debug.log", reason: "artifact" },
      { path: ".env", reason: "sensitive" },
    ]);
  });

  test("a pattern that would also match a file assess keeps visible falls back to the exact path", () => {
    // `*.log` would hide the TRACK file `field.log` too.
    const plan = planIgnores([untracked("ARTIFACT", "build.log"), untracked("TRACK", "field.log")], { artifact: ARTIFACT });
    expect(plan.additions).toEqual([{ line: "/build.log", reason: "artifact", paths: ["build.log"] }]);
    expect(plan.visible).toEqual(["field.log"]);
  });

  test("a pattern git would read as a wildcard is not used as a line", () => {
    const plan = planIgnores([untracked("ARTIFACT", "a?.tmp")], { artifact: ["a?.tmp"] });
    expect(plan.additions.map((a) => a.line)).toEqual(["/a\\?.tmp"]);
  });

  test("a path with a line break cannot be named by any line", () => {
    const plan = planIgnores([untracked("SENSITIVE", "odd\n.env")], { artifact: ARTIFACT });
    expect(plan.additions).toEqual([]);
    expect(plan.unignorable).toEqual([{ path: "odd\n.env", reason: "sensitive" }]);
  });
});

describe("exactIgnoreLine", () => {
  test("escapes glob characters, a backslash and trailing spaces", () => {
    expect(exactIgnoreLine("a*b?[c].key")).toBe("/a\\*b\\?\\[c].key");
    expect(exactIgnoreLine("back\\slash.pem")).toBe("/back\\\\slash.pem");
    expect(exactIgnoreLine("trailing.pem  ")).toBe("/trailing.pem\\ \\ ");
  });
});

describe("appendIgnoreLines", () => {
  test("opens a `# brain sync` block after a blank line and keeps the final newline", () => {
    expect(appendIgnoreLines("node_modules/\n", ["*.log"])).toBe("node_modules/\n\n# brain sync\n*.log\n");
  });

  test("a file without a final newline still has none", () => {
    expect(appendIgnoreLines("node_modules/", ["*.log"])).toBe("node_modules/\n\n# brain sync\n*.log");
  });

  test("keeps CRLF line endings", () => {
    expect(appendIgnoreLines("node_modules/\r\n", ["*.log"])).toBe("node_modules/\r\n\r\n# brain sync\r\n*.log\r\n");
  });

  test("continues a block the file already ends in", () => {
    expect(appendIgnoreLines("a\n\n# brain sync\n*.log\n", ["/.env"])).toBe("a\n\n# brain sync\n*.log\n/.env\n");
  });

  test("an empty file is the block alone", () => {
    expect(appendIgnoreLines("", [".DS_Store"])).toBe("# brain sync\n.DS_Store\n");
  });
});

describe("applyIgnores", () => {
  test("appends the lines, deletes nothing, and commits `.gitignore` alone", () => {
    const root = repo({ "notes.md": "# Notes\n", ".gitignore": "node_modules/\n" });
    write(root, ".DS_Store", "finder");
    write(root, "config/.env", "TOKEN=fictional\n");
    write(root, "staged.md", "staged by someone else\n");
    git(root, "add", "staged.md");
    write(root, "notes.md", "# Notes\n\nedited, not staged\n");
    const before = git(root, "rev-parse", "HEAD");

    const result = applyIgnores(root, planIgnores([untracked("ARTIFACT", ".DS_Store"), untracked("SENSITIVE", "config/.env")], { artifact: ARTIFACT }));

    expect(result.added).toEqual([".DS_Store", "/config/.env"]);
    expect(result.notIgnored).toEqual([]);
    expect(result.commit?.status).toBe("committed");
    expect(readFileSync(join(root, ".gitignore"), "utf-8")).toBe("node_modules/\n\n# brain sync\n.DS_Store\n/config/.env\n");
    // Never deletes: the ignored files are still on disk.
    expect(existsSync(join(root, ".DS_Store"))).toBe(true);
    expect(existsSync(join(root, "config/.env"))).toBe(true);
    // One commit, `.gitignore` only, with the fixed message.
    expect(git(root, "rev-parse", "HEAD~1")).toBe(before);
    expect(git(root, "show", "--name-only", "--format=%s", "HEAD")).toBe("Ignore generated artifacts and secrets\n\n.gitignore");
    // Someone else's staged and unstaged work is left as it was.
    expect(git(root, "diff", "--cached", "--name-only")).toBe("staged.md");
    expect(git(root, "diff", "--name-only")).toBe("notes.md");
  });

  test("is idempotent: a second run adds nothing and commits nothing", () => {
    const root = repo();
    write(root, "debug.log", "noise\n");
    const plan = planIgnores([untracked("ARTIFACT", "debug.log")], { artifact: ARTIFACT });
    expect(applyIgnores(root, plan).commit?.status).toBe("committed");
    const head = git(root, "rev-parse", "HEAD");
    const text = readFileSync(join(root, ".gitignore"), "utf-8");

    const again = applyIgnores(root, plan);
    expect(again).toEqual({ added: [], present: ["*.log"], notIgnored: [], commit: null });
    expect(readFileSync(join(root, ".gitignore"), "utf-8")).toBe(text);
    expect(git(root, "rev-parse", "HEAD")).toBe(head);
  });

  test("creates `.gitignore` when there is none and commits it", () => {
    const root = repo();
    write(root, "draft.md~", "backup\n");
    const result = applyIgnores(root, planIgnores([untracked("ARTIFACT", "draft.md~")], { artifact: ARTIFACT }));
    expect(result.commit?.status).toBe("committed");
    expect(git(root, "show", "HEAD:.gitignore")).toBe("# brain sync\n*~");
  });

  test("a line that would hide a visible file is undone and refused", () => {
    const root = repo({ "notes.md": "# Notes\n", ".gitignore": "node_modules/" });
    write(root, "field.md", "# Field notes\n");
    const head = git(root, "rev-parse", "HEAD");
    // A hand-built plan whose line is broader than its file.
    const plan: IgnorePlan = {
      additions: [{ line: "*.md", reason: "artifact", paths: ["scratch.md"] }],
      tracked: [],
      unignorable: [],
      visible: ["field.md"],
    };
    const result = applyIgnores(root, plan);
    expect(result.refused).toBe("the lines would hide field.md");
    expect(result.added).toEqual([]);
    expect(readFileSync(join(root, ".gitignore"), "utf-8")).toBe("node_modules/");
    expect(git(root, "rev-parse", "HEAD")).toBe(head);
  });

  test("a `.gitignore` this call created and then refused is removed again", () => {
    const root = repo();
    write(root, "field.md", "# Field notes\n");
    const plan: IgnorePlan = { additions: [{ line: "*.md", reason: "artifact", paths: [] }], tracked: [], unignorable: [], visible: ["field.md"] };
    expect(applyIgnores(root, plan).refused).toBe("the lines would hide field.md");
    expect(existsSync(join(root, ".gitignore"))).toBe(false);
  });

  test("a `.gitignore` with uncommitted edits gets the lines but no commit", () => {
    const root = repo({ "notes.md": "# Notes\n", ".gitignore": "node_modules/\n" });
    write(root, ".gitignore", "node_modules/\ndist/\n");
    write(root, "debug.log", "noise\n");
    const head = git(root, "rev-parse", "HEAD");
    const result = applyIgnores(root, planIgnores([untracked("ARTIFACT", "debug.log")], { artifact: ARTIFACT }));
    expect(result.added).toEqual(["*.log"]);
    expect(result.commit).toEqual({ status: "skipped", reason: ".gitignore had uncommitted changes; commit it with them" });
    expect(git(root, "rev-parse", "HEAD")).toBe(head);
    expect(readFileSync(join(root, ".gitignore"), "utf-8")).toBe("node_modules/\ndist/\n\n# brain sync\n*.log\n");
  });

  test("a path a nested `.gitignore` re-includes is reported as not ignored", () => {
    const root = repo({ "notes.md": "# Notes\n", "logs/.gitignore": "!keep.log\n" });
    write(root, "logs/keep.log", "kept on purpose\n");
    const result = applyIgnores(root, planIgnores([untracked("ARTIFACT", "logs/keep.log")], { artifact: ARTIFACT }));
    expect(result.added).toEqual(["*.log"]);
    expect(result.notIgnored).toEqual(["logs/keep.log"]);
  });
});
