/**
 * `brain add --tags` splits the list the way `brain_add` does (#4711): trimmed,
 * empties dropped, and a list with nothing left means no tags were given, so
 * the classifier's tags apply.
 */
import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseFrontmatter } from "@schlessera/brain-common/internal/frontmatter";
import { initContext } from "../src/lib/context";
import { openDatabase } from "../src/lib/db";
import { addDocument, splitTags } from "../src/lib/ops/write";
import { cleanup, makeTempBrain, runCli } from "./cli-harness";

const temps: string[] = [];
afterEach(() => {
  while (temps.length) cleanup(temps.pop()!);
});

const CONTENT = "Penelope unravels the shroud at night while the suitors feast in the hall";

function brain(): string {
  const root = makeTempBrain();
  temps.push(root);
  return root;
}

async function cliAdd(root: string, tags: string): Promise<unknown> {
  const result = await runCli(root, ["add", CONTENT, "--tags", tags, "--json"]);
  expect(result.code, result.stderr).toBe(0);
  const { path } = JSON.parse(result.stdout) as { path: string };
  return parseFrontmatter(readFileSync(join(root, path), "utf8"), { dataOnly: true }).data.tags;
}

test("brain add --tags drops an empty tag between commas", async () => {
  expect(await cliAdd(brain(), "a,,b")).toEqual(["a", "b"]);
});

test("brain add --tags with only commas writes the classifier's tags, as brain_add does", async () => {
  const cliTags = await cliAdd(brain(), ",");

  // brain_add's own path: the MCP handler splits with splitTags and calls addDocument.
  const root = brain();
  const context = await initContext({ root });
  const db = openDatabase(context.dbPath);
  let mcpTags: unknown;
  try {
    const outcome = await addDocument({ db, root, taxonomy: context.taxonomy }, { content: CONTENT, tags: splitTags(",") });
    mcpTags = parseFrontmatter(readFileSync(join(root, outcome.path), "utf8"), { dataOnly: true }).data.tags;
  } finally {
    db.close();
  }
  expect(Array.isArray(mcpTags) && mcpTags.length > 0).toBe(true);
  expect(cliTags).toEqual(mcpTags);
});
