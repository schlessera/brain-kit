/**
 * A write tool's index run resets the MCP staleness cache (#4790), so a read
 * right after the agent's own write never serves a warning computed before it.
 * Both reads fall inside the cache's ten-second floor: without the reset the
 * second read would return the first read's cached answer.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { utimesSync } from "node:fs";
import { join } from "node:path";
import { BRAIN_BIN, cleanup, keylessEnv, makeTempBrain, runCli } from "./cli-harness";

let root: string;
beforeAll(async () => {
  root = makeTempBrain();
  expect((await runCli(root, ["index", "--json"])).code).toBe(0);
});
afterAll(() => cleanup(root));

const listWarnings = async (client: Client) =>
  ((await client.callTool({ name: "brain_list", arguments: {} })).structuredContent as { warnings: string[] }).warnings;

test("brain_update resets the staleness cache, so the next read probes again", async () => {
  const client = new Client({ name: "mcp-staleness-reset-test", version: "1.0.0" });
  try {
    await client.connect(new StdioClientTransport({ command: "bun", args: [BRAIN_BIN, "mcp"], env: keylessEnv(root) }));
    expect(await listWarnings(client)).toEqual([]);

    // Edited elsewhere: a targeted write leaves it unindexed, so it is stale.
    const future = new Date(Date.now() + 60 * 60 * 1000);
    utimesSync(join(root, "notes/loose-idea.md"), future, future);
    const update = await client.callTool({ name: "brain_update", arguments: { path: "notes/quick-note-water.md", summary: "Fresh water at the spring" } });
    expect(update.isError).toBeFalsy();

    // At least the note edited elsewhere; the updated note itself can also count
    // when its write shares the index run's millisecond.
    expect(await listWarnings(client)).toEqual([expect.stringMatching(/^index is stale \(\d+ file\(s\) newer than index\); run `brain index`$/)]);
  } finally {
    await client.close();
  }
});
