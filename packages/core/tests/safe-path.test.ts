import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { safeResolve } from "../src/lib/safe-path";

const fixtures: string[] = [];
afterAll(() => {
  for (const dir of fixtures) rmSync(dir, { recursive: true, force: true });
});

function makeRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "endoxa-safe-path-"));
  fixtures.push(dir);
  return dir;
}

describe("safeResolve", () => {
  test("resolves a contained relative path", () => {
    const root = makeRoot();
    mkdirSync(join(root, "notes"));
    writeFileSync(join(root, "notes/a.md"), "x");
    expect(safeResolve(root, "notes/a.md")).toBe(realpathSync(join(root, "notes/a.md")));
  });

  test("allows a not-yet-existing file under an existing real directory", () => {
    const root = makeRoot();
    mkdirSync(join(root, "notes"));
    const out = safeResolve(root, "notes/new.md");
    expect(out).toBe(join(realpathSync(root), "notes/new.md"));
  });

  test("allows a not-yet-existing nested directory chain", () => {
    const root = makeRoot();
    const out = safeResolve(root, "a/b/c/new.md");
    expect(out).toBe(join(realpathSync(root), "a/b/c/new.md"));
  });

  test("rejects .. escapes and absolute paths", () => {
    const root = makeRoot();
    expect(safeResolve(root, "../outside.md")).toBeNull();
    expect(safeResolve(root, "notes/../../outside.md")).toBeNull();
    expect(safeResolve(root, "/etc/passwd")).toBeNull();
  });

  test("rejects sibling-prefix paths", () => {
    const root = makeRoot();
    // /tmp/xxx vs /tmp/xxx-other: bare startsWith(root) would accept this.
    const sibling = root + "-other";
    mkdirSync(sibling);
    fixtures.push(sibling);
    expect(safeResolve(root, join("..", `${root.split("/").pop()}-other`, "x.md"))).toBeNull();
  });

  test("rejects an existing symlink that points outside the root", () => {
    const root = makeRoot();
    const outside = makeRoot();
    writeFileSync(join(outside, "secret.md"), "s");
    symlinkSync(join(outside, "secret.md"), join(root, "link.md"));
    expect(safeResolve(root, "link.md")).toBeNull();
  });

  test("rejects a NOT-yet-existing file under a symlinked parent that escapes the root", () => {
    const root = makeRoot();
    const outside = makeRoot();
    symlinkSync(outside, join(root, "sneaky"));
    // The target file does not exist, so the old lexical fallback would have
    // accepted this path — while the write would land in `outside`.
    expect(safeResolve(root, "sneaky/new.md")).toBeNull();
    expect(safeResolve(root, "sneaky/deep/new.md")).toBeNull();
  });

  test("allows a symlinked parent that stays inside the root", () => {
    const root = makeRoot();
    mkdirSync(join(root, "real"));
    symlinkSync(join(root, "real"), join(root, "alias"));
    const out = safeResolve(root, "alias/new.md");
    expect(out).toBe(join(realpathSync(root), "real/new.md"));
  });
});

describe("safeResolve — dangling and cyclic symlinks", () => {
  test("rejects a dangling symlink whose target would land outside the root", () => {
    const root = makeRoot();
    const outside = makeRoot();
    // Link exists, target does NOT — a write through it would be created at
    // the target. The old lexical fallback accepted this.
    symlinkSync(join(outside, "pwned.md"), join(root, "link.md"));
    expect(safeResolve(root, "link.md")).toBeNull();
    // Same with a dangling DIRECTORY link as a middle component.
    symlinkSync(join(outside, "no-such-dir"), join(root, "sneakydir"));
    expect(safeResolve(root, "sneakydir/new.md")).toBeNull();
  });

  test("accepts a dangling symlink whose target stays inside the root", () => {
    const root = makeRoot();
    symlinkSync(join(root, "not-yet.md"), join(root, "link.md"));
    expect(safeResolve(root, "link.md")).toBe(join(realpathSync(root), "not-yet.md"));
  });

  test("rejects a dangling symlink cycle instead of looping", () => {
    const root = makeRoot();
    symlinkSync(join(root, "b"), join(root, "a"));
    symlinkSync(join(root, "a"), join(root, "b"));
    expect(safeResolve(root, "a/x.md")).toBeNull();
  });

  test("returns null for a missing root and NUL bytes", () => {
    const root = makeRoot();
    expect(safeResolve(join(root, "does-not-exist"), "x.md")).toBeNull();
    expect(safeResolve(root, "a\0b.md")).toBeNull();
  });
});
