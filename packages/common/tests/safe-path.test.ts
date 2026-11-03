import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";

import {
  isWithin,
  resolveContained,
  resolveContainedSync,
  type ContainedPath,
  type ContainmentPolicy,
  type WithinRule,
} from "../src/safe-path";

describe("isWithin(root, path, rule)", () => {
  // Columns: equality, child, sibling prefix, parent, root `/` (absolute,
  // itself, relative), trailing separator on the root, unnormalised paths.
  const CASES: [string, string][] = [
    ["/a/b", "/a/b"], ["/a/b", "/a/b/c"], ["/a/b", "/a/bc"], ["/a/b", "/a"],
    ["/", "/x"], ["/", "/"], ["/", "x"],
    ["/a/b/", "/a/b/c"], ["/a/b/", "/a/b"],
    ["/a/b", "/a/b/"], ["/a/b", "/a/b/../c"], ["/a/b", "/a/b/..c"], ["/a/b", "/a/b//c"],
  ];
  const row = (rule?: WithinRule) => CASES.map(([root, path]) => (isWithin(root, path, rule) ? "T" : "-")).join(" ");

  // Every combination a caller uses (#2506), each written out.
  test("the default: root included, `/` appended to any root, strings as given", () => {
    expect(row()).toBe("T T - - - T - - - T T T T");
    expect(row({ includeRoot: true, separator: "/", trailingSeparator: "append", resolvePaths: false })).toBe(row());
  });

  test("a trailing separator on the root is its boundary, so `/` holds every absolute path", () => {
    expect(row({ trailingSeparator: "boundary" })).toBe("T T - - T T - T - T T T T");
  });

  test("resolved first, root included (relative()-based callers)", () => {
    expect(row({ resolvePaths: true, separator: sep, trailingSeparator: "boundary" })).toBe("T T - - T T T T T T - T T");
  });

  test("resolved first, root excluded", () => {
    expect(row({ includeRoot: false, resolvePaths: true, separator: sep, trailingSeparator: "boundary" }))
      .toBe("- T - - T - T T - - - T T");
  });

  test("the separator is a parameter", () => {
    expect(isWithin("C:\\a", "C:\\a\\b", { separator: "\\" })).toBe(true);
    expect(isWithin("C:\\a", "C:\\ab", { separator: "\\" })).toBe(false);
    expect(isWithin("C:\\a", "C:\\a/b", { separator: "\\" })).toBe(false);
    expect(isWithin("/a", "/a\\b", { separator: "\\" })).toBe(true);
  });

  test("the sibling prefix is never within, under any rule", () => {
    for (const rule of [{}, { trailingSeparator: "boundary" }, { resolvePaths: true }, { includeRoot: false }] as WithinRule[]) {
      expect(isWithin("/srv/brain", "/srv/brain-other/x", rule)).toBe(false);
      expect(isWithin("/srv/brain", "/srv/brainx", rule)).toBe(false);
    }
  });

  test("the argument order is root first", () => {
    expect(isWithin("/a", "/a/b")).toBe(true);
    expect(isWithin("/a/b", "/a")).toBe(false);
  });
});

const base = realpathSync(mkdtempSync(join(tmpdir(), "brain-common-safe-path-")));
afterAll(() => rmSync(base, { recursive: true, force: true }));
const root = join(base, "brain");
const outside = join(base, "brain-other");
mkdirSync(join(root, "notes"), { recursive: true });
mkdirSync(join(root, ".brain/scratch"), { recursive: true });
mkdirSync(outside);
writeFileSync(join(root, "notes/a.md"), "a");
writeFileSync(join(outside, "secret.md"), "s");
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

const FINAL_FOLLOW: ContainmentPolicy = { missingRoot: "refuse", danglingLinks: "follow", components: "final" };
const EVERY_REFUSE: ContainmentPolicy = { missingRoot: "lexical", danglingLinks: "refuse", components: "every" };

/** `canonical` (and `lexical` when it differs) relative to the fixture base, or the refusal. */
function show(result: ContainedPath): string {
  if (!result.ok) return result.reason === "error" ? `error ${result.error.code}` : `refused ${result.reason}`;
  const canonical = relative(base, result.canonical);
  const lexical = relative(base, result.lexical);
  return canonical === lexical ? canonical : `${canonical} (as ${lexical})`;
}

/** Both variants, which must agree. */
async function both(at: string, rel: string, policy: ContainmentPolicy): Promise<string> {
  const sync = show(resolveContainedSync(at, rel, policy));
  expect(show(await resolveContained(at, rel, policy))).toBe(sync);
  return sync;
}

