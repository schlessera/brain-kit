/**
 * The scratch area (#310): one prune policy, one exclusion, one command.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "fs";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { basename, dirname, join } from "path";

import { buildTaxonomy } from "../src/lib/taxonomy.js";
import { resolveWritable, WriteRefusedError } from "../src/lib/safe-path.js";
import { exportOkfBundle, OkfExportError } from "../src/lib/okf-exporter.js";
import {
  SCRATCH_DIR,
  SCRATCH_MAX_BYTES,
  SCRATCH_TTL_MS,
  assertScratchWritable,
  cleanScratch,
  ensureScratch,
  ignoreScratch,
  isInScratch,
  pruneScratch,
  ScratchNotIgnoredError,
  ScratchRedirectedError,
  scratchDir,
  scratchIgnored,
  scratchName,
  writeScratchFile,
} from "../src/lib/scratch.js";
import { cleanup, makeTempBrain, runCli } from "./cli-harness";

let root: string;
const NOW = Date.parse("2026-09-24T12:00:00Z");

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "brain-scratch-"));
});
afterEach(() => cleanup(root));

/** A scratch file of `bytes`, last modified `ageMs` before NOW. */
function file(name: string, bytes: number, ageMs: number) {
  const abs = join(root, SCRATCH_DIR, name);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, Buffer.alloc(bytes));
  const t = (NOW - ageMs) / 1000;
  utimesSync(abs, t, t);
  return abs;
}

/** A directory outside the brain holding one old file: what a symlink would point at. */
function outsideDir(): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), "brain-outside-"));
  const f = join(dir, "victim.pdf");
  writeFileSync(f, "keep me");
  const t = (NOW - SCRATCH_TTL_MS - 60_000) / 1000;
  utimesSync(f, t, t);
  return { dir, file: f };
}

describe("the policy", () => {
  test("is seven days and one gigabyte", () => {
    expect(SCRATCH_TTL_MS).toBe(7 * 24 * 60 * 60 * 1000);
    expect(SCRATCH_MAX_BYTES).toBe(1024 * 1024 * 1024);
    expect(SCRATCH_DIR).toBe(".brain/scratch");
  });
});

describe("pruneScratch", () => {
  test("removes a file just past seven days and keeps one just inside", () => {
    const old = file("old.pdf", 10, SCRATCH_TTL_MS + 1000);
    const fresh = file("fresh.pdf", 10, SCRATCH_TTL_MS - 1000);
    const report = pruneScratch(root, NOW);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(report.removed).toEqual([{ path: `${SCRATCH_DIR}/old.pdf`, bytes: 10, reason: "age" }]);
    expect(report).toMatchObject({ files: 1, bytes: 10 });
  });

  test("then removes the oldest until the rest fit, and keeps exactly the cap", () => {
    const a = file("a.png", 40, 3000);
    const b = file("nested/b.png", 40, 2000);
    const c = file("c.png", 40, 1000);
    // 120 bytes against a cap of 80: the oldest goes, and 80 is kept as is.
    const report = pruneScratch(root, NOW, { maxBytes: 80 });
    expect(existsSync(a)).toBe(false);
    expect(existsSync(b)).toBe(true);
    expect(existsSync(c)).toBe(true);
    expect(report.removed.map((r) => [r.path, r.reason])).toEqual([[`${SCRATCH_DIR}/a.png`, "size"]]);
    expect(report.bytes).toBe(80);
  });

  test("removes directories it empties, never the scratch root, and is fine when nothing exists", () => {
    file("nested/deep/x.bin", 5, SCRATCH_TTL_MS + 1);
    pruneScratch(root, NOW);
    expect(existsSync(join(root, SCRATCH_DIR, "nested"))).toBe(false);
    expect(existsSync(join(root, SCRATCH_DIR))).toBe(true);
    const empty = mkdtempSync(join(tmpdir(), "brain-noscratch-"));
    expect(pruneScratch(empty, NOW)).toEqual({ removed: [], failed: [], bytes: 0, files: 0 });
    cleanup(empty);
  });
});

describe("cleanScratch", () => {
  test("removes everything and reports it", () => {
    file("a.png", 3, 0);
    file("b/c.pdf", 4, 0);
    const report = cleanScratch(root);
    expect(report.removed.map((r) => r.path).sort()).toEqual([`${SCRATCH_DIR}/a.png`, `${SCRATCH_DIR}/b/c.pdf`]);
    expect(report).toMatchObject({ files: 0, bytes: 0 });
  });
});

