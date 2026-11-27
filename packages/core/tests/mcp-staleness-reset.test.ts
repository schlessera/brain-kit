/**
 * A write tool that wrote a file resets the MCP staleness cache (#4790), so a
 * read right after the agent's own write never serves a warning computed
 * before it; a write refused before any file changed keeps it (#4888). Each
 * pair of reads falls inside the cache's ten-second floor: without the reset
 * the second read would return the first read's cached answer.
 */
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Database } from "bun:sqlite";
import { utimesSync } from "node:fs";
import { join } from "node:path";
import { indexDbPath } from "@schlessera/brain-common/internal/index-location";
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

const fresh: string[] = [];
afterEach(() => {
  while (fresh.length) cleanup(fresh.pop()!);
});

/** A freshly indexed brain and a connected client whose first read cached "not stale". */
async function connected(): Promise<{ brain: string; client: Client }> {
  const brain = makeTempBrain();
  fresh.push(brain);
  expect((await runCli(brain, ["index", "--json"])).code).toBe(0);
  const client = new Client({ name: "mcp-staleness-reset-test", version: "1.0.0" });
  await client.connect(new StdioClientTransport({ command: "bun", args: [BRAIN_BIN, "mcp"], env: keylessEnv(brain) }));
  expect(await listWarnings(client)).toEqual([]);
  return { brain, client };
}

test("a brain_update refused before it writes keeps the cached staleness answer (#4888)", async () => {
  const { brain, client } = await connected();
  try {
    // Stale from here on, but the cache still holds the first read's answer.
    const future = new Date(Date.now() + 60 * 60 * 1000);
    utimesSync(join(brain, "notes/loose-idea.md"), future, future);
    const update = await client.callTool({ name: "brain_update", arguments: { path: "notes/no-such-harbour.md", summary: "Never written" } });
    expect(update.isError).toBe(true);
    const archive = await client.callTool({ name: "brain_archive", arguments: { path: "notes/no-such-harbour.md" } });
    expect(archive.isError).toBe(true);
    expect(await listWarnings(client)).toEqual([]);
  } finally {
    await client.close();
  }
});

test("a brain_update whose index run throws after the write still resets the cache (#4888)", async () => {
  const { brain, client } = await connected();
  try {
    // The index run fails on the links table, after the file is written.
    const db = new Database(indexDbPath(brain));
    try {
      db.run("DROP TABLE links");
    } finally {
      db.close();
    }
    const update = await client.callTool({ name: "brain_update", arguments: { path: "notes/quick-note-water.md", summary: "Fresh water at the spring" } });
    expect(update.isError).toBe(true);
    expect(await listWarnings(client)).toEqual([expect.stringMatching(/^index is stale \(\d+ file\(s\) newer than index\); run `brain index`$/)]);
  } finally {
    await client.close();
  }
});

for (const [tool, args] of [
  ["brain_add", { content: "The crew mends the sail at dawn.", title: "Mending the sail" }],
  ["brain_archive", { path: "notes/quick-note-water.md" }],
] as const) {
  test(`${tool} resets the cache once it has written a file (#4888)`, async () => {
    const { brain, client } = await connected();
    try {
      const future = new Date(Date.now() + 60 * 60 * 1000);
      utimesSync(join(brain, "notes/loose-idea.md"), future, future);
      const result = await client.callTool({ name: tool, arguments: args });
      expect(result.isError).toBeFalsy();
      expect(await listWarnings(client)).toEqual([expect.stringMatching(/^index is stale \(\d+ file\(s\) newer than index\); run `brain index`$/)]);
    } finally {
      await client.close();
    }
  });
}
