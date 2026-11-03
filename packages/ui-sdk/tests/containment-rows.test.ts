/**
 * The ui-sdk's rows of the containment matrices (#2506). `resolveInRepo(root,
 * rel)` gives the strictest answer in every row since #3422, as core's
 * `safeResolve` does: it refuses an absolute request, any `..` segment, `:` or
 * `\\` in a segment, a dangling link and a path that leaves through one link
 * and comes back through another. The predicates each keep their own argument
 * order, equality and trailing-separator answers; a deny-direction predicate
 * takes a root `/` as holding every absolute path (#3422).
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
import { holds as launcherHolds, prepareWorkerSandbox, within as launcherWithin, workerCommand, type WorkerLaunch } from "../src/server/worker-launcher";
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
    // `..` is refused even when the result stays inside (#3422).
    ["notes/../notes/a.md", "refused"],
    ["notes/sub/..", "refused"],
    ["notes/../../x", "refused"],
    // Sibling prefix: `brain-other` starts with `brain`.
    ["../brain-other/secret.md", "refused"],
    // Absolute: refused even inside the root.
    [join(root, "notes/a.md"), "refused"],
    [root, "refused"],
    ["/etc/passwd", "refused"],
    // Windows syntax is refused in any segment (#3422).
    ["a:b", "refused"],
    ["notes/a:b.md", "refused"],
    ["a\\b", "refused"],
    ["\\notes", "refused"],
    ["a\0b", "refused"],
    ["link-in/a.md", "brain/notes/a.md"],
    ["link-in/new.md", "brain/notes/new.md"],
    ["link-out/secret.md", "refused"],
    ["link-out/new.md", "refused"],
    // A dangling link is refused wherever it points (#3422).
    ["dangling-in", "refused"],
    ["dangling-in/x", "refused"],
    ["dangling-out", "refused"],
    ["cycle-a", "refused"],
    ["cycle-a/x", "refused"],
    // Every existing component must stay inside: out and back is refused (#3422).
    ["bounce/back/a.md", "refused"],
    ["bounce/back", "refused"],
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
  // Deny direction (#3422): root `/` holds every absolute path.
  ["worker-launcher holds(dir, path)", launcherHolds, TRAILING_TOLERATED],
  ["worker-rtk within(root, path)", rtkWithin, TRAILING_TOLERATED],
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

/**
 * Each deny site that refuses "the brain or its ancestors" refuses a `/`
 * source (#3422). `/` is root-owned and 0755 on a Linux host, so it passes
 * the ownership and mode checks before each containment refusal; under the
 * old literal rule `/` held nothing below it and every one of these was
 * accepted, binding the whole host, brain included, into the worker.
 */
describe("worker-launcher deny sites refuse a `/` source (#3422)", () => {
  const linux = process.platform === "linux" && Boolean(Bun.which("bwrap"));
  const brain = realpathSync(root);
  const launch = (extra: Partial<WorkerLaunch>) => () => workerCommand({ brainPath: brain, command: [process.execPath], env: {}, ...extra });

  // A `/` read path is refused first by the runtime placement check, the
  // deny site that keeps runtime paths off the reserved private mounts: `/`
  // holds `/proc`. That check shadows the transport bind check
  // (`transportMounts`) and the restricted envelope's own list for `/`.
  const placement = "owned runtime path / (/) collides with reserved private worker path /proc";
  test.skipIf(!linux)("a transport read path of `/` (worker-launcher validateRuntimePlacement)", () => {
    const mirror = join(base, "transport-mirror");
    mkdirSync(mirror, { recursive: true });
    expect(launch({ transport: { mirror, readPaths: ["/"] } })).toThrow(placement);
  });

  test.skipIf(!linux)("a restricted read path of `/` (worker-launcher validateRuntimePlacement)", () => {
    expect(launch({ restricted: { readPaths: ["/"], inferenceDir: base } })).toThrow(placement);
  });

  test.skipIf(!linux)("a managed worktree generation at `/` (worker-launcher sandboxMounts)", () => {
    const sandbox = prepareWorkerSandbox(brain, { profile: "governed", areas: [] });
    expect(launch({ sandbox: { ...sandbox, worktrees: { source: "/" } } }))
      .toThrow("a managed worktree generation must be its pool's root-owned directory outside the brain");
  });

  test.skipIf(!linux)("a reference source view at `/` (worker-launcher sandboxMounts)", () => {
    const sandbox = prepareWorkerSandbox(brain, { profile: "governed", areas: [] });
    expect(launch({ sandbox: { ...sandbox, references: { public: "/" } } }))
      .toThrow("a reference source view must be its pool's root-owned directory outside the brain");
  });

  test.skipIf(!linux)("a maintenance worker's writable directory at `/` (worker-launcher maintenanceMounts)", () => {
    expect(launch({ maintenance: { network: false, credentials: false, readPaths: [process.execPath], writeDirectories: ["/"] } }))
      .toThrow("a maintenance worker's writable storage must be an unlinked directory outside the brain");
  });

  test.skipIf(!linux)("a scratch path of `/` (worker-launcher workerCommand)", () => {
    expect(launch({ scratchPath: "/" })).toThrow("scratch must be a separate location outside the authoritative brain and its ancestors");
  });
});