describe("a symlinked scratch", () => {
  const outsides: string[] = [];
  afterEach(() => {
    for (const dir of outsides.splice(0)) cleanup(dir);
  });

  test("is refused by prune, clean and the write guard, and the link's target is untouched", () => {
    const outside = outsideDir();
    outsides.push(outside.dir);
    mkdirSync(join(root, ".brain"), { recursive: true });
    symlinkSync(outside.dir, join(root, SCRATCH_DIR));
    expect(() => pruneScratch(root, NOW)).toThrow(ScratchRedirectedError);
    expect(() => cleanScratch(root)).toThrow(ScratchRedirectedError);
    expect(() => ensureScratch(root)).toThrow(ScratchRedirectedError);
    expect(() => assertScratchWritable(root, join(realpathSync(root), SCRATCH_DIR, "x.pdf"))).toThrow(
      ScratchRedirectedError,
    );
    expect(() => scratchDir(root)).toThrow(/symlink/);
    expect(readFileSync(outside.file, "utf8")).toBe("keep me");
  });

  test("a symlinked .brain is refused the same way", () => {
    const outside = outsideDir();
    outsides.push(outside.dir);
    mkdirSync(join(outside.dir, "scratch"));
    writeFileSync(join(outside.dir, "scratch", "old.pdf"), "x");
    const t = (NOW - SCRATCH_TTL_MS - 60_000) / 1000;
    utimesSync(join(outside.dir, "scratch", "old.pdf"), t, t);
    symlinkSync(outside.dir, join(root, ".brain"));
    expect(() => pruneScratch(root, NOW)).toThrow(ScratchRedirectedError);
    expect(() => cleanScratch(root)).toThrow(ScratchRedirectedError);
    expect(() => ensureScratch(root)).toThrow(ScratchRedirectedError);
    expect(existsSync(join(outside.dir, "scratch", "old.pdf"))).toBe(true);
  });

  test("a link inside scratch is removed as a link, never followed", () => {
    const outside = outsideDir();
    outsides.push(outside.dir);
    mkdirSync(join(root, SCRATCH_DIR), { recursive: true });
    const link = join(root, SCRATCH_DIR, "elsewhere");
    symlinkSync(outside.dir, link);
    file("mine.pdf", 4, 0);
    // A cap of zero removes every entry; the link goes, what it pointed at stays.
    const report = pruneScratch(root, NOW, { maxBytes: 0 });
    expect(report.removed.map((r) => r.path).sort()).toEqual([`${SCRATCH_DIR}/elsewhere`, `${SCRATCH_DIR}/mine.pdf`]);
    expect(fs.lstatSync(link, { throwIfNoEntry: false })).toBeUndefined();
    expect(readFileSync(outside.file, "utf8")).toBe("keep me");
  });

  test("the write guard refuses a target that a link inside scratch resolves out of it", () => {
    mkdirSync(join(root, "notes"), { recursive: true });
    mkdirSync(join(root, SCRATCH_DIR), { recursive: true });
    symlinkSync(join("..", "..", "notes"), join(root, SCRATCH_DIR, "sub"));
    const abs = resolveWritable(root, `${SCRATCH_DIR}/sub/x.html`)!;
    // Contained in the brain, so resolveWritable allows it — but it is the
    // content directory, not scratch.
    expect(abs).toBe(join(realpathSync(root), "notes", "x.html"));
    expect(isInScratch(root, `${SCRATCH_DIR}/sub/x.html`)).toBe(true);
    expect(() => assertScratchWritable(root, abs)).toThrow(ScratchRedirectedError);
  });

  test("isInScratch compares against the canonical root, so a symlinked root still recognizes it", () => {
    const alias = join(mkdtempSync(join(tmpdir(), "brain-alias-")), "brain");
    outsides.push(join(alias, ".."));
    symlinkSync(root, alias);
    expect(isInScratch(alias, join(realpathSync(root), SCRATCH_DIR, "x.pdf"))).toBe(true);
    expect(isInScratch(alias, `${SCRATCH_DIR}/x.pdf`)).toBe(true);
    expect(isInScratch(alias, "notes/x.pdf")).toBe(false);
    expect(isInScratch(alias, join(realpathSync(root), "notes", "x.pdf"))).toBe(false);
  });
});