describe("resolveContained: one algorithm, sync and async", () => {
  const rows: [string, string, string][] = [
    // rel, final + follow, every + refuse
    ["notes/a.md", "brain/notes/a.md", "brain/notes/a.md"],
    ["notes/new.md", "brain/notes/new.md", "brain/notes/new.md"],
    ["a/b/c.md", "brain/a/b/c.md", "brain/a/b/c.md"],
    ["", "brain", "brain"],
    ["../brain-other/secret.md", "refused escape", "refused escape"],
    ["notes/../../brain-other", "refused escape", "refused escape"],
    ["a\0b", "refused nul", "refused nul"],
    ["link-in/a.md", "brain/notes/a.md (as brain/link-in/a.md)", "brain/notes/a.md (as brain/link-in/a.md)"],
    // A symlinked parent of a file that does not exist yet.
    ["link-out/new.md", "refused escape", "refused escape"],
    ["link-in/new.md", "brain/notes/new.md (as brain/link-in/new.md)", "brain/notes/new.md (as brain/link-in/new.md)"],
    ["dangling-in", "brain/notes/missing (as brain/dangling-in)", "refused dangling"],
    ["dangling-in/x", "brain/notes/missing/x (as brain/dangling-in/x)", "refused dangling"],
    ["dangling-out", "refused escape", "refused dangling"],
    // A dangling cycle: followed, it runs out of the link budget.
    ["cycle-a", "refused link-budget", "refused dangling"],
    ["cycle-a/x", "refused link-budget", "refused dangling"],
    // Out through one link and back through another.
    ["bounce/back/a.md", "brain/notes/a.md (as brain/bounce/back/a.md)", "refused escape"],
  ];
  for (const [rel, finalFollow, everyRefuse] of rows) {
    test(JSON.stringify(rel), async () => {
      expect(await both(root, rel, FINAL_FOLLOW)).toBe(finalFollow);
      expect(await both(root, rel, EVERY_REFUSE)).toBe(everyRefuse);
    });
  }

  test("an absolute request is resolved like any other: inside is accepted", async () => {
    expect(await both(root, join(root, "notes/a.md"), FINAL_FOLLOW)).toBe("brain/notes/a.md");
    expect(await both(root, "/etc/passwd", FINAL_FOLLOW)).toBe("refused escape");
  });

  test("a root that is itself a symlink resolves against its target", async () => {
    expect(await both(join(base, "root-link"), "notes/a.md", FINAL_FOLLOW)).toBe("brain/notes/a.md");
    expect(await both(join(base, "root-link"), "link-out/x", EVERY_REFUSE)).toBe("refused escape");
  });

  test("a missing root: refused, or the lexical path; never through a dangling link or a file", async () => {
    expect(await both(join(base, "nope"), "notes/a.md", FINAL_FOLLOW)).toBe("refused missing-root");
    expect(await both(join(base, "nope"), "notes/a.md", EVERY_REFUSE)).toBe("nope/notes/a.md");
    expect(await both(join(base, "nope"), "../brain/notes", EVERY_REFUSE)).toBe("refused escape");
    expect(await both(join(root, "dangling-in"), "x", EVERY_REFUSE)).toBe("refused dangling");
    writeFileSync(join(base, "file"), "");
    expect(await both(join(base, "file/x"), "y", EVERY_REFUSE)).toBe("error ENOTDIR");
  });

  test("refuseLinkAt refuses a link at a chosen component before following it", async () => {
    const policy: ContainmentPolicy = { ...EVERY_REFUSE, refuseLinkAt: (path, absRoot) => isWithin(join(absRoot, ".brain"), path) };
    expect(await both(root, ".brain/scratch/link/a.md", policy)).toBe("refused refused-link");
    expect(await both(root, ".brain/scratch/link/a.md", EVERY_REFUSE)).toBe("brain/notes/a.md (as brain/.brain/scratch/link/a.md)");
    expect(await both(root, "link-in/a.md", policy)).toBe("brain/notes/a.md (as brain/link-in/a.md)");
    // Only the component walk consults it.
    expect(await both(root, ".brain/scratch/link/a.md", { ...FINAL_FOLLOW, refuseLinkAt: () => true })).toBe("brain/notes/a.md (as brain/.brain/scratch/link/a.md)");
  });

  test("each call reads the filesystem again: a directory swapped for an escaping link is refused", async () => {
    const swap = join(root, "swap");
    mkdirSync(swap);
    expect(await both(root, "swap/new.md", FINAL_FOLLOW)).toBe("brain/swap/new.md");
    renameSync(swap, join(base, "swapped-away"));
    symlinkSync(outside, swap);
    expect(await both(root, "swap/new.md", FINAL_FOLLOW)).toBe("refused escape");
    expect(await both(root, "swap/new.md", EVERY_REFUSE)).toBe("refused escape");
  });
});
