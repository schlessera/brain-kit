/**
 * The inline containment checks #3423 moved onto `isWithin`, each against the
 * rule that replaced it. A replacement keeps its caller's answer, so each
 * legacy expression and its rule must agree on every input below: traversal,
 * sibling prefixes (`/a/b` vs `/a/bc`), the root `/`, a root ending in a
 * separator, case, backslashes, doubled separators and relative paths.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";

import { isWithin } from "../src/safe-path";

const PATHS = [
  "", "/", "//", "/a", "/a/", "/a/b", "/a/b/", "/a/bc", "/a/b/c", "/a/b/../c", "/a/b/./c", "/a//b", "/A/b",
  "/a/b\\c", "a", "a/", "a/b", "ab", "A", "..", "../a", "./a", ".git", ".git/x", ".gitx", "a\\b", "é/x",
];

/** Each replaced shape: the expression as it was written, and its replacement. */
const SHAPES: Array<{ name: string; legacy: (root: string, path: string) => boolean; now: (root: string, path: string) => boolean }> = [
  {
    name: "path === root || path.startsWith(`${root}/`)",
    legacy: (root, path) => path === root || path.startsWith(`${root}/`),
    now: (root, path) => isWithin(root, path),
  },
  {
    name: "path.startsWith(`${root}/`)",
    legacy: (root, path) => path.startsWith(`${root}/`),
    now: (root, path) => isWithin(root, path, { includeRoot: false }),
  },
  {
    name: "path === root || path.startsWith(root + sep)",
    legacy: (root, path) => path === root || path.startsWith(root + sep),
    now: (root, path) => isWithin(root, path, { separator: sep }),
  },
  {
    name: "path !== root && !path.startsWith(`${root}/`) && !root.startsWith(`${path}/`)",
    legacy: (root, path) => path !== root && !path.startsWith(`${root}/`) && !root.startsWith(`${path}/`),
    now: (root, path) => !isWithin(root, path) && !isWithin(path, root),
  },
  {
    name: "storage-inventory `inside`: path.relative",
    legacy: (root, path) => {
      const rel = relative(root, path);
      return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
    },
    now: (root, path) => isWithin(root, path, { resolvePaths: true, separator: sep, trailingSeparator: "boundary" }),
  },
  {
    name: "protected-target `within`: `/` holds every absolute path",
    legacy: (root, path) => path === root || path.startsWith(root === sep ? root : `${root}${sep}`),
    now: (root, path) => isWithin(root, path, { separator: sep, trailingSeparator: root === sep ? "boundary" : "append" }),
  },
];

describe("each replaced inline shape keeps its answer", () => {
  for (const shape of SHAPES) {
    test(shape.name, () => {
      const disagreements: string[] = [];
      for (const root of PATHS) {
        for (const path of PATHS) {
          if (shape.legacy(root, path) !== shape.now(root, path)) disagreements.push(`${JSON.stringify(root)} ${JSON.stringify(path)}`);
        }
      }
      expect(disagreements).toEqual([]);
    });
  }

  test("the sibling prefix, traversal and case answers they share", () => {
    expect(isWithin("/a/b", "/a/bc")).toBe(false);
    expect(isWithin("/a/b", "/a/b/../c")).toBe(true); // lexical, as the inline check was
    expect(isWithin("/a/b", "/a/b/../c", { resolvePaths: true })).toBe(false);
    expect(isWithin("/a/b", "/A/b/c")).toBe(false);
    expect(isWithin("/a/b", "/a/b\\c")).toBe(false);
    expect(isWithin("/", "/x")).toBe(false); // the deny-direction answer #3422 owns
    expect(isWithin("/", "/x", { trailingSeparator: "boundary" })).toBe(true);
  });
});

describe("symlinks", () => {
  const base = mkdtempSync(join(tmpdir(), "inline-containment-"));
  afterAll(() => rmSync(base, { recursive: true, force: true }));

  test("the string shapes do not follow links, so callers compare canonical paths", () => {
    mkdirSync(join(base, "root"));
    mkdirSync(join(base, "outside"));
    symlinkSync(join(base, "outside"), join(base, "root", "escape"));
    const through = join(base, "root", "escape", "file");
    for (const shape of SHAPES.filter(s => !s.name.startsWith("path !=="))) {
      expect({ shape: shape.name, legacy: shape.legacy(join(base, "root"), through), now: shape.now(join(base, "root"), through) })
        .toEqual({ shape: shape.name, legacy: true, now: true });
    }
  });
});
