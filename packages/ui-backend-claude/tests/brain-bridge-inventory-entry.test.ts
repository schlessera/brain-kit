import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { canonicalBrainEntry, NOT_CANONICAL, projectDisablesBrain } from "../src/brain-bridge-inventory-entry.js";

const ENTRY = Bun.resolveSync("../src/brain-bridge-inventory-entry", import.meta.dir);
const CANONICAL = { command: "bun", args: ["node_modules/.bin/brain", "mcp"] };
const VERSION = "0.45.0";

test("only the template's exact brain stdio entry is canonical", () => {
  expect(canonicalBrainEntry(CANONICAL)).toBe(true);
  expect(canonicalBrainEntry({ ...CANONICAL, type: "stdio" })).toBe(true);
  for (const entry of [undefined, null, [], { ...CANONICAL, env: { BRAIN_ROOT: "/ithaca" } }, { ...CANONICAL, cwd: "/ithaca" },
    { ...CANONICAL, type: "http" }, { ...CANONICAL, command: "node" }, { ...CANONICAL, args: ["node_modules/.bin/brain", "mcp", "--root", "/ithaca"] },
    { ...CANONICAL, args: ["/ithaca/node_modules/.bin/brain", "mcp"] }])
    expect(canonicalBrainEntry(entry), `NON_CANONICAL ${JSON.stringify(entry)}`).toBe(false);
});

// #4325 F13: the runtime would not start a project server its settings turn off.
test("project settings that turn the brain server off are recognised", () => {
  expect(projectDisablesBrain([undefined, { enableAllProjectMcpServers: true }])).toBe(false);
  expect(projectDisablesBrain([{ enabledMcpjsonServers: ["brain"] }])).toBe(false);
  for (const settings of [{ disabledMcpjsonServers: ["brain"] }, { enableAllProjectMcpServers: false }, { enabledMcpjsonServers: ["ithaca"] }])
    expect(projectDisablesBrain([settings]), `DISABLED ${JSON.stringify(settings)}`).toBe(true);
});

// Runs the real entry the sandbox runs, from a fictional brain root.
function brain(mcp: unknown, options: { settings?: object; version?: string | null; index?: false | "rollback" | "wal-restored" | "wal-live" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "ithaca-bridge-entry-"));
  mkdirSync(join(root, "node_modules/.bin"), { recursive: true });
  writeFileSync(join(root, "node_modules/.bin/brain"), `require("node:fs").writeFileSync("listed", process.argv.slice(2).join(" "));
console.log(JSON.stringify({ enabled: [{ key: "voyage", name: "voyage", tools: [] }], available: [] }));`);
  if (options.version !== null) {
    mkdirSync(join(root, "node_modules/@schlessera/brain"), { recursive: true });
    writeFileSync(join(root, "node_modules/@schlessera/brain/package.json"), JSON.stringify({ name: "@schlessera/brain", version: options.version ?? VERSION }));
  }
  // A fresh core-only brain has no index until its first `brain index`.
  const index = options.index ?? "rollback";
  if (index !== false) {
    mkdirSync(join(root, ".brain-index"));
    const db = new Database(join(root, ".brain-index/brain.db"));
    if (index !== "rollback") db.exec("PRAGMA journal_mode=WAL");
    db.exec("CREATE TABLE ithaca (voyage TEXT)");
    // Closing checkpoints and removes the sidecars, as a restored copy lacks them.
    db.close();
    if (index === "wal-live") for (const sidecar of ["-wal", "-shm"]) writeFileSync(join(root, `.brain-index/brain.db${sidecar}`), "");
  }
  if (options.settings) { mkdirSync(join(root, ".claude")); writeFileSync(join(root, ".claude/settings.json"), JSON.stringify(options.settings)); }
  if (mcp !== undefined) writeFileSync(join(root, ".mcp.json"), typeof mcp === "string" ? mcp : JSON.stringify({ mcpServers: { brain: mcp } }));
  return root;
}
const run = (root: string) => Bun.spawnSync([process.execPath, ENTRY, VERSION], { cwd: root, stdout: "pipe", stderr: "pipe" });

for (const [name, mcp, options] of [
  ["environment override", { ...CANONICAL, env: { BRAIN_ROOT: "/ithaca" } }, {}],
  ["missing file", undefined, {}],
  ["unreadable JSON", "{ Ithaca", {}],
  ["disabled project server", CANONICAL, { settings: { disabledMcpjsonServers: ["brain"] } }],
  ["different brain version", CANONICAL, { version: "0.30.0" }],
  ["missing brain package", CANONICAL, { version: null }],
  // #4894 round 7 F4: the read-only forwarder cannot create the index; the
  // project's stdio entry, which can, keeps brain_read available.
  ["missing index", CANONICAL, { settings: { enableAllProjectMcpServers: true }, index: false }],
  // #4894 round 8 F2: a restored WAL database without its sidecars cannot be
  // opened read-only; the stdio entry can recreate them.
  ["restored WAL index without sidecars", CANONICAL, { settings: { enableAllProjectMcpServers: true }, index: "wal-restored" }],
] as const)
  test(`a project with a ${name} is never inventoried for the bridge`, () => {
    const root = brain(mcp, options);
    try {
      const result = run(root);
      expect(result.exitCode, "NON_CANONICAL_ENTRY_EXITS_NOT_CANONICAL").toBe(NOT_CANONICAL);
      expect(existsSync(join(root, "listed")), "NON_CANONICAL_ENTRY_RUNS_NO_CONFIGURATION").toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

for (const index of ["rollback", "wal-live"] as const) test(`a canonical entry of the host's brain version with a ${index} index passes the module inventory through unchanged`, () => {
  const root = brain(CANONICAL, { settings: { enableAllProjectMcpServers: true }, index });
  try {
    const result = run(root);
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(JSON.parse(result.stdout.toString())).toEqual({ enabled: [{ key: "voyage", name: "voyage", tools: [] }], available: [] });
    expect(Bun.file(join(root, "listed")).size).toBeGreaterThan(0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
