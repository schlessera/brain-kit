/**
 * Date filters and date sorts on `brain search` and `brain_search` (#410).
 *
 * A temp copy of the fixture corpus gains a handful of "lantern" docs whose
 * `updated` and `deadline` sit one day either side of a boundary, so each
 * inclusive bound is tested on its own document. The copy keeps the pinned
 * corpus counts elsewhere untouched.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";

import { BRAIN_BIN, cleanup, keylessEnv, makeTempBrain, runCli } from "./cli-harness";

// updated: 08-09 / 08-10 / 08-11 around 2026-08-10; deadline: 10-09 / 10-10 /
// 10-11 around 2026-10-10.
const DOCS: Record<string, { updated: string; deadline?: string }> = {
  "notes/lantern-a.md": { updated: "2026-08-09", deadline: "2026-10-09" },
  "notes/lantern-b.md": { updated: "2026-08-10", deadline: "2026-10-10" },
  "notes/lantern-c.md": { updated: "2026-08-11", deadline: "2026-10-11" },
  // A quoted timestamp stays a string with its time on it.
  "notes/lantern-timed.md": { updated: '"2026-08-10T09:30:00Z"' },
  "notes/lantern-far.md": { updated: "2026-08-01", deadline: "2099-01-01" },
  "notes/lantern-past.md": { updated: "2026-08-01", deadline: "2000-01-01" },
};

let root: string;

beforeAll(async () => {
  root = makeTempBrain();
  mkdirSync(join(root, "notes"), { recursive: true });
  for (const [path, { updated, deadline }] of Object.entries(DOCS)) {
    const lines = ["---", "type: note", `title: "Lantern ${path}"`, "created: 2026-01-01", `updated: ${updated}`, "tags: [lantern]"];
    if (deadline) lines.push(`deadline: ${deadline}`);
    lines.push("---", "", "Check the lantern wick.", "");
    writeFileSync(join(root, path), lines.join("\n"));
  }
  const idx = await runCli(root, ["index", "--json"]);
  expect(idx.code).toBe(0);
});

afterAll(() => cleanup(root));

async function search(...args: string[]): Promise<string[]> {
  const { stdout, stderr, code } = await runCli(root, ["search", ...args, "--limit", "50", "--json"]);
  if (code !== 0) throw new Error(`exit ${code}: ${stderr}`);
  return (JSON.parse(stdout).results as { path: string }[]).map((r) => r.path);
}

// Each bound runs through the full-text lane (a query) and the filter-only
// lane (no query), which build their SQL separately.
for (const [lane, query] of [["full-text", ["lantern", "--mode", "fts"]], ["filter-only", []]] as const) {
  describe(`${lane} lane`, () => {
    test("--updated-since includes its own date", async () => {
      expect(await search(...query, "--updated-since", "2026-08-10")).toContain("notes/lantern-b.md");
    });
    test("--updated-since excludes the day before", async () => {
      expect(await search(...query, "--updated-since", "2026-08-10")).not.toContain("notes/lantern-a.md");
    });
    test("--updated-before includes its own date", async () => {
      expect(await search(...query, "--updated-before", "2026-08-10")).toContain("notes/lantern-b.md");
    });
    test("--updated-before includes a timestamp on its own date", async () => {
      expect(await search(...query, "--updated-before", "2026-08-10")).toContain("notes/lantern-timed.md");
    });
    test("--updated-before excludes the day after", async () => {
      expect(await search(...query, "--updated-before", "2026-08-10")).not.toContain("notes/lantern-c.md");
    });
    test("--deadline-from includes its own date", async () => {
      expect(await search(...query, "--deadline-from", "2026-10-10")).toContain("notes/lantern-b.md");
    });
    test("--deadline-from excludes the day before", async () => {
      expect(await search(...query, "--deadline-from", "2026-10-10")).not.toContain("notes/lantern-a.md");
    });
    test("--deadline-to includes its own date", async () => {
      expect(await search(...query, "--deadline-to", "2026-10-10")).toContain("notes/lantern-b.md");
    });
    test("--deadline-to excludes the day after", async () => {
      expect(await search(...query, "--deadline-to", "2026-10-10")).not.toContain("notes/lantern-c.md");
    });
    test("a deadline filter excludes documents without a deadline", async () => {
      expect(await search(...query, "--deadline-to", "2099-12-31")).not.toContain("notes/lantern-timed.md");
    });
    test("--sort deadline orders earliest first", async () => {
      const paths = await search(...query, "--deadline-from", "2026-10-09", "--sort", "deadline");
      expect(paths).toEqual(["notes/lantern-a.md", "notes/lantern-b.md", "notes/lantern-c.md", "notes/lantern-far.md"]);
    });
  });
}

describe("sorting a query's results", () => {
  test("--sort deadline puts undated documents last", async () => {
    const paths = await search("lantern", "--mode", "fts", "--sort", "deadline");
    expect(paths.slice(0, 4)).toEqual(["notes/lantern-past.md", "notes/lantern-a.md", "notes/lantern-b.md", "notes/lantern-c.md"]);
    expect(paths.at(-1)).toBe("notes/lantern-timed.md");
  });

  test("--sort updated orders newest first", async () => {
    const paths = await search("lantern", "--mode", "fts", "--updated-since", "2026-08-09", "--sort", "updated");
    expect(paths).toEqual(["notes/lantern-c.md", "notes/lantern-timed.md", "notes/lantern-b.md", "notes/lantern-a.md"]);
  });

  test("--upcoming keeps future deadlines only, earliest first", async () => {
    const paths = await search("lantern", "--mode", "fts", "--upcoming");
    expect(paths).toContain("notes/lantern-far.md");
    expect(paths).not.toContain("notes/lantern-past.md");
    expect(paths.at(-1)).toBe("notes/lantern-far.md");
  });
});

describe("brain_search", () => {
  let client: Client;

  beforeAll(async () => {
    client = new Client({ name: "search-dates-test", version: "1.0.0" });
    await client.connect(new StdioClientTransport({ command: "bun", args: [BRAIN_BIN, "mcp"], env: keylessEnv(root) }));
  });

  afterAll(async () => {
    await client?.close();
  });

  async function call(args: Record<string, unknown>) {
    return client.callTool({ name: "brain_search", arguments: { query: "lantern", mode: "fts", limit: 50, ...args } });
  }
  const paths = (res: Awaited<ReturnType<typeof call>>) =>
    ((res.structuredContent as { results: { path: string }[] }).results).map((r) => r.path);

  test("applies the date filters and the deadline sort", async () => {
    const res = await call({ updated_since: "2026-08-10", deadline_to: "2026-10-10", sort: "deadline" });
    expect(res.isError).toBeFalsy();
    expect(paths(res)).toEqual(["notes/lantern-b.md"]);
  });

  test("upcoming keeps future deadlines only", async () => {
    const res = await call({ upcoming: true });
    expect(paths(res)).toContain("notes/lantern-far.md");
    expect(paths(res)).not.toContain("notes/lantern-past.md");
  });

  test("a malformed date is a tool error", async () => {
    const res = await call({ deadline_from: "next tuesday" });
    expect(res.isError).toBe(true);
  });

  test("an impossible calendar date is a tool error", async () => {
    const res = await call({ updated_since: "2026-02-30" });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toContain("updated_since");
  });
});
