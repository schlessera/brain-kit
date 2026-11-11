/**
 * ui-server's rows of the containment matrices (#2506). `safeResolve(rel,
 * root)` is asynchronous and throws `PathEscapeError`; it refuses absolute
 * paths, `..` anywhere, `:` or `\\` in a segment and dangling links; every
 * existing component must stay inside, not only the final path; a root whose
 * realpath fails refuses everything (#3422); it answers the lexical path, not
 * the canonical one; and under `.brain` a scratch request follows no link.
 * The predicates each keep their own argument order, equality and
 * normalisation answers; a deny-direction predicate takes a root `/` as
 * holding every absolute path (#3422).
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, relative } from "path";

import { inside as coreQueriesInside } from "../src/core-queries";
import { createHostBoundary, within as hostBoundaryWithin } from "../src/brain/host-boundary";
import { within as operationalStateWithin } from "../src/brain/operational-state";
import { syncTransportCommand, within as syncMirrorWithin } from "../src/brain/sync-mirror";
import { isScratchPath, safeResolve } from "../src/files/walker";
import { inside as processInside } from "../src/storage/process";

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

/** The answer relative to the fixture base, `refused` for a path escape, or the error's code. */
async function answer(rel: string, at = root): Promise<string> {
  try {
    return relative(base, await safeResolve(rel, at)) || ".";
  } catch (error) {
    if ((error as Error).name === "PathEscapeError") return "refused";
    return `error ${(error as NodeJS.ErrnoException).code}`;
  }
}

describe("ui-server safeResolve(rel, root): its resolver row", () => {
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
    // `..` is refused anywhere, even when the result stays inside.
    ["notes/../notes/a.md", "refused"],
    ["notes/../../x", "refused"],
    ["../brain-other/secret.md", "refused"],
    // Absolute is refused, even inside the root.
    [join(root, "notes/a.md"), "refused"],
    ["/etc/passwd", "refused"],
    ["\\etc", "refused"],
    // Windows syntax and NUL are refused.
    ["a:b", "refused"],
    ["a\\b", "refused"],
    ["a\0b", "refused"],
    // The answer is the lexical path; links stay as written.
    ["link-in/a.md", "brain/link-in/a.md"],
    ["link-in/new.md", "brain/link-in/new.md"],
    ["link-out/secret.md", "refused"],
    ["link-out/new.md", "refused"],
    // A dangling link is refused even when its target would be inside.
    ["dangling-in", "refused"],
    ["dangling-in/x", "refused"],
    ["dangling-out", "refused"],
    // A symlink cycle is refused (#2506). The copy ui-server carried accepted
    // it, answering a path that resolves nowhere; core and the SDK refused it,
    // and the shared resolver keeps that stricter answer.
    ["cycle-a", "refused"],
    ["cycle-a/x", "refused"],
    // Every existing component must stay inside: out and back is refused.
    ["bounce/back/a.md", "refused"],
    // `.brain` is a scratch request (`isScratchPath`): no link under it is followed.
    [".brain", "brain/.brain"],
    [".brain/scratch/s.txt", "brain/.brain/scratch/s.txt"],
    [".brain/scratch/link", "refused"],
    [".brain/scratch/link/a.md", "refused"],
  ];
  for (const [rel, expected] of rows) {
    test(`${JSON.stringify(rel.startsWith(base) ? "<abs>/" + relative(base, rel) : rel)} -> ${expected}`, async () => {
      expect(await answer(rel)).toBe(expected);
    });
  }

  test("a root that is itself a symlink resolves against its target", async () => {
    expect(await answer("notes/a.md", join(base, "root-link"))).toBe("brain/notes/a.md");
  });

  test("a root whose realpath fails refuses everything (#3422)", async () => {
    expect(await answer("notes/a.md", join(base, "nope"))).toBe("refused");
    expect(await answer("", join(base, "nope"))).toBe("refused");
    expect(await answer("x", join(root, "dangling-in"))).toBe("refused");
    expect(await answer("x", join(root, "file.md/x"))).toBe("refused");
  });

  test("each call reads the filesystem again: a directory swapped for an escaping link is refused", async () => {
    const swap = join(root, "swap");
    mkdirSync(swap);
    expect(await answer("swap/new.md")).toBe("brain/swap/new.md");
    renameSync(swap, join(base, "swapped-away"));
    symlinkSync(outside, swap);
    expect(await answer("swap/new.md")).toBe("refused");
    rmSync(swap);
    renameSync(join(base, "swapped-away"), swap);
    expect(await answer("swap/new.md")).toBe("brain/swap/new.md");
  });

  test("isScratchPath covers .brain itself as well as the scratch area", () => {
    expect(isScratchPath(".brain")).toBe(true);
    expect(isScratchPath(".brain/")).toBe(true);
    expect(isScratchPath("./.brain/scratch")).toBe(true);
    expect(isScratchPath(".brain/scratch/x/y")).toBe(true);
    expect(isScratchPath(".brain/other")).toBe(false);
    expect(isScratchPath(".brain/scratchy")).toBe(false);
    expect(isScratchPath(".brainy/scratch")).toBe(false);
    expect(isScratchPath("notes/.brain/scratch")).toBe(false);
  });
});

