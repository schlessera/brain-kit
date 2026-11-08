/**
 * `brain context --include/--exclude` and `brain_context`'s `include` and
 * `exclude` (#3644), through the real CLI and the real stdio MCP server,
 * keyless. After indexing, both watched files are named pipes that count
 * every open (`openCounter`), so a test proves an excluded file is never
 * opened by the subprocess, by any call, not only that its text is missing
 * from the output.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { BRAIN_BIN, keylessEnv, runCli } from "./cli-harness";
import { FOCUS, FOCUS_MARKER, makeScopeBrain, openCounter, REGISTRY, REGISTRY_MARKER, SCOPE_QUERY } from "./helpers/context-scope-fixture";

let brain: ReturnType<typeof makeScopeBrain>;
let counters: Array<[string, ReturnType<typeof openCounter>]> = [];

beforeAll(async () => {
  brain = makeScopeBrain();
  const indexed = await runCli(brain.root, ["index", "--json"]);
  expect(indexed.code).toBe(0);
  counters = [FOCUS, REGISTRY].map((rel) => [rel, openCounter(brain.root, rel)]);
});

afterAll(() => {
  for (const [, counter] of counters) counter.stop();
  brain?.cleanup();
});

const counts = async () => Promise.all(counters.map(async ([rel, counter]) => [rel, await counter.opens()] as const));
/** The watched files `run` opened, once each, in fixture order. */
async function opensDuring<T>(run: () => Promise<T>): Promise<{ result: T; opened: string[] }> {
  const before = new Map(await counts());
  const result = await run();
  const opened = (await counts()).filter(([rel, n]) => n > before.get(rel)!).map(([rel]) => rel);
  return { result, opened };
}

async function context(args: string[]): Promise<{ stdout: string; stderr: string; code: number; opened: string[] }> {
  const { result, opened } = await opensDuring(() => runCli(brain.root, ["context", ...args]));
  return { ...result, opened };
}

