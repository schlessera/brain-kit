/**
 * The scratch area (#310): one prune policy, one exclusion, one command.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { buildTaxonomy } from "../src/lib/taxonomy.js";
import {
  SCRATCH_DIR,
  SCRATCH_MAX_BYTES,
  SCRATCH_TTL_MS,
  cleanScratch,
  ensureScratch,
  ignoreScratch,
  pruneScratch,
  ScratchNotIgnoredError,
  scratchIgnored,
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

describe("gitignore guard", () => {
  const git = (...args: string[]) => Bun.spawnSync(["git", "-C", root, ...args]);

  test("a brain that is not a git repository has nothing to protect", () => {
    expect(scratchIgnored(root)).toBe(true);
    expect(() => ensureScratch(root)).not.toThrow();
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
});

describe("the one exclusion", () => {
  test("every isExcludedPath caller skips scratch, through SCRATCH_DIR", () => {
    const taxonomy = buildTaxonomy({});
    expect(taxonomy.isExcludedPath(`${SCRATCH_DIR}/x.md`)).toBe(true);
    expect(taxonomy.isExcludedPath(`${SCRATCH_DIR}/nested/y.pdf`)).toBe(true);
    expect(taxonomy.isExcludedPath("notes/x.md")).toBe(false);
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
