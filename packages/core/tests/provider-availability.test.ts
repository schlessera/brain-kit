/**
 * Whether a built-in provider is usable is decided once, in the registry, from
 * the key variable its entry declares. A fake built-in reads its key from a
 * variable no other provider uses: the CLI and the MCP server must both turn
 * it on when that variable is set, and leave it off when it is not.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { join } from "path";
import { writeFileSync } from "fs";

import { BRAIN_BIN, cleanup, keylessEnv, makeTempBrain, runCli } from "./cli-harness";
import { FAKE_BUILTIN, FAKE_KEY_ENV } from "./fixtures/fake-builtin-embeddings";

const PRELOAD = join(import.meta.dir, "fixtures/fake-builtin-embeddings.ts");
const NO_PROVIDER = "vector search unavailable: no embedding provider configured";
const FAKE_ID = "fake-builtin-embeddings";

let root: string;

beforeAll(async () => {
  root = makeTempBrain({ empty: true });
  writeFileSync(join(root, "brain.config.json"), JSON.stringify({ embeddings: { provider: FAKE_BUILTIN } }));
  writeFileSync(join(root, "ithaca.md"), "---\ntype: note\ntitle: Ithaca\n---\nThe road home to Ithaca.\n");
  const idx = await runCli(root, ["index", "--json"]);
  expect(idx.code).toBe(0);
});

afterAll(() => cleanup(root));

function env(keyed: boolean): Record<string, string> {
  const base = keylessEnv(root);
  delete base[FAKE_KEY_ENV];
  return keyed ? { ...base, [FAKE_KEY_ENV]: "test-key" } : base;
}

async function cliWarnings(keyed: boolean): Promise<string[]> {
  const proc = Bun.spawn(["bun", "--preload", PRELOAD, BRAIN_BIN, "search", "Ithaca", "--mode", "vector", "--json"], {
    env: env(keyed),
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  expect(stderr).not.toContain("embedding provider unavailable");
  expect(code).toBe(0);
  return (JSON.parse(stdout) as { warnings?: string[] }).warnings ?? [];
}

async function mcpWarnings(keyed: boolean): Promise<string[]> {
  const transport = new StdioClientTransport({
    command: "bun",
    args: ["--preload", PRELOAD, BRAIN_BIN, "mcp"],
    env: env(keyed),
  });
  const client = new Client({ name: "provider-availability-test", version: "1.0.0" });
  try {
    await client.connect(transport);
    const result = await client.callTool({ name: "brain_search", arguments: { query: "Ithaca", mode: "vector" } });
    expect(result.isError).not.toBe(true);
    return (result.structuredContent as { warnings?: string[] }).warnings ?? [];
  } finally {
    await client.close();
  }
}

describe("a built-in's declared key variable decides its availability", () => {
  for (const [host, warnings] of [["CLI", cliWarnings], ["MCP", mcpWarnings]] as const) {
    test(`${host} turns the fake built-in on when its own key is set`, async () => {
      const keyed = await warnings(true);
      expect(keyed.length).toBeGreaterThan(0);
      expect(keyed.join("\n")).not.toContain(NO_PROVIDER);
      // The provider that answered is the fake: its id reaches the vector lane.
      expect(keyed.join("\n")).toMatch(new RegExp(`${FAKE_ID}|no stored vectors`));
    });

    test(`${host} leaves it off when its key is unset`, async () => {
      expect((await warnings(false)).join("\n")).toContain(NO_PROVIDER);
    });
  }
});
