/**
 * The scratch area (#310): one prune policy, one exclusion, one command.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "fs";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { buildTaxonomy } from "../src/lib/taxonomy.js";
import { resolveWritable } from "../src/lib/safe-path.js";
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
    expect(pruneScratch(empty, NOW)).toEqual({ removed: [], bytes: 0, files: 0 });
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
  afterEach(() => {
    // Every spy below restores itself; this is the belt for a failed assertion.
    for (const name of ["unlinkSync", "lstatSync", "rmdirSync"] as const) {
      const maybe = fs[name] as unknown as { mockRestore?: () => void };
      maybe.mockRestore?.();
    }
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

  test("outside a git repository the ignore line is required all the same", () => {
    // A later `git init` would put an unignored scratch into the first commit.
    expect(scratchIgnored(root)).toBe(false);
    expect(() => ensureScratch(root)).toThrow(ScratchNotIgnoredError);
    expect(ignoreScratch(root)).toBe(true);
    expect(scratchIgnored(root)).toBe(true);
    expect(() => ensureScratch(root)).not.toThrow();
    expect(ignoreScratch(root)).toBe(false);
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

  test("the guard asks git about the actual target, which a negation can re-include past the probe", () => {
    git("init", "-q");
    writeFileSync(join(root, ".gitignore"), ".brain/scratch/*\n!.brain/scratch/exposed.pdf\n");
    expect(scratchIgnored(root)).toBe(true);
    expect(scratchIgnored(root, `${SCRATCH_DIR}/exposed.pdf`)).toBe(false);
    const exposed = join(realpathSync(root), SCRATCH_DIR, "exposed.pdf");
    expect(() => assertScratchWritable(root, exposed)).toThrow(ScratchNotIgnoredError);
    expect(() => assertScratchWritable(root, exposed)).toThrow(/exposed\.pdf/);
    const fine = join(realpathSync(root), SCRATCH_DIR, "nested", "fine.pdf");
    expect(() => assertScratchWritable(root, fine)).not.toThrow();
    expect(existsSync(join(root, SCRATCH_DIR, "nested"))).toBe(true);
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

  test("a generated file is created exclusively", () => {
    mkdirSync(join(root, SCRATCH_DIR), { recursive: true });
    const abs = join(root, SCRATCH_DIR, "taken.html");
    writeScratchFile(abs, "first");
    expect(() => writeScratchFile(abs, "second")).toThrow(/EEXIST/);
    expect(readFileSync(abs, "utf8")).toBe("first");
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

  test("brain maintain prunes scratch as its last step", async () => {
    mkdirSync(join(brain, SCRATCH_DIR), { recursive: true });
    const old = join(brain, SCRATCH_DIR, "old.pdf");
    writeFileSync(old, "x");
    const t = (Date.now() - SCRATCH_TTL_MS - 60_000) / 1000;
    utimesSync(old, t, t);
    const res = await runCli(brain, ["maintain", "--json"]);
    const steps = JSON.parse(res.stdout) as { step: string; result: string }[];
    expect(steps.map((s) => s.step)).toEqual(["index", "audit", "scratch"]);
    expect(steps.at(-1)!.result).toContain("removed 1 file(s)");
    expect(existsSync(old)).toBe(false);
  });
});
