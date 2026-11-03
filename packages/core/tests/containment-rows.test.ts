/**
 * core's row of the resolver matrix (#2506): `safeResolve(root, rel)` is
 * synchronous and returns the canonical path or `null`. Since #3422 it gives
 * the strictest answer in every row: it refuses an absolute request even
 * inside the root, any `..` segment, `:` or `\\` in a segment, a dangling
 * link wherever it points, a path that leaves through one link and comes back
 * through another, and everything when the root's realpath fails.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, relative } from "path";

import { SCRATCH_DIR } from "../src/lib/scratch";
import { safeResolve, safeResolveHeld } from "../src/lib/safe-path";

const base = realpathSync(mkdtempSync(join(tmpdir(), "brain-kit-containment-rows-")));
afterAll(() => rmSync(base, { recursive: true, force: true }));
const root = join(base, "brain");
const outside = join(base, "brain-other");

mkdirSync(join(root, "notes/sub"), { recursive: true });
mkdirSync(outside);
mkdirSync(join(root, ".brain/scratch"), { recursive: true });
writeFileSync(join(root, "notes/a.md"), "a");
writeFileSync(join(root, "file.md"), "f");
writeFileSync(join(outside, "secret.md"), "s");
writeFileSync(join(root, ".brain/scratch/s.txt"), "s");
symlinkSync("notes", join(root, "link-in"));
symlinkSync(outside, join(root, "link-out"));
symlinkSync("notes/missing", join(root, "dangling-in"));
symlinkSync(join(outside, "missing"), join(root, "dangling-out"));
symlinkSync("cycle-b", join(root, "cycle-a"));
symlinkSync("cycle-a", join(root, "cycle-b"));
symlinkSync(outside, join(root, "bounce"));
symlinkSync(join(root, "notes"), join(outside, "back"));
symlinkSync("../../notes", join(root, ".brain/scratch/link"));
symlinkSync(root, join(base, "root-link"));
// A dangling chain that leaves the root and comes back to a missing target inside.
symlinkSync(join(root, "notes/missing"), join(outside, "dangling-back"));
symlinkSync(join(outside, "dangling-back"), join(root, "dangling-bounce"));

/** The answer relative to the fixture base, or `refused`. */
const answer = (path: string | null) => (path === null ? "refused" : relative(base, path) || ".");

describe("core safeResolve(root, rel): its resolver row", () => {
  const rows: [string, string][] = [
    ["notes/a.md", "brain/notes/a.md"],
    ["notes/new.md", "brain/notes/new.md"],
    ["a/b/c.md", "brain/a/b/c.md"],
    ["", "brain"],
    [".", "brain"],
    ["./notes/a.md", "brain/notes/a.md"],
    ["notes//a.md", "brain/notes/a.md"],
    ["notes/a.md/", "brain/notes/a.md"],
    ["file.md/x", "brain/file.md/x"],
    // `..` is refused even when the result stays inside (#3422).
    ["notes/../notes/a.md", "refused"],
    ["notes/sub/..", "refused"],
    ["notes/../../x", "refused"],
    // Sibling prefix: `brain-other` starts with `brain`.
    ["../brain-other/secret.md", "refused"],
    // Absolute: refused even inside the root (#3422).
    [join(root, "notes/a.md"), "refused"],
    [root, "refused"],
    ["/etc/passwd", "refused"],
    // Windows syntax is refused in any segment (#3422).
    ["a:b", "refused"],
    ["notes/a:b.md", "refused"],
    ["a\\b", "refused"],
    ["\\notes", "refused"],
    ["a\0b", "refused"],
    // Links: canonical answers, escapes refused, including for a file that
    // does not exist yet under a symlinked parent.
    ["link-in/a.md", "brain/notes/a.md"],
    ["link-in/new.md", "brain/notes/new.md"],
    ["link-out/secret.md", "refused"],
    ["link-out/new.md", "refused"],
    // A dangling link is refused wherever it points (#3422).
    ["dangling-in", "refused"],
    ["dangling-in/x", "refused"],
    ["dangling-out", "refused"],
    // A dangling chain is refused as soon as it leaves the root, even when it
    // ends inside.
    ["dangling-bounce", "refused"],
    ["cycle-a", "refused"],
    ["cycle-a/x", "refused"],
    // Every component must stay inside, not only the final path: out through
    // one link and back through another is refused (#3422).
    ["bounce/back/a.md", "refused"],
    ["bounce/back", "refused"],
    // Scratch is not special to the resolver.
    [".brain", "brain/.brain"],
    [".brain/scratch/s.txt", "brain/.brain/scratch/s.txt"],
    [".brain/scratch/link", "brain/notes"],
    [".brain/scratch/link/a.md", "brain/notes/a.md"],
  ];
  for (const [rel, expected] of rows) {
    test(`${JSON.stringify(rel.startsWith(base) ? "<abs>/" + relative(base, rel) : rel)} -> ${expected}`, () => {
      expect(answer(safeResolve(root, rel))).toBe(expected);
    });
  }

  test("a root that is itself a symlink resolves against its target", () => {
    expect(answer(safeResolve(join(base, "root-link"), "notes/a.md"))).toBe("brain/notes/a.md");
  });

  test("a root whose realpath fails refuses everything", () => {
    expect(safeResolve(join(base, "nope"), "notes/a.md")).toBeNull();
    expect(safeResolve(join(root, "dangling-in"), "x")).toBeNull();
    expect(safeResolve(join(root, "file.md/x"), "x")).toBeNull();
  });

  test("each call reads the filesystem again: a directory swapped for an escaping link is refused", () => {
    const swap = join(root, "swap");
    mkdirSync(swap);
    expect(answer(safeResolve(root, "swap/new.md"))).toBe("brain/swap/new.md");
    renameSync(swap, join(base, "swapped-away"));
    symlinkSync(outside, swap);
    expect(safeResolve(root, "swap/new.md")).toBeNull();
    rmSync(swap);
    renameSync(join(base, "swapped-away"), swap);
    expect(answer(safeResolve(root, "swap/new.md"))).toBe("brain/swap/new.md");
  });
});

describe("core safeResolveHeld(root, abs): re-checking a path the caller holds (#3422)", () => {
  test("an absolute path under the root's realpath or the root as given gets safeResolve's answer", () => {
    expect(answer(safeResolveHeld(root, join(root, "notes/a.md")))).toBe("brain/notes/a.md");
    expect(answer(safeResolveHeld(root, root))).toBe("brain");
    expect(answer(safeResolveHeld(join(base, "root-link"), join(base, "root-link/notes/a.md")))).toBe("brain/notes/a.md");
    expect(answer(safeResolveHeld(join(base, "root-link"), join(root, "notes/a.md")))).toBe("brain/notes/a.md");
  });

  test("a relative path, a path outside the root and a path through a refused link are refused", () => {
    expect(safeResolveHeld(root, "notes/a.md")).toBeNull();
    expect(safeResolveHeld(root, join(outside, "secret.md"))).toBeNull();
    expect(safeResolveHeld(root, `${root}-other/secret.md`)).toBeNull();
    expect(safeResolveHeld(root, join(root, "bounce/back/a.md"))).toBeNull();
    expect(safeResolveHeld(root, join(root, "dangling-in"))).toBeNull();
    expect(safeResolveHeld(join(base, "nope"), join(base, "nope/x"))).toBeNull();
  });
});

test("core's scratch area is .brain/scratch", () => {
  expect(SCRATCH_DIR).toBe(".brain/scratch");
});
