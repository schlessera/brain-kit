/**
 * Pi's side of #3643: `brain_list`'s path_prefix/overview/cursor page and
 * `brain_search`'s overview, executed through the real tool definitions
 * against a copy of the Odysseus corpus. The page must equal what
 * `brain list --json` and the MCP `brain_list` return for the same index;
 * the legacy outputs must stay as they were.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdirSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { createKeyedLock } from "@schlessera/brain-ui-sdk/server";
import type { DocumentPage } from "@schlessera/brain/queries";

import { BRAIN_BIN, cleanup, keylessEnv, makeTempBrain, runCli } from "../../core/tests/cli-harness";
import { createBrainAccess } from "../src/brain-access";
import { MAX_OUTPUT_BYTES } from "../src/tool-kit";
import { createBrainTools, toolLockFromKeyed } from "../src/tools";
import { createTurnContext } from "../src/turn-context";
import { resultText } from "./helpers";

let root: string;
let client: Client;
let call: (name: "brain_list" | "brain_search", args?: Record<string, unknown>) => Promise<{ text: string; details: unknown }>;

/** Enough long-summary notes that an overview search must stop at its budget. */
const SUITORS = 120;

function write(rel: string, text: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
}

beforeAll(async () => {
  delete process.env.GEMINI_API_KEY;
  delete process.env.GOOGLE_API_KEY;
  root = makeTempBrain();
  for (let i = 0; i < SUITORS; i++) {
    const n = String(i).padStart(3, "0");
    const summary = `Suitor ${n} feasts in the hall of Ithaca and waits for Penelope's answer. `.repeat(6);
    write(
      `notes/suitors/suitor-${n}.md`,
      `---\ntype: note\ntitle: "Suitor ${n}"\ncreated: 2026-07-01\nupdated: 2026-07-12\nstatus: active\nrelevance: secondary\nsummary: ${JSON.stringify(summary)}\n---\n\nThe suitor ${n} eats and drinks in the megaron.\n`
    );
  }
  const indexed = await runCli(root, ["index", "--json"]);
  expect(indexed.code).toBe(0);

  const tools = createBrainTools({ brain: createBrainAccess(root), turn: createTurnContext(), lock: toolLockFromKeyed(createKeyedLock()) });
  call = async (name, args = {}) => {
    const tool = tools.find((t) => t.name === name)!;
    const result = await tool.execute("call", args as never, undefined, undefined, {} as never);
    return { text: resultText(result), details: result.details };
  };

  client = new Client({ name: "pi-overview-parity", version: "1.0.0" });
  await client.connect(new StdioClientTransport({ command: "bun", args: [BRAIN_BIN, "mcp"], env: keylessEnv(root) }));
});

afterAll(async () => {
  await client?.close();
  cleanup(root);
});

describe("pi brain_list paged discovery", () => {
  test("a legacy call returns the legacy rows and envelope", async () => {
    const { text } = await call("brain_list", { type: "project", limit: 5 });
    const value = JSON.parse(text) as { documents: object[] };
    expect(Object.keys(value)).toEqual(["documents"]);
    for (const row of value.documents) expect(Object.keys(row)).toEqual(["path", "title", "type", "relevance", "status", "tags"]);
  });

  test("CLI, MCP and pi return the same page and cursor for the same request", async () => {
    let cursor: string | undefined;
    const seen: string[] = [];
    for (let i = 0; i < 20; i++) {
      const extra = cursor ? { cursor } : {};
      const pi = JSON.parse((await call("brain_list", { path_prefix: "projects", overview: true, limit: 2, ...extra })).text) as DocumentPage;
      const mcp = (await client.callTool({ name: "brain_list", arguments: { path_prefix: "projects", overview: true, limit: 2, ...extra } }))
        .structuredContent as DocumentPage;
      const cli = await runCli(root, ["list", "--path-prefix", "projects", "--overview", "--limit", "2", ...(cursor ? ["--cursor", cursor] : []), "--json"]);
      expect(cli.code).toBe(0);
      expect(pi).toEqual(mcp);
      expect(pi).toEqual(JSON.parse(cli.stdout));
      seen.push(...pi.documents.map((d) => d.path));
      if (pi.next_cursor === null) break;
      cursor = pi.next_cursor;
    }
    expect(seen).toContain("projects/active/raft/status.md");
    expect(new Set(seen).size).toBe(seen.length);
  });

  test("a page of long summaries stays within the tool's output budget and advances", async () => {
    const { text } = await call("brain_list", { path_prefix: "notes/suitors", overview: true, limit: 100 });
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(MAX_OUTPUT_BYTES);
    const page = JSON.parse(text) as DocumentPage;
    expect(page.truncated).toBe(true);
    expect(page.total).toBe(SUITORS);
    expect(page.documents.length).toBeGreaterThan(0);
    expect(page.next_cursor).toBeString();
  });

  test("an invalid cursor or prefix is a thrown tool error naming the inputs", async () => {
    await expect(call("brain_list", { cursor: "nope" })).rejects.toThrow("a cursor only continues the listing that returned it");
    await expect(call("brain_list", { path_prefix: "../ithaca" })).rejects.toThrow("path_prefix must be a root-relative folder or file");
  });
});

describe("pi brain_search overview", () => {
  test("keeps core's status, dates and summary when asked", async () => {
    const { text } = await call("brain_search", { query: "raft status next action", limit: 5, overview: true });
    expect(text).toContain("- projects/active/raft/status.md — Raft — Status [project] · status active · updated 2026-06-30 · due 2026-07-29");
    expect(text).toContain("    summary: Latest planning check and next action for leaving Ogygia");
  });

  test("the default output is the legacy format, without the overview facts", async () => {
    const { text } = await call("brain_search", { query: "raft status next action", limit: 5 });
    expect(text).toContain("- projects/active/raft/status.md — Raft — Status [project]");
    expect(text).not.toContain("summary:");
    expect(text).not.toContain("· status");
  });

  test("an overview too large for the budget keeps whole entries and counts the rest", async () => {
    const { text, details } = await call("brain_search", { query: "suitor feasts megaron", limit: SUITORS, overview: true });
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(MAX_OUTPUT_BYTES);
    const footer = /\n… (\d+) more result\(s\) omitted to fit the output budget$/.exec(text);
    expect(footer).not.toBeNull();
    const entries = text.split("\n").filter((l) => l.startsWith("- "));
    expect(entries.length + Number(footer![1])).toBe((details as { count: number }).count);
    // Every listed entry is whole: its summary line follows it, capped at 300 code points.
    const summaries = text.split("\n").filter((l) => l.startsWith("    summary: "));
    expect(summaries.length).toBe(entries.length);
    for (const s of summaries) expect(Array.from(s.slice("    summary: ".length)).length).toBeLessThanOrEqual(300);
  });
});
