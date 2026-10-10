/**
 * Index staleness has one definition. The MCP read tools warn with it and
 * `brain doctor`'s `db` check reports it, so on one fixture brain both must
 * name the same number of stale files: one edited after indexing, one never
 * indexed, and one indexed and since deleted.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { rmSync, utimesSync, writeFileSync } from "fs";
import { join } from "path";

import { BRAIN_BIN, cleanup, keylessEnv, makeTempBrain, runCli } from "./cli-harness";

let root: string;

/** Edited after indexing, added after indexing, deleted after indexing. */
const EXPECTED_STALE = 3;

beforeAll(async () => {
  root = makeTempBrain();
  // A project MCP config, so doctor's mcp check never probes a host `claude`.
  writeFileSync(
    join(root, ".mcp.json"),
    JSON.stringify({ mcpServers: { brain: { command: "bun", args: ["node_modules/.bin/brain", "mcp"] } } })
  );
  const idx = await runCli(root, ["index", "--json"]);
  expect(idx.code).toBe(0);

  const future = new Date(Date.now() + 60 * 60 * 1000);
  utimesSync(join(root, "notes/loose-idea.md"), future, future);
  writeFileSync(join(root, "notes/after-the-index.md"), "---\ntitle: After the index\ntype: note\n---\n\nWritten later.\n");
  rmSync(join(root, "health/sleep-tracking.md"));
});

afterAll(() => cleanup(root));

/** The count in an `index is stale (N file(s) ...` message, or null. */
function staleCount(text: string | undefined): number | null {
  const match = /index is stale \((\d+) file\(s\)/.exec(text ?? "");
  return match ? Number(match[1]) : null;
}

test("the MCP warning and doctor's db check report the same stale count", async () => {
  const client = new Client({ name: "index-staleness-test", version: "1.0.0" });
  let mcpCount: number | null;
  try {
    await client.connect(new StdioClientTransport({ command: "bun", args: [BRAIN_BIN, "mcp"], env: keylessEnv(root) }));
    const result = await client.callTool({ name: "brain_list", arguments: {} });
    const warnings = (result.structuredContent as { warnings: string[] }).warnings;
    mcpCount = staleCount(warnings.find((w) => w.startsWith("index is stale")));
  } finally {
    await client.close();
  }

  const { stdout, code } = await runCli(root, ["doctor", "--json"]);
  expect(code).toBe(0);
  const db = JSON.parse(stdout).checks.find((c: { id: string }) => c.id === "db") as { status: string; detail: string };
  expect(db.status).toBe("warn");
  const doctorCount = staleCount(db.detail);

  expect({ mcp: mcpCount, doctor: doctorCount }).toEqual({ mcp: EXPECTED_STALE, doctor: EXPECTED_STALE });
});
