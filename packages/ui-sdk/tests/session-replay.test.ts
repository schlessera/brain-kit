import { afterEach, expect, test } from "bun:test";
import { linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sessionReplay } from "../src/server/session-replay.js";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "odysseus-replay-")); roots.push(root);
  const brain = join(root, "ithaca"), storage = join(root, "state"); mkdirSync(brain); mkdirSync(storage);
  return { root, brain, storage };
}
test("display mappings persist by session, message, part and exact native text", () => {
  const { brain, storage } = fixture(), original = "[Ithaca](/tmp/chart.pdf)", displayed = "[Ithaca](.brain/scratch/chart.pdf)";
  const store = sessionReplay(storage, brain, "odysseus");
  store.retainText("athena", 1, original, displayed);
  const read = sessionReplay(storage, brain, "odysseus").texts();
  expect(read("athena", 1, original)).toBe(displayed);
  expect(read("athena", 0, original)).toBe(original);
  expect(read("penelope", 1, original)).toBe(original);
  expect(read("athena", 1, original + "changed")).toBe(original + "changed");
  expect(sessionReplay(storage, brain, "telemachus").texts()("athena", 1, original)).toBe(original);
  // Native ids cannot address a property or a path in the host store.
  store.retainText("__proto__", 0, original, displayed);
  expect(sessionReplay(storage, brain, "odysseus").texts()("__proto__", 0, original)).toBe(displayed);
});
test("receipt identity is stable across snapshots without duplicate replay records", () => {
  const { brain, storage } = fixture(), store = sessionReplay(storage, brain, "odysseus");
  const receipt = { id: "raft-call", name: "write_file", input: { path: "notes/raft.md" }, output: "committed", isError: false, anchor: "u1" };
  store.retainReceipt(receipt); store.retainReceipt({ ...receipt, output: "server committed" });
  expect(sessionReplay(storage, brain, "odysseus").receipts()).toEqual([{ ...receipt, output: "server committed" }]);
});
test("replay storage is never created inside the authoritative brain", () => {
  const { brain } = fixture(), store = sessionReplay(brain, brain, "odysseus");
  expect(() => store.retainText("athena", 0, "original", "promoted")).toThrow("outside");
  expect(readdirSync(brain)).toEqual([]);
});
for (const alias of ["symlink", "hardlink"] as const) test(`replay storage refuses ${alias} file aliases`, () => {
  const { root, brain, storage } = fixture(), store = sessionReplay(storage, brain, "odysseus");
  store.retainText("athena", 0, "original", "promoted");
  const parent = join(storage, "session-replay", readdirSync(join(storage, "session-replay"))[0]!);
  const file = join(parent, readdirSync(parent)[0]!), outside = join(root, "outside");
  if (alias === "symlink") { linkSync(file, outside); rmSync(file); symlinkSync(outside, file); }
  else linkSync(file, outside);
  const original = readFileSync(outside, "utf8");
  expect(() => store.texts()).toThrow();
  expect(() => store.retainText("athena", 0, "original", "changed")).toThrow();
  expect(readFileSync(outside, "utf8")).toBe(original);
});
test("replay storage refuses an ancestor redirected into the brain before writing", () => {
  const { root, brain } = fixture(); symlinkSync(brain, join(root, "redirected"));
  const store = sessionReplay(join(root, "redirected"), brain, "odysseus");
  expect(() => store.retainText("athena", 0, "original", "promoted")).toThrow("outside");
  expect(readdirSync(brain)).toEqual([]);
});