describe("brain context", () => {
  test("the premise: unscoped, both files are opened and their text returned", async () => {
    const out = await context([SCOPE_QUERY, "--max-tokens", "12000"]);
    expect(out.code).toBe(0);
    expect(out.stdout).toContain(FOCUS_MARKER);
    expect(out.stdout).toContain(`(${REGISTRY})`);
    expect(out.opened, "the counters see an unscoped read").toEqual([FOCUS, REGISTRY]);
    // Unscoped output carries no coverage note.
    expect(out.stdout).not.toContain("### Coverage");
  });

  test("--exclude keeps both files unopened and out of every lane, and a coverage note follows", async () => {
    const out = await context([SCOPE_QUERY, "--max-tokens", "12000", "--exclude", FOCUS, "--exclude", REGISTRY]);
    expect(out.code).toBe(0);
    expect(out.opened, "CLI_EXCLUDED_NOT_OPENED").toEqual([]);
    for (const marker of [FOCUS_MARKER, REGISTRY_MARKER, `(${FOCUS})`, `(${REGISTRY})`, "## Current Focus"]) {
      expect(out.stdout).not.toContain(marker);
    }
    expect(out.stdout).toContain("## Identity");
    expect(out.stdout).toContain("### Coverage\nScoped briefing: ranked excerpts within a budget, not an inventory of the scope.");
    expect(out.stdout).toContain(`exclude ${FOCUS}, ${REGISTRY}`);
  });

  test("--include constrains the briefing and names the requested paths it left out", async () => {
    const out = await context([
      SCOPE_QUERY, "--include", "projects/active/sail-repairs/", "--include", "health/knee-injury.md", "--include", "notes/missing.md",
    ]);
    expect(out.code).toBe(0);
    const paths = [...out.stdout.matchAll(/^### .*?\(([^)]+\.md)\)/gm)].map((m) => m[1]!);
    expect(paths.length).toBeGreaterThan(0);
    for (const path of paths) expect(path.startsWith("projects/active/sail-repairs/"), path).toBe(true);
    expect(out.stdout).not.toContain("## Identity");
    expect(out.stdout).toContain("health/knee-injury.md (not ranked)");
    expect(out.stdout).toContain("notes/missing.md (unavailable)");
  });

  test("an invalid entry is a usage error and runs no query", async () => {
    for (const bad of ["../outside.md", "/etc/hosts"]) {
      const out = await context([SCOPE_QUERY, "--include", bad]);
      expect(out.code).toBe(1);
      expect(out.stdout).toBe("");
      expect(out.stderr).toContain("include:");
      expect(out.opened).toEqual([]);
    }
    const missing = await context([SCOPE_QUERY, "--exclude"]);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain("--exclude needs a value");
  });
});

describe("brain_context", () => {
  let client: Client;

  beforeAll(async () => {
    const transport = new StdioClientTransport({ command: "bun", args: [BRAIN_BIN, "mcp"], env: keylessEnv(brain.root) });
    client = new Client({ name: "context-scope-test", version: "1.0.0" });
    await client.connect(transport);
  });

  afterAll(async () => {
    await client?.close();
  });

  type Block = { type: string; text: string };
  const call = async (args: Record<string, unknown>) => {
    const { result, opened } = await opensDuring(() =>
      client.callTool({ name: "brain_context", arguments: { query: SCOPE_QUERY, max_tokens: 12000, ...args } })
    );
    return { result, content: result.content as Block[], opened };
  };

  test("the premise: unscoped, the focus is opened and there is no coverage", async () => {
    const { result, content, opened: during } = await call({});
    expect(during, "the counters see an unscoped read").toContain(FOCUS);
    const structured = result.structuredContent as Record<string, unknown>;
    expect(Object.keys(structured).sort()).toEqual(["context", "warnings"]);
    expect(content[0]!.text).toBe(structured.context as string);
    expect(content.some((block) => block.text.startsWith("### Coverage"))).toBe(false);
  });

  test("exclude keeps both files unopened and returns the coverage as its last block and in structuredContent", async () => {
    const { result, content, opened: during } = await call({ exclude: [FOCUS, REGISTRY] });
    expect(result.isError).toBeFalsy();
    expect(during, "MCP_EXCLUDED_NOT_OPENED").toEqual([]);
    const structured = result.structuredContent as { context: string; coverage: { exhaustive: boolean; excerpts: Array<{ path: string; lane: string; form: string }> } };
    for (const marker of [FOCUS_MARKER, REGISTRY_MARKER, `(${FOCUS})`, `(${REGISTRY})`]) expect(structured.context).not.toContain(marker);
    // The first block is still the context text itself.
    expect(content[0]!.text).toBe(structured.context);
    expect(content.at(-1)!.text.startsWith("### Coverage")).toBe(true);
    expect(structured.coverage.exhaustive).toBe(false);
    expect(structured.coverage.excerpts.map((e) => e.path)).not.toContain(FOCUS);
    expect(structured.coverage.excerpts[0]).toEqual({ path: "me/identity.md", lane: "identity", form: "whole" });
  });

  test("include constrains every lane", async () => {
    const { result } = await call({ include: ["projects/active/sail-repairs/"], include_identity: true });
    const { coverage } = result.structuredContent as { coverage: { include: string[]; excerpts: Array<{ path: string }> } };
    expect(coverage.include).toEqual(["projects/active/sail-repairs/"]);
    expect(coverage.excerpts.length).toBeGreaterThan(0);
    for (const excerpt of coverage.excerpts) expect(excerpt.path.startsWith("projects/active/sail-repairs/"), excerpt.path).toBe(true);
  });

  test("an invalid or oversized scope is a tool error", async () => {
    const escape = await call({ include: ["../outside.md"] });
    expect(escape.result.isError).toBe(true);
    expect(escape.opened).toEqual([]);
    const oversized = await call({ exclude: Array.from({ length: 65 }, (_, i) => `notes/${i}.md`) });
    expect(oversized.result.isError).toBe(true);
  });
});
