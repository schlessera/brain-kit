/**
 * Frontmatter edits keep every byte they were not asked to change (#449):
 * archiving and `brain_update` go through `editFrontmatter`, so comments,
 * quoting, flow sequences, key order and blank lines survive.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { archiveDocument } from "../src/lib/archiver";
import { editFrontmatter, updateDocument } from "../src/lib/frontmatter-edit";
import { BRAIN_BIN, cleanup, keylessEnv, makeTempBrain, runCli } from "./cli-harness";

const TODAY = new Date().toISOString().slice(0, 10);

// An inline comment, a standalone comment line, a quoted string, a flow
// sequence, a block list and a blank line: everything a serializer rewrites.
const LINES = [
  "---",
  "# Owner's note: keep this line",
  'title: "Demo"  # keep this comment',
  "type: note",
  "status: active",
  "relevance: 'primary'",
  "tags: [one,two]",
  "aliases:",
  "  - first",
  "  - second",
  "created: 2026-01-01",
  "updated: 2026-01-05",
  "",
  "summary: plain words here",
  "---",
  "",
  "Body text.",
  "",
];
const SOURCE = LINES.join("\n");

/** SOURCE with the listed lines replaced (by their exact old text), every other line as it was. */
function withLines(replacements: Record<string, string | null>, appendBeforeFence: string[] = []): string {
  const out: string[] = [];
  const fence = LINES.lastIndexOf("---");
  LINES.forEach((line, i) => {
    if (i === fence) out.push(...appendBeforeFence);
    if (line in replacements) {
      const next = replacements[line];
      if (next !== null) out.push(next);
    } else {
      out.push(line);
    }
  });
  return out.join("\n");
}

const temps: string[] = [];
afterAll(() => { for (const dir of temps) rmSync(dir, { recursive: true, force: true }); });

test("archiving changes only the archive fields; every other line is byte-identical", async () => {
  const root = mkdtempSync(join(tmpdir(), "brain-fm-archive-"));
  temps.push(root);
  mkdirSync(join(root, "notes"), { recursive: true });
  writeFileSync(join(root, "notes/demo.md"), SOURCE);
  await archiveDocument(root, "notes/demo.md");
  expect(readFileSync(join(root, "notes/demo.md"), "utf8")).toBe(withLines({
    "status: active": "status: archived",
    "relevance: 'primary'": "relevance: 'historical'",
    "updated: 2026-01-05": `updated: ${TODAY}`,
  }));
});

describe("brain_update over MCP", () => {
  let root: string;
  let client: Client;

  beforeAll(async () => {
    root = makeTempBrain({ empty: true });
    writeFileSync(join(root, "brain.config.ts"), "export default {};\n");
    mkdirSync(join(root, "notes"), { recursive: true });
    writeFileSync(join(root, "notes/demo.md"), SOURCE);
    expect((await runCli(root, ["index", "--json"])).code).toBe(0);
    client = new Client({ name: "frontmatter-edit-test", version: "1.0.0" });
    await client.connect(new StdioClientTransport({ command: "bun", args: [BRAIN_BIN, "mcp"], env: keylessEnv(root) }));
  });

  afterAll(async () => {
    await client?.close();
    cleanup(root);
  });

  const update = async (args: Record<string, unknown>) => {
    writeFileSync(join(root, "notes/demo.md"), SOURCE);
    const res = await client.callTool({ name: "brain_update", arguments: { path: "notes/demo.md", ...args } });
    expect(res.isError).toBeFalsy();
    return readFileSync(join(root, "notes/demo.md"), "utf8");
  };

  test("setting one field leaves the rest of the frontmatter byte-identical", async () => {
    expect(await update({ summary: "new words: with a colon" })).toBe(withLines({
      "summary: plain words here": 'summary: "new words: with a colon"',
      "updated: 2026-01-05": `updated: ${TODAY}`,
    }));
  });

  test("a key that did not exist is appended without reformatting the others", async () => {
    expect(await update({ deadline: "2026-12-01" })).toBe(
      withLines({ "updated: 2026-01-05": `updated: ${TODAY}` }, ["deadline: 2026-12-01"])
    );
  });

  test("tags replace the flow sequence in place, and appended content leaves the frontmatter alone", async () => {
    expect(await update({ tags: "one, three", append_content: "## Later\n\nMore." })).toBe(
      withLines({
        "tags: [one,two]": "tags: [one, three]",
        "updated: 2026-01-05": `updated: ${TODAY}`,
      }).replace(/\n$/, "") + "\n\n## Later\n\nMore.\n"
    );
  });
});

describe("editFrontmatter", () => {
  test("a block list is replaced on its key's line, keeping the key's comment", () => {
    const text = "---\ntitle: T\ntags: # the old way\n  - a\n  - b\nupdated: 2026-01-05\n---\nbody\n";
    expect(editFrontmatter(text, { tags: ["c"] })).toBe("---\ntitle: T\ntags: [c] # the old way\nupdated: 2026-01-05\n---\nbody\n");
  });

  test("null removes the key and its value lines", () => {
    const text = "---\ntitle: T\ndeadline: 2026-12-01 # due\nnext: x\n---\nbody\n";
    expect(editFrontmatter(text, { deadline: null })).toBe("---\ntitle: T\nnext: x\n---\nbody\n");
  });

  test("a value form it does not rewrite is refused, and updateDocument falls back to the serializer", () => {
    const text = "---\ntitle: T\nsummary: |\n  two\n  lines\n---\nbody\n";
    expect(editFrontmatter(text, { summary: "one" })).toBeNull();
    expect(updateDocument(text, { summary: "one" })).toContain("summary: one");
  });

  test("a value YAML would read back differently is refused", () => {
    // Plain 2026-02-30 is a YAML timestamp that rolls over to March 2.
    const text = "---\ntitle: T\ndeadline: 2026-12-01\n---\nbody\n";
    expect(editFrontmatter(text, { deadline: "2026-02-30" })).toBeNull();
  });

  test("a document whose frontmatter does not parse after the edit is refused", () => {
    // A key repeated at the top level: YAML keeps the last, the edit the first.
    const text = "---\nstatus: active\nstatus: draft\n---\nbody\n";
    expect(editFrontmatter(text, { status: "archived" })).toBeNull();
  });
});