/** As in the ui-sdk test: `(root, path)` cases and their `T`/`-` answers. */
const PREDICATE_CASES: [string, string][] = [
  ["/a/b", "/a/b"], ["/a/b", "/a/b/c"], ["/a/b", "/a/bc"], ["/a/b", "/a"],
  ["/", "/x"], ["/", "/"], ["/", "x"],
  ["/a/b/", "/a/b/c"], ["/a/b/", "/a/b"],
  ["/a/b", "/a/b/"], ["/a/b", "/a/b/../c"], ["/a/b", "/a/b/..c"], ["/a/b", "/a/b//c"],
];
//                                  =  c  sp pa /x /  rel tr trE p/ .. ..c //
// Deny direction (#3422): root `/` holds every absolute path, as does a root
// written with its trailing separator.
const DENY_BOUNDARY = "T T - - T T - T - T T T T";

const rows: [string, (root: string, path: string) => boolean, string][] = [
  // relative()-based: both sides resolved; the root itself is excluded. A
  // child named `..c` is inside (#2506): the copy refused it, reading any
  // relative path that starts with `..` as an escape.
  ["core-queries inside(dir, file)", coreQueriesInside, "- T - - T - T T - - - T T"],
  // relative()-based: both sides resolved; the root itself is included.
  ["storage/process inside(root, path)", processInside, "T T - - T T T T T T - T T"],
  ["operational-state within(root, path)", operationalStateWithin, DENY_BOUNDARY],
  ["sync-mirror within(root, path)", syncMirrorWithin, DENY_BOUNDARY],
  ["host-boundary within(dir, path)", hostBoundaryWithin, DENY_BOUNDARY],
];

describe("ui-server containment predicates: their matrix rows", () => {
  for (const [name, predicate, expected] of rows) {
    test(name, () => {
      expect(PREDICATE_CASES.map(([root, path]) => (predicate(root, path) ? "T" : "-")).join(" ")).toBe(expected);
    });
  }
});

/**
 * Each deny site that refuses "the brain or its ancestors" refuses `/`
 * (#3422). Under the old literal rule `/` held nothing below it, so a local
 * sync remote of `/` was mounted writable and host credential state at `/`
 * was accepted beside the brain.
 */
describe("ui-server deny sites refuse `/` (#3422)", () => {
  test("a local sync remote at `/` (sync-mirror syncTransportCommand)", () => {
    // git is a hosted-proof prerequisite; its absence fails loudly instead of skipping.
    if (!Bun.which("git", { PATH: "/usr/bin:/bin" })) throw new Error("Prerequisite missing: git in /usr/bin or /bin");
    for (const remote of ["/", "file:///"]) {
      expect(() => syncTransportCommand({ brain: root, mirror: join(base, "mirror"), remote, env: {}, args: [] }))
        .toThrow("the sync transport must not mount the brain or its ancestors");
    }
  });

  test("host credential state at `/` (host-boundary createHostBoundary)", () => {
    expect(() => createHostBoundary({ brainPath: root, credentialDomain: { directory: "/" } }))
      .toThrow("Host credential state must be separate from repository input.");
  });
});
