/**
 * Archiving through `brain_update` (#450): setting `status: archived` applies
 * the relevance rule `brain archive` applies (#413). A primary or missing
 * relevance becomes historical, whether it is the document's or passed in
 * the same call; an explicit secondary or historical stays.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

import { parseFrontmatter } from "@schlessera/brain-common/internal/frontmatter";

import { BRAIN_BIN, cleanup, keylessEnv, makeTempBrain, runCli } from "./cli-harness";

const doc = (relevance: string | null) =>
  ["---", "title: Demo", "type: note", "status: active", ...(relevance ? [`relevance: ${relevance}`] : []), "updated: 2026-01-05", "---", "", "Body.", ""].join("\n");

let root: string;
let client: Client;

beforeAll(async () => {
  root = makeTempBrain({ empty: true });
  writeFileSync(join(root, "brain.config.ts"), "export default {};\n");
  mkdirSync(join(root, "notes"), { recursive: true });
  writeFileSync(join(root, "notes/demo.md"), doc("primary"));
  expect((await runCli(root, ["index", "--json"])).code).toBe(0);
  client = new Client({ name: "update-archive-relevance-test", version: "1.0.0" });
  await client.connect(new StdioClientTransport({ command: "bun", args: [BRAIN_BIN, "mcp"], env: keylessEnv(root) }));
});

afterAll(async () => {
  await client?.close();
  cleanup(root);
});

async function update(relevance: string | null, args: Record<string, unknown>) {
  writeFileSync(join(root, "notes/demo.md"), doc(relevance));
  const res = await client.callTool({ name: "brain_update", arguments: { path: "notes/demo.md", ...args } });
  expect(res.isError).toBeFalsy();
  const text = (res.content as Array<{ text: string }>)[0].text;
  const data = parseFrontmatter(readFileSync(join(root, "notes/demo.md"), "utf8")).data;
  return { changes: JSON.parse(text).changes as string[], relevance: data.relevance, status: data.status };
}

test("archiving a primary document demotes it to historical and reports the change", async () => {
  const out = await update("primary", { status: "archived" });
  expect(out.status).toBe("archived");
  expect(out.relevance).toBe("historical");
  expect(out.changes).toEqual(["status", "relevance"]);
});

test("archiving a document with no relevance sets historical", async () => {
  expect((await update(null, { status: "archived" })).relevance).toBe("historical");
});

test("an explicit secondary survives archiving", async () => {
  const out = await update("secondary", { status: "archived" });
  expect(out.relevance).toBe("secondary");
  expect(out.changes).toEqual(["status"]);
});

test("a primary passed in the same call is demoted too, reported once", async () => {
  const out = await update("secondary", { status: "archived", relevance: "primary" });
  expect(out.relevance).toBe("historical");
  expect(out.changes).toEqual(["status", "relevance"]);
});

test("a secondary passed in the same call is kept", async () => {
  expect((await update("primary", { status: "archived", relevance: "secondary" })).relevance).toBe("secondary");
});

test("a status other than archived leaves relevance alone", async () => {
  expect((await update("primary", { status: "draft" })).relevance).toBe("primary");
});
