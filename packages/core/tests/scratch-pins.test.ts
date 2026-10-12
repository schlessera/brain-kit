import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pruneScratch, SCRATCH_DIR } from "../src/lib/scratch";
import { cleanup, makeTempBrain, runCli } from "./cli-harness";
let root: string;
const now = Date.parse("2026-07-12T12:00:00Z");
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "scratch-pins-")); });
afterEach(() => rmSync(root, { recursive: true, force: true }));
function file(name: string, bytes: number, days: number) {
  const path = join(root, SCRATCH_DIR, name);
  mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, Buffer.alloc(bytes));
  utimesSync(path, (now - days * 86400000) / 1000, (now - days * 86400000) / 1000); return path;
}
function pins(data: unknown) {
  mkdirSync(join(root, ".brain/scratch-pins"), { recursive: true });
  writeFileSync(join(root, ".brain/scratch-pins/pins.json"), JSON.stringify(data));
}
test("a ten-day-old pinned file survives while its unlinked peer expires", () => {
  const kept = file("voyage.pdf", 5, 10), removed = file("draft.pdf", 5, 10);
  pins({ version: 1, ready: true, sessions: { "claude:odysseus": [".brain/scratch/voyage.pdf"] } });
  const report = pruneScratch(root, now);
  expect(existsSync(kept)).toBe(true); expect(existsSync(removed)).toBe(false);
  expect(report).toMatchObject({ pinned: { files: 1, bytes: 5 }, overageBytes: 0 });
});
test("pinned bytes over the cap survive the size pass and report the overage", () => {
  const kept = file("voyage.pdf", 100, 1), removed = file("draft.pdf", 5, 0);
  const report = pruneScratch(root, now, { maxBytes: 80, pinnedPaths: new Set([".brain/scratch/voyage.pdf"]) });
  expect(existsSync(kept)).toBe(true); expect(existsSync(removed)).toBe(false);
  expect(report).toMatchObject({ pinned: { files: 1, bytes: 100 }, bytes: 100, overageBytes: 20 });
});
test("a writer's own paths, absolute or brain-relative, are protected for that call only (#1691)", () => {
  const pinned = file("voyage.pdf", 100, 1), produced = file("chart.png", 5, 0), report = file("report.html", 5, 0), older = file("draft.pdf", 5, 2);
  pins({ version: 1, ready: true, sessions: { odysseus: [".brain/scratch/voyage.pdf"] } });
  const first = pruneScratch(root, now, { maxBytes: 80, pinnedPaths: new Set([produced, ".brain/scratch/report.html"]) });
  expect(existsSync(produced)).toBe(true); expect(existsSync(report)).toBe(true); expect(existsSync(older)).toBe(false);
  expect(existsSync(pinned)).toBe(true); expect(first.overageBytes).toBe(30);
  // The next ordinary pass applies the size policy to the still-unlinked output.
  const later = pruneScratch(root, now, { maxBytes: 80 });
  expect(existsSync(produced)).toBe(false); expect(existsSync(report)).toBe(false); expect(existsSync(pinned)).toBe(true);
  expect(later).toMatchObject({ pinned: { files: 1, bytes: 100 }, overageBytes: 20 });
});
for (const [name, data] of [["corrupt", "bad"], ["incomplete", { version: 1, ready: false, sessions: {} }], ["NUL path", { version: 1, ready: true, sessions: { x: [".brain/scratch/voyage.pdf\u0000"] } }], ["invalid path", { version: 1, ready: true, sessions: { x: ["../voyage.pdf"] } }]] as const) {
  test(`${name} managed pin data cannot cause deletion`, () => {
    const kept = file("voyage.pdf", 100, 10); pins(data);
    const report = pruneScratch(root, now, { maxBytes: 80 });
    expect(existsSync(kept)).toBe(true); expect(report.removed).toEqual([]); expect(report.pinError).toBeTruthy();
  });
}
test("missing managed pin data cannot cause deletion", () => {
  const kept = file("voyage.pdf", 100, 10); mkdirSync(join(root, ".brain/scratch-pins"));
  expect(pruneScratch(root, now, { maxBytes: 80 }).removed).toEqual([]); expect(existsSync(kept)).toBe(true);
});
test("CLI pin input and additive report protect a retained answer", async () => {
  const brain = makeTempBrain();
  try {
    const path = join(brain, SCRATCH_DIR, "voyage.pdf"); mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, "12345"); utimesSync(path, now / 1000, now / 1000);
    const input = join(brain, "pins.json"); writeFileSync(input, JSON.stringify({ version: 1, ready: true, sessions: { odysseus: [".brain/scratch/voyage.pdf"] } }));
    const result = await runCli(brain, ["scratch", "prune", "--pins-file", input, "--json"]);
    expect(result.code).toBe(0); expect(JSON.parse(result.stdout)).toMatchObject({ action: "prune", pinned: { files: 1, bytes: 5 }, overageBytes: 0 });
    expect(existsSync(path)).toBe(true);
    rmSync(input); const missing = await runCli(brain, ["scratch", "prune", "--pins-file", input, "--json"]);
    expect(missing.code).toBe(2); expect(existsSync(path)).toBe(true); expect(JSON.parse(missing.stdout).pinError).toBeTruthy();
  } finally { cleanup(brain); }
});

test("a pin published between listing and removal protects the late retained link", () => {
  const kept = file("voyage.pdf", 5, 10); file("draft.pdf", 5, 10);
  pins({ version: 1, ready: true, sessions: {} });
  const original = fs.readFileSync; let reads = 0;
  const spy = spyOn(fs, "readFileSync").mockImplementation(((...args: Parameters<typeof fs.readFileSync>) => {
    if (++reads === 2) pins({ version: 1, ready: true, sessions: { odysseus: [".brain/scratch/voyage.pdf"] } });
    return original(...args);
  }) as typeof fs.readFileSync);
  try { pruneScratch(root, now); expect(existsSync(kept)).toBe(true); }
  finally { spy.mockRestore(); }
});

test("a pin input without a path refuses before deleting anything", async () => {
  const brain = makeTempBrain();
  try {
    const path = join(brain, SCRATCH_DIR, "voyage.pdf"); mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, "12345"); utimesSync(path, now / 1000, now / 1000);
    for (const args of [["scratch", "prune", "--pins-file", "--json"], ["scratch", "prune", "--pins-file", "", "--json"]]) {
      const result = await runCli(brain, args); expect(result.code).toBe(1); expect(existsSync(path)).toBe(true);
    }
  } finally { cleanup(brain); }
});