describe("a prune beside another process", () => {
  const outsides: string[] = [];
  afterEach(() => {
    // Every spy below restores itself; this is the belt for a failed assertion.
    for (const name of ["unlinkSync", "lstatSync", "rmdirSync", "readdirSync"] as const) {
      const maybe = fs[name] as unknown as { mockRestore?: () => void };
      maybe.mockRestore?.();
    }
    for (const dir of outsides.splice(0)) cleanup(dir);
  });

  /**
   * The listing has just read `nested`; before anything is removed, `nested`
   * becomes a symlink to a directory outside the brain that holds a file of
   * the listed name. The old path now names the outside file.
   */
  function swapNestedAfterListing(): { file: string } {
    file("nested/victim.pdf", 7, SCRATCH_TTL_MS + 1000);
    const outside = outsideDir();
    outsides.push(outside.dir);
    const nested = join(root, SCRATCH_DIR, "nested");
    const real = fs.readdirSync;
    const spy = spyOn(fs, "readdirSync").mockImplementation(((path: fs.PathLike, options?: unknown) => {
      const result = real(path, options as never);
      if (String(path) === nested && !isSymlinkNow(nested)) {
        rmSync(nested, { recursive: true, force: true });
        symlinkSync(outside.dir, nested);
      }
      return result;
    }) as typeof fs.readdirSync);
    spies.push(spy);
    return { file: outside.file };
  }
  const isSymlinkNow = (p: string) => fs.lstatSync(p, { throwIfNoEntry: false })?.isSymbolicLink() === true;
  const spies: { mockRestore(): void }[] = [];
  afterEach(() => {
    for (const spy of spies.splice(0)) spy.mockRestore();
  });

  test("prune: an ancestor swapped for a link between the listing and the unlink is skipped, the outside file survives", () => {
    const outside = swapNestedAfterListing();
    const report = pruneScratch(root, NOW);
    expect(existsSync(outside.file)).toBe(true);
    expect(readFileSync(outside.file, "utf8")).toBe("keep me");
    expect(report.removed).toEqual([]);
  });

  test("clean: the same swap, the same outcome", () => {
    const outside = swapNestedAfterListing();
    const report = cleanScratch(root);
    expect(existsSync(outside.file)).toBe(true);
    expect(report.removed).toEqual([]);
  });

  /**
   * The files are gone and the cleanup has just listed `nested`; before it
   * descends, `nested` becomes a link to an outside directory holding an
   * empty `deep` of the listed name.
   */
  function swapNestedAfterCleanupListing(ageMs: number): { deep: string } {
    file("nested/deep/x.bin", 5, ageMs);
    const outside = mkdtempSync(join(tmpdir(), "brain-outside-"));
    outsides.push(outside);
    const deep = join(outside, "deep");
    mkdirSync(deep);
    const nested = join(root, SCRATCH_DIR, "nested");
    let reads = 0;
    const real = fs.readdirSync;
    const spy = spyOn(fs, "readdirSync").mockImplementation(((path: fs.PathLike, options?: unknown) => {
      const result = real(path, options as never);
      // The first read of `nested` is the listing; the second is the cleanup's.
      if (String(path) === nested && ++reads === 2) {
        rmSync(nested, { recursive: true, force: true });
        symlinkSync(outside, nested);
      }
      return result;
    }) as typeof fs.readdirSync);
    spies.push(spy);
    return { deep };
  }

  test("prune: a directory swapped for a link after the cleanup listed it is not descended into, the outside directory survives", () => {
    const outside = swapNestedAfterCleanupListing(SCRATCH_TTL_MS + 1000);
    pruneScratch(root, NOW);
    expect(existsSync(outside.deep)).toBe(true);
    expect(lstatSync(outside.deep).isDirectory()).toBe(true);
  });

  test("clean: the same swap, the outside directory survives", () => {
    const outside = swapNestedAfterCleanupListing(0);
    cleanScratch(root);
    expect(existsSync(outside.deep)).toBe(true);
  });

  test("a file that would not go stays in the cap's total, and the pass moves on to the next oldest", () => {
    const stuck = file("stuck.pdf", 60, 3000);
    const other = file("other.pdf", 60, 2000);
    const real = fs.unlinkSync;
    const spy = spyOn(fs, "unlinkSync").mockImplementation((path) => {
      if (String(path).endsWith("stuck.pdf")) {
        const e = new Error("EPERM: operation not permitted") as NodeJS.ErrnoException;
        e.code = "EPERM";
        throw e;
      }
      real(path);
    });
    spies.push(spy);
    // 120 bytes against a cap of 80: the oldest will not go, so the next does.
    const report = pruneScratch(root, NOW, { maxBytes: 80 });
    expect(existsSync(stuck)).toBe(true);
    expect(existsSync(other)).toBe(false);
    expect(report.removed.map((r) => r.path)).toEqual([`${SCRATCH_DIR}/other.pdf`]);
    expect(report.failed.map((f) => f.path)).toEqual([`${SCRATCH_DIR}/stuck.pdf`]);
    expect(report).toMatchObject({ bytes: 60, files: 1 });
  });

  test("a removal refused by the OS leaves the file counted and reported, for prune and for clean", () => {
    const stuck = file("stuck.pdf", 5, SCRATCH_TTL_MS + 1000);
    file("fine.pdf", 3, 0);
    const real = fs.unlinkSync;
    const spy = spyOn(fs, "unlinkSync").mockImplementation((path) => {
      if (String(path).endsWith("stuck.pdf")) {
        const e = new Error("EPERM: operation not permitted") as NodeJS.ErrnoException;
        e.code = "EPERM";
        throw e;
      }
      real(path);
    });
    spies.push(spy);
    const pruned = pruneScratch(root, NOW);
    expect(pruned.removed).toEqual([]);
    expect(pruned.failed).toEqual([{ path: `${SCRATCH_DIR}/stuck.pdf`, reason: "EPERM: operation not permitted" }]);
    expect(pruned).toMatchObject({ bytes: 8, files: 2 });
    expect(existsSync(stuck)).toBe(true);
    const cleaned = cleanScratch(root);
    expect(cleaned.removed.map((r) => r.path)).toEqual([`${SCRATCH_DIR}/fine.pdf`]);
    expect(cleaned.failed).toEqual([{ path: `${SCRATCH_DIR}/stuck.pdf`, reason: "EPERM: operation not permitted" }]);
    expect(cleaned).toMatchObject({ bytes: 5, files: 1 });
  });

  test("a file removed between the listing and the unlink is neither an error nor reported", () => {
    const old = file("old.pdf", 10, SCRATCH_TTL_MS + 1000);
    const other = file("other.pdf", 10, SCRATCH_TTL_MS + 1000);
    const real = fs.unlinkSync;
    const spy = spyOn(fs, "unlinkSync").mockImplementation((path) => {
      // The other pruner got there first: the file is gone by the time we unlink.
      real(path);
      if (String(path).endsWith("old.pdf")) real(path);
    });
    try {
      const report = pruneScratch(root, NOW);
      expect(report.removed.map((r) => r.path)).toEqual([`${SCRATCH_DIR}/other.pdf`]);
      expect(existsSync(old)).toBe(false);
      expect(existsSync(other)).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  test("a file removed between readdir and lstat is skipped", () => {
    file("gone.pdf", 10, SCRATCH_TTL_MS + 1000);
    const keep = file("keep.pdf", 10, 0);
    const real = fs.lstatSync;
    const spy = spyOn(fs, "lstatSync").mockImplementation(((path: fs.PathLike, options?: unknown) => {
      if (String(path).endsWith("gone.pdf")) {
        fs.rmSync(path);
        return real(path, options as never);
      }
      return real(path, options as never);
    }) as typeof fs.lstatSync);
    try {
      const report = pruneScratch(root, NOW);
      expect(report.removed).toEqual([]);
      expect(report.files).toBe(1);
      expect(existsSync(keep)).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  test("a directory refilled or removed before its rmdir is left alone", () => {
    file("nested/old.pdf", 5, SCRATCH_TTL_MS + 1000);
    const real = fs.rmdirSync;
    const spy = spyOn(fs, "rmdirSync").mockImplementation(((path: fs.PathLike) => {
      // A writer put a new file into the directory we were about to remove.
      writeFileSync(join(String(path), "new.pdf"), "x");
      return real(path);
    }) as typeof fs.rmdirSync);
    try {
      const report = pruneScratch(root, NOW);
      expect(report.removed.map((r) => r.path)).toEqual([`${SCRATCH_DIR}/nested/old.pdf`]);
      expect(existsSync(join(root, SCRATCH_DIR, "nested", "new.pdf"))).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("gitignore guard", () => {
  const git = (...args: string[]) => Bun.spawnSync(["git", "-C", root, ...args]);
  const fileIgnored = (rel: string) =>
    Bun.spawnSync(["git", "-C", root, "check-ignore", "-q", "--no-index", "--", rel]).exitCode === 0;

  test("the fix never writes through a linked .gitignore", () => {
    const outside = mkdtempSync(join(tmpdir(), "scratch-outside-"));
    try {
      const sentinel = join(outside, "sentinel");
      writeFileSync(sentinel, "keep\n");
      // A symlink is refused before anything is read or written.
      symlinkSync(sentinel, join(root, ".gitignore"));
      expect(() => ignoreScratch(root)).toThrow(WriteRefusedError);
      expect(readFileSync(sentinel, "utf8")).toBe("keep\n");
      // A hard link is replaced by a rename, so its other name keeps its bytes.
      rmSync(join(root, ".gitignore"));
      fs.linkSync(sentinel, join(root, ".gitignore"));
      expect(ignoreScratch(root)).toBe(true);
      expect(readFileSync(sentinel, "utf8")).toBe("keep\n");
      expect(readFileSync(join(root, ".gitignore"), "utf8")).toContain(".brain/scratch/");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("outside a git repository the ignore line is required all the same, and git reads it", () => {
    // A later `git init` would put an unignored scratch into the first commit.
    expect(scratchIgnored(root)).toBe(false);
    expect(() => ensureScratch(root)).toThrow(ScratchNotIgnoredError);
    expect(ignoreScratch(root)).toBe(true);
    expect(scratchIgnored(root)).toBe(true);
    expect(() => ensureScratch(root)).not.toThrow();
    expect(ignoreScratch(root)).toBe(false);
    // The same rules git would apply: a later negation cancels the line.
    writeFileSync(join(root, ".gitignore"), ".brain/scratch/\n!.brain/scratch/\n");
    expect(scratchIgnored(root)).toBe(false);
  });

  test("in a git repository, writes wait for the ignore line, which ignoreScratch adds once", () => {
    git("init", "-q");
    writeFileSync(join(root, ".gitignore"), "node_modules");
    expect(scratchIgnored(root)).toBe(false);
    expect(() => ensureScratch(root)).toThrow(ScratchNotIgnoredError);
    expect(ignoreScratch(root)).toBe(true);
    expect(scratchIgnored(root)).toBe(true);
    expect(ignoreScratch(root)).toBe(false);
    expect(() => ensureScratch(root)).not.toThrow();
  });

  test("only the directory's own exclusion counts: a `/*` rule with a negation is refused, and the fix repairs it", () => {
    git("init", "-q");
    writeFileSync(join(root, ".gitignore"), ".brain/scratch/*\n!.brain/scratch/exposed.pdf\n");
    expect(fileIgnored(`${SCRATCH_DIR}/exposed.pdf`)).toBe(false);
    expect(scratchIgnored(root)).toBe(false);
    const exposed = join(realpathSync(root), SCRATCH_DIR, "exposed.pdf");
    expect(() => assertScratchWritable(root, exposed)).toThrow(ScratchNotIgnoredError);
    expect(() => writeScratchFile(root, exposed, "x")).toThrow(ScratchNotIgnoredError);
    expect(existsSync(exposed)).toBe(false);
    // The prescribed remedy: the appended directory line wins over the negation.
    expect(ignoreScratch(root)).toBe(true);
    expect(scratchIgnored(root)).toBe(true);
    expect(() => writeScratchFile(root, exposed, "x")).not.toThrow();
    expect(fileIgnored(`${SCRATCH_DIR}/exposed.pdf`)).toBe(true);
  });

  test("a directory line cancelled by a later negation is refused, and the fix repairs it", () => {
    git("init", "-q");
    writeFileSync(join(root, ".gitignore"), ".brain/scratch/\n!.brain/scratch/\n");
    expect(scratchIgnored(root)).toBe(false);
    const target = join(realpathSync(root), SCRATCH_DIR, "x.pdf");
    expect(() => writeScratchFile(root, target, "x")).toThrow(ScratchNotIgnoredError);
    expect(ignoreScratch(root)).toBe(true);
    expect(scratchIgnored(root)).toBe(true);
    expect(() => writeScratchFile(root, target, "x")).not.toThrow();
    expect(fileIgnored(`${SCRATCH_DIR}/x.pdf`)).toBe(true);
  });
});

describe("writeScratchFile", () => {
  const outsides: string[] = [];
  afterEach(() => {
    for (const dir of outsides.splice(0)) cleanup(dir);
  });
  const ready = () => {
    ignoreScratch(root);
    return realpathSync(root);
  };

  test("a nested directory swapped for a symlink after the pre-flight is refused, and nothing lands outside", () => {
    const rootReal = ready();
    const outside = mkdtempSync(join(tmpdir(), "brain-outside-"));
    outsides.push(outside);
    const target = join(rootReal, SCRATCH_DIR, "nested", "x.html");
    assertScratchWritable(root, target);
    expect(lstatSync(dirname(target)).isDirectory()).toBe(true);
    // Between the pre-flight and the write, the directory becomes a link.
    rmSync(dirname(target), { recursive: true });
    symlinkSync(outside, dirname(target));
    expect(() => writeScratchFile(root, target, "x")).toThrow(ScratchRedirectedError);
    expect(readdirSync(outside)).toEqual([]);
  });

  test("a directory swapped for a link after the temporary file was written is refused, and the outside files are untouched", () => {
    const rootReal = ready();
    const outside = mkdtempSync(join(tmpdir(), "brain-outside-"));
    outsides.push(outside);
    writeFileSync(join(outside, "x.html"), "keep me");
    const nested = join(rootReal, SCRATCH_DIR, "nested");
    const target = join(nested, "x.html");
    const real = fs.openSync;
    const spy = spyOn(fs, "openSync").mockImplementation(((path: fs.PathLike, flags: unknown, mode?: unknown) => {
      const fd = real(path, flags as never, mode as never);
      if (String(path).startsWith(nested + "/.x.html.")) {
        // The temporary file exists in the real directory; the directory is
        // now a link, and the outside holds a file of the temporary's name.
        writeFileSync(join(outside, basename(String(path))), "outside tmp");
        rmSync(nested, { recursive: true, force: true });
        symlinkSync(outside, nested);
      }
      return fd;
    }) as typeof fs.openSync);
    try {
      expect(() => writeScratchFile(root, target, "new bytes")).toThrow(ScratchRedirectedError);
    } finally {
      spy.mockRestore();
    }
    expect(readFileSync(join(outside, "x.html"), "utf8")).toBe("keep me");
    const outsideTmp = readdirSync(outside).filter((f) => f.startsWith(".x.html."));
    expect(outsideTmp).toHaveLength(1);
    expect(readFileSync(join(outside, outsideTmp[0]), "utf8")).toBe("outside tmp");
  });

  test("a planted symlink at the target is refused, and its target is untouched", () => {
    const rootReal = ready();
    const outside = outsideDir();
    outsides.push(outside.dir);
    const target = join(rootReal, SCRATCH_DIR, "draft.png");
    symlinkSync(outside.file, target);
    expect(() => writeScratchFile(root, target, "new bytes", { replace: true })).toThrow(ScratchRedirectedError);
    expect(readFileSync(outside.file, "utf8")).toBe("keep me");
    expect(fs.readlinkSync(target)).toBe(outside.file);
  });

  test("replacing a hard link of an outside file leaves the outside inode alone", () => {
    const rootReal = ready();
    const outside = outsideDir();
    outsides.push(outside.dir);
    const target = join(rootReal, SCRATCH_DIR, "x.html");
    fs.linkSync(outside.file, target);
    writeScratchFile(root, target, "new bytes", { replace: true });
    expect(readFileSync(target, "utf8")).toBe("new bytes");
    expect(readFileSync(outside.file, "utf8")).toBe("keep me");
    expect(fs.statSync(target).ino).not.toBe(fs.statSync(outside.file).ino);
  });

  test("a generated name refuses an existing file; a chosen name replaces it; no temp file is left behind", () => {
    const rootReal = ready();
    const target = join(rootReal, SCRATCH_DIR, "taken.html");
    writeScratchFile(root, target, "first");
    expect(() => writeScratchFile(root, target, "second")).toThrow(/EEXIST/);
    expect(readFileSync(target, "utf8")).toBe("first");
    writeScratchFile(root, target, "third", { replace: true });
    expect(readFileSync(target, "utf8")).toBe("third");
    expect(readdirSync(join(root, SCRATCH_DIR))).toEqual(["taken.html"]);
  });

  test("a replaced file keeps its exact mode", () => {
    const rootReal = ready();
    const target = join(rootReal, SCRATCH_DIR, "secret.pdf");
    writeScratchFile(root, target, "old");
    fs.chmodSync(target, 0o600);
    writeScratchFile(root, target, "new", { replace: true });
    expect(readFileSync(target, "utf8")).toBe("new");
    expect(fs.statSync(target).mode & 0o7777).toBe(0o600);
  });

  test("a target outside scratch, or resolving out of it through a link, is refused", () => {
    const rootReal = ready();
    mkdirSync(join(root, "notes"), { recursive: true });
    expect(() => writeScratchFile(root, join(rootReal, "notes", "x.html"), "x")).toThrow(ScratchRedirectedError);
    symlinkSync(join("..", "..", "notes"), join(root, SCRATCH_DIR, "sub"));
    expect(() => writeScratchFile(root, join(rootReal, SCRATCH_DIR, "sub", "x.html"), "x")).toThrow(
      ScratchRedirectedError,
    );
    expect(readdirSync(join(root, "notes"))).toEqual([]);
  });
});

describe("generated names", () => {
  test("differ within one millisecond, and carry the stem", () => {
    const now = new Date(NOW);
    const a = scratchName("report", "html", now);
    const b = scratchName("report", "html", now);
    expect(a).not.toBe(b);
    expect(a).toMatch(/^report-20260924T120000000Z-[0-9a-f]{6}\.html$/);
  });

});

describe("the one exclusion", () => {
  test("every isExcludedPath caller skips scratch, through SCRATCH_DIR", () => {
    const taxonomy = buildTaxonomy({});
    expect(taxonomy.isExcludedPath(`${SCRATCH_DIR}/x.md`)).toBe(true);
    expect(taxonomy.isExcludedPath(`${SCRATCH_DIR}/nested/y.pdf`)).toBe(true);
    expect(taxonomy.isExcludedPath("notes/x.md")).toBe(false);
  });
});

describe("the OKF exporter, as a writer into scratch", () => {
  function brain(): string {
    mkdirSync(join(root, "notes"), { recursive: true });
    writeFileSync(
      join(root, "notes", "a.md"),
      "---\ntype: note\ntitle: A\ncreated: 2026-01-02\nupdated: 2026-02-03\ntags: [x]\n---\n\nHello\n",
    );
    Bun.spawnSync(["git", "-C", root, "init", "-q"]);
    writeFileSync(join(root, ".gitignore"), "node_modules\n");
    return root;
  }

  test("is refused while scratch is not gitignored, naming the fix", async () => {
    const taxonomy = buildTaxonomy({});
    await expect(
      exportOkfBundle({ root: brain(), taxonomy, outDir: `${SCRATCH_DIR}/export` }),
    ).rejects.toThrow(OkfExportError);
    await expect(
      exportOkfBundle({ root, taxonomy, outDir: `${SCRATCH_DIR}/export` }),
    ).rejects.toThrow(/brain doctor --fix/);
    expect(existsSync(join(root, SCRATCH_DIR, "export"))).toBe(false);
  });

  test("once ignored, it exports there and prunes what is stale beside it", async () => {
    brain();
    ignoreScratch(root);
    const stale = file("stale.pdf", 3, SCRATCH_TTL_MS + 1000);
    const report = await exportOkfBundle({ root, taxonomy: buildTaxonomy({}), outDir: `${SCRATCH_DIR}/export` });
    expect(report.filesExported).toBe(1);
    expect(existsSync(join(root, SCRATCH_DIR, "export", "notes", "a.md"))).toBe(true);
    expect(existsSync(stale)).toBe(false);
  });
});

describe("the commands", () => {
  let brain: string;
  beforeEach(() => {
    brain = makeTempBrain();
  });
  afterEach(() => cleanup(brain));

  test("brain scratch clean empties it and reports what went", async () => {
    mkdirSync(join(brain, SCRATCH_DIR), { recursive: true });
    writeFileSync(join(brain, SCRATCH_DIR, "x.pdf"), "12345");
    const res = await runCli(brain, ["scratch", "clean", "--json"]);
    expect(res.code).toBe(0);
    const report = JSON.parse(res.stdout);
    expect(report).toMatchObject({ action: "clean", files: 0, bytes: 0 });
    expect(report.removed).toEqual([{ path: `${SCRATCH_DIR}/x.pdf`, bytes: 5, reason: "clean" }]);
    expect(report.failed).toEqual([]);
    expect(existsSync(join(brain, SCRATCH_DIR, "x.pdf"))).toBe(false);
  });

  test("brain scratch prune refuses a symlinked scratch with a clear error", async () => {
    const outside = mkdtempSync(join(tmpdir(), "brain-outside-"));
    mkdirSync(join(brain, ".brain"), { recursive: true });
    symlinkSync(outside, join(brain, SCRATCH_DIR));
    const res = await runCli(brain, ["scratch", "prune"]);
    expect(res.code).not.toBe(0);
    expect(res.stderr + res.stdout).toContain("redirected by a symlink");
    cleanup(outside);
  });

  /** A scratch file the OS will not let go: its directory is read-only. */
  function stuckFile(): { abs: string; dir: string } {
    const dir = join(brain, SCRATCH_DIR, "stuck");
    mkdirSync(dir, { recursive: true });
    const abs = join(dir, "old.pdf");
    writeFileSync(abs, "12345");
    const t = (Date.now() - SCRATCH_TTL_MS - 60_000) / 1000;
    utimesSync(abs, t, t);
    fs.chmodSync(dir, 0o500);
    return { abs, dir };
  }

  // Root writes through the directory mode, so the removal failure cannot be staged there.
  test.skipIf(process.getuid?.() === 0)("brain scratch prune exits 2 when a file could not be removed, prints the report, and names it", async () => {
    const stuck = stuckFile();
    try {
      const res = await runCli(brain, ["scratch", "prune", "--json"]);
      expect(res.code).toBe(2);
      const report = JSON.parse(res.stdout) as { failed: { path: string; reason: string }[]; files: number; bytes: number };
      expect(report.failed).toHaveLength(1);
      expect(report.failed[0].path).toBe(`${SCRATCH_DIR}/stuck/old.pdf`);
      expect(report.failed[0].reason).toMatch(/EACCES|EPERM/);
      expect(report).toMatchObject({ files: 1, bytes: 5 });
      const human = await runCli(brain, ["scratch", "prune", "--human"]);
      expect(human.code).toBe(2);
      expect(human.stdout).toContain(`could not remove ${SCRATCH_DIR}/stuck/old.pdf`);
      expect(existsSync(stuck.abs)).toBe(true);
    } finally {
      fs.chmodSync(stuck.dir, 0o700);
    }
  });

  // Root writes through the directory mode, so the removal failure cannot be staged there.
  test.skipIf(process.getuid?.() === 0)("brain maintain reports the scratch step as failed and exits 2 when a file could not be removed", async () => {
    const stuck = stuckFile();
    try {
      const res = await runCli(brain, ["maintain", "--json"]);
      expect(res.code).toBe(2);
      const steps = JSON.parse(res.stdout) as { step: string; result: string }[];
      const scratch = steps.find((s) => s.step === "scratch")!;
      expect(scratch.result).toMatch(/^FAILED — 1 file\(s\) could not be removed: \.brain\/scratch\/stuck\/old\.pdf \(/);
    } finally {
      fs.chmodSync(stuck.dir, 0o700);
    }
  });

  test("brain maintain prunes scratch as its last step", async () => {
    mkdirSync(join(brain, SCRATCH_DIR), { recursive: true });
    const old = join(brain, SCRATCH_DIR, "old.pdf");
    writeFileSync(old, "x");
    const t = (Date.now() - SCRATCH_TTL_MS - 60_000) / 1000;
    utimesSync(old, t, t);
    const res = await runCli(brain, ["maintain", "--json"]);
    const steps = JSON.parse(res.stdout) as { step: string; result: string }[];
    expect(steps.map((s) => s.step)).toEqual(["registry", "index", "vectors", "audit", "stats", "tags", "git", "scratch"]);
    expect(steps.at(-1)!.result).toContain("removed 1 file(s)");
    expect(existsSync(old)).toBe(false);
  });
});
