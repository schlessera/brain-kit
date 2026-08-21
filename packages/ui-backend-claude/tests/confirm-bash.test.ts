/**
 * Bash confirmation patterns.
 *
 * The hole these close: `Bash` is auto-allowed, and the SDK never consults
 * `canUseTool` for an allowlisted tool, so `brain archive x.md` typed into
 * Bash ran with no card while the identical operation through `brain_archive`
 * raised one. The gated path was the one the brain repo's own CLAUDE.md steers
 * away from, so in practice the confirmation almost never fired.
 *
 * These assert the matching, not the SDK plumbing: what must be true is that
 * the shipped set catches the commands it claims to and leaves ordinary work
 * alone. A pattern set that fires on `git status` would be turned off within a
 * day, and then it protects nothing.
 */
import { describe, expect, test } from "bun:test";

import { createClaudeBackend, DEFAULT_CONFIRM_BASH_PATTERNS } from "../src/backend.js";

const patterns = DEFAULT_CONFIRM_BASH_PATTERNS.map((p) => new RegExp(p, "i"));
const confirms = (command: string) => patterns.some((re) => re.test(command));

describe("commands that must raise a card", () => {
  test("brain archive, in the forms an agent actually writes", () => {
    // The reported case: "Archive X.md" became a Bash call, not the MCP tool.
    expect(confirms("brain archive notes/thing.md")).toBe(true);
    expect(confirms("bun node_modules/.bin/brain archive notes/thing.md")).toBe(true);
    expect(confirms("cd /data/brain && brain archive a.md")).toBe(true);
    expect(confirms("brain   archive   a.md")).toBe(true);
    expect(confirms("BRAIN_ROOT=/x brain archive a.md")).toBe(true);
  });

  test("recursive deletes, in their common spellings", () => {
    expect(confirms("rm -rf /data/brain/notes")).toBe(true);
    expect(confirms("rm -fr build")).toBe(true);
    expect(confirms("rm -r notes/old")).toBe(true);
    expect(confirms("rm -f -r notes/old")).toBe(true);
    expect(confirms("rm -R notes/old")).toBe(true);
  });

  test("history rewrites and working-tree discards", () => {
    expect(confirms("git push --force origin main")).toBe(true);
    expect(confirms("git push origin main --force-with-lease")).toBe(true);
    expect(confirms("git reset --hard HEAD~3")).toBe(true);
    expect(confirms("git clean -fd")).toBe(true);
    expect(confirms("git checkout -- notes/thing.md")).toBe(true);
  });
});

describe("commands that must NOT raise a card", () => {
  test("ordinary read-only work stays silent", () => {
    // The bar: if this list ever fires on everyday commands, someone disables
    // the whole mechanism and it stops protecting anything.
    for (const command of [
      "brain search 'foo'",
      "brain list --type note",
      "brain sync",
      "brain index --force",
      "git status",
      "git log --oneline -5",
      "git diff",
      "git push origin main",
      "git checkout main",
      "ls -la notes",
      "cat notes/thing.md",
      "rm notes/single-file.md",
      "grep -r pattern notes",
    ]) {
      expect(confirms(command), `${command} should not need confirmation`).toBe(false);
    }
  });

  test("a plain non-recursive rm is not confirmed", () => {
    // Deliberate: a single-file delete inside a git repo is ordinary work, and
    // confirming it would be the noise that gets the feature switched off.
    expect(confirms("rm notes/a.md")).toBe(false);
    expect(confirms("rm -f notes/a.md")).toBe(false);
  });

  test("the word archive alone is not enough", () => {
    expect(confirms("brain search archive")).toBe(false);
    expect(confirms("ls notes/archive")).toBe(false);
    expect(confirms("cat notes/archive/old.md")).toBe(false);
  });
});

describe("configurability", () => {
  test("the shipped set is exported so a deployment can extend or replace it", () => {
    expect(DEFAULT_CONFIRM_BASH_PATTERNS.length).toBeGreaterThan(0);
    // Every shipped source must compile — one that does not would be silently
    // skipped at runtime, i.e. a pattern that never fires.
    for (const source of DEFAULT_CONFIRM_BASH_PATTERNS) {
      expect(() => new RegExp(source, "i")).not.toThrow();
    }
  });

  test("matching is case-insensitive", () => {
    expect(confirms("BRAIN ARCHIVE a.md")).toBe(true);
    expect(confirms("RM -RF /")).toBe(true);
  });
});

describe("unparseable patterns", () => {
  test("are reported through the injected log callback, with the source", () => {
    const calls: Array<{ level: string; message: string; attrs?: Record<string, unknown> }> = [];

    createClaudeBackend({
      brainPath: "/tmp",
      confirmBashPatterns: ["(unclosed", String.raw`\brm\s`],
      log: (level, message, attrs) => calls.push({ level, message, attrs }),
    });

    // The valid pattern compiles silently; only the broken one is reported —
    // and through the callback, so a host's structured log receives it
    // instead of a bare console line.
    expect(calls.length).toBe(1);
    expect(calls[0].level).toBe("warn");
    expect(calls[0].message).toContain("confirmBashPatterns");
    expect(calls[0].attrs?.source).toBe("(unclosed");
    expect(calls[0].attrs?.error).toBeString();
  });
});
