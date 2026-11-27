import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalBrainEntry, NOT_CANONICAL } from "../src/brain-bridge-inventory-entry.js";

const ENTRY = Bun.resolveSync("../src/brain-bridge-inventory-entry", import.meta.dir);
const CANONICAL = { command: "bun", args: ["node_modules/.bin/brain", "mcp"] };

test("only the template's exact brain stdio entry is canonical", () => {
  expect(canonicalBrainEntry(CANONICAL)).toBe(true);
  expect(canonicalBrainEntry({ ...CANONICAL, type: "stdio" })).toBe(true);
  for (const entry of [undefined, null, [], { ...CANONICAL, env: { BRAIN_ROOT: "/ithaca" } }, { ...CANONICAL, cwd: "/ithaca" },
    { ...CANONICAL, type: "http" }, { ...CANONICAL, command: "node" }, { ...CANONICAL, args: ["node_modules/.bin/brain", "mcp", "--root", "/ithaca"] },
    { ...CANONICAL, args: ["/ithaca/node_modules/.bin/brain", "mcp"] }])
    expect(canonicalBrainEntry(entry), `NON_CANONICAL ${JSON.stringify(entry)}`).toBe(false);
});

// Runs the real entry the sandbox runs, from a fictional brain root.
function brain(mcp: unknown) {
  const root = mkdtempSync(join(tmpdir(), "ithaca-bridge-entry-"));
  mkdirSync(join(root, "node_modules/.bin"), { recursive: true });
  writeFileSync(join(root, "node_modules/.bin/brain"), `require("node:fs").writeFileSync("listed", process.argv.slice(2).join(" "));
console.log(JSON.stringify({ enabled: [{ key: "voyage", name: "voyage", tools: [] }], available: [] }));`);
  if (mcp !== undefined) writeFileSync(join(root, ".mcp.json"), typeof mcp === "string" ? mcp : JSON.stringify({ mcpServers: { brain: mcp } }));
  return root;
}
for (const [name, mcp] of [["environment override", { ...CANONICAL, env: { BRAIN_ROOT: "/ithaca" } }], ["missing file", undefined], ["unreadable JSON", "{ Ithaca"]] as const)
  test(`a project entry with a ${name} is never inventoried for the bridge`, () => {
    const root = brain(mcp);
    try {
      const run = Bun.spawnSync([process.execPath, ENTRY], { cwd: root, stdout: "pipe", stderr: "pipe" });
      expect(run.exitCode, "NON_CANONICAL_ENTRY_EXITS_NOT_CANONICAL").toBe(NOT_CANONICAL);
      expect(existsSync(join(root, "listed")), "NON_CANONICAL_ENTRY_RUNS_NO_CONFIGURATION").toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

test("a canonical entry passes the brain's module inventory through unchanged", () => {
  const root = brain(CANONICAL);
  try {
    const run = Bun.spawnSync([process.execPath, ENTRY], { cwd: root, stdout: "pipe", stderr: "pipe" });
    expect(run.exitCode, run.stderr.toString()).toBe(0);
    expect(JSON.parse(run.stdout.toString())).toEqual({ enabled: [{ key: "voyage", name: "voyage", tools: [] }], available: [] });
    expect(Bun.file(join(root, "listed")).size).toBeGreaterThan(0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
