/**
 * The ui-sdk's rows of the containment matrices (#2506). `resolveInRepo(root,
 * rel)` is core's resolver except that it refuses an absolute `rel`; the
 * predicates each keep their own argument order, equality, root `/` and
 * trailing-separator answers. Written against the copies the SDK carried
 * before the shared `@schlessera/brain-common/internal/safe-path`, and kept
 * unchanged across the move.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, relative } from "path";

import { maskInScratch, under as maskUnder } from "../src/server/bridge-tools/mask";
import { resolveInRepo } from "../src/server/bridge-tools/resolve-in-repo";
import { within as envMasksWithin } from "../src/server/maintenance-env-masks";
import { inside as poolInside } from "../src/server/native-reference-pool";
import { within as observerWithin } from "../src/server/worker-file-observer";
import { within as launcherWithin } from "../src/server/worker-launcher";
import { within as rtkWithin } from "../src/server/worker-rtk";
import { within as turnTempWithin } from "../src/server/worker-turn-temp";

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

/** The answer relative to the fixture base, or `refused`. */
const answer = (path: string | null) => (path === null ? "refused" : relative(base, path) || ".");

describe("ui-sdk resolveInRepo(root, rel): its resolver row", () => {
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
    // `..` is accepted while the result stays inside.
    ["notes/../notes/a.md", "brain/notes/a.md"],
    ["notes/../../x", "refused"],
    // Sibling prefix: `brain-other` starts with `brain`.
    ["../brain-other/secret.md", "refused"],
    // Absolute: refused even inside the root (core accepts it).
    [join(root, "notes/a.md"), "refused"],
    ["/etc/passwd", "refused"],
    // Windows syntax is not checked.
    ["a:b", "brain/a:b"],
    ["a\\b", "brain/a\\b"],
    ["a\0b", "refused"],
    ["link-in/a.md", "brain/notes/a.md"],
    ["link-in/new.md", "brain/notes/new.md"],
    ["link-out/secret.md", "refused"],
    ["link-out/new.md", "refused"],
    ["dangling-in", "brain/notes/missing"],
    ["dangling-in/x", "brain/notes/missing/x"],
    ["dangling-out", "refused"],
    ["cycle-a", "refused"],
    ["cycle-a/x", "refused"],
    ["bounce/back/a.md", "brain/notes/a.md"],
    [".brain", "brain/.brain"],
    [".brain/scratch/s.txt", "brain/.brain/scratch/s.txt"],
    [".brain/scratch/link", "brain/notes"],
    [".brain/scratch/link/a.md", "brain/notes/a.md"],
  ];
  for (const [rel, expected] of rows) {
    test(`${JSON.stringify(rel.startsWith(base) ? "<abs>/" + relative(base, rel) : rel)} -> ${expected}`, () => {
      expect(answer(resolveInRepo(root, rel))).toBe(expected);
    });
  }

  test("a root that is itself a symlink resolves against its target", () => {
    expect(answer(resolveInRepo(join(base, "root-link"), "notes/a.md"))).toBe("brain/notes/a.md");
  });

  test("a root whose realpath fails refuses everything", () => {
    expect(resolveInRepo(join(base, "nope"), "notes/a.md")).toBeNull();
    expect(resolveInRepo(join(root, "dangling-in"), "x")).toBeNull();
    expect(resolveInRepo(join(root, "file.md/x"), "x")).toBeNull();
  });

  test("each call reads the filesystem again: a directory swapped for an escaping link is refused", () => {
    const swap = join(root, "swap");
    mkdirSync(swap);
    expect(answer(resolveInRepo(root, "swap/new.md"))).toBe("brain/swap/new.md");
    renameSync(swap, join(base, "swapped-away"));
    symlinkSync(outside, swap);
    expect(resolveInRepo(root, "swap/new.md")).toBeNull();
    rmSync(swap);
    renameSync(join(base, "swapped-away"), swap);
    expect(answer(resolveInRepo(root, "swap/new.md"))).toBe("brain/swap/new.md");
  });

  test("the mask's scratch area is .brain/scratch, separator-bounded", () => {
    const rootReal = realpathSync(root);
    expect(maskInScratch(rootReal, ".brain/scratch/m.png", join(rootReal, "notes/m.png"))).toBe(true);
    expect(maskInScratch(rootReal, "notes/m.png", join(rootReal, ".brain/scratch/m.png"))).toBe(true);
    expect(maskInScratch(rootReal, ".brain/scratchy/m.png", join(rootReal, ".brain/scratchy/m.png"))).toBe(false);
    expect(maskInScratch(rootReal, ".brain/m.png", join(rootReal, ".brain/m.png"))).toBe(false);
  });
});

/**
 * Each predicate as `(root, path) -> answer`, whatever its own argument order.
 * Columns: equality, child, sibling prefix, parent, root `/` (absolute,
 * itself, relative), trailing separator on the root, a trailing separator or
 * unnormalised segment on the path.
 */
const PREDICATE_CASES: [string, string][] = [
  ["/a/b", "/a/b"], ["/a/b", "/a/b/c"], ["/a/b", "/a/bc"], ["/a/b", "/a"],
  ["/", "/x"], ["/", "/"], ["/", "x"],
  ["/a/b/", "/a/b/c"], ["/a/b/", "/a/b"],
  ["/a/b", "/a/b/"], ["/a/b", "/a/b/../c"], ["/a/b", "/a/b/..c"], ["/a/b", "/a/b//c"],
];
//                                  =  c  sp pa /x /  rel tr trE p/ .. ..c //
const LITERAL_SLASH = "T T - - - T - - - T T T T";
const TRAILING_TOLERATED = "T T - - T T - T - T T T T";

const rows: [string, (root: string, path: string) => boolean, string][] = [
  ["worker-launcher within(dir, path)", launcherWithin, LITERAL_SLASH],
  ["worker-rtk within(root, path)", rtkWithin, LITERAL_SLASH],
  ["worker-file-observer within(path, root)", (root, path) => observerWithin(path, root), LITERAL_SLASH],
  ["maintenance-env-masks within(dir, path)", envMasksWithin, LITERAL_SLASH],
  ["worker-turn-temp within(dir, path)", turnTempWithin, TRAILING_TOLERATED],
  ["bridge-tools/mask under(dir, path)", maskUnder, LITERAL_SLASH],
  ["native-reference-pool inside(child, parent)", (root, path) => poolInside(path, root), TRAILING_TOLERATED],
];

describe("ui-sdk containment predicates: their matrix rows", () => {
  for (const [name, predicate, expected] of rows) {
    test(name, () => {
      expect(PREDICATE_CASES.map(([root, path]) => (predicate(root, path) ? "T" : "-")).join(" ")).toBe(expected);
    });
  }

  test("argument order matters: each predicate is asymmetric in the order it declares", () => {
    expect(launcherWithin("/a", "/a/b")).toBe(true);
    expect(launcherWithin("/a/b", "/a")).toBe(false);
    expect(observerWithin("/a/b", "/a")).toBe(true);
    expect(observerWithin("/a", "/a/b")).toBe(false);
    expect(poolInside("/a/b", "/a")).toBe(true);
    expect(poolInside("/a", "/a/b")).toBe(false);
  });
});
