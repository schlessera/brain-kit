/**
 * Date filters and date sorts on `brain search` and `brain_search` (#410).
 *
 * A temp copy of the fixture corpus gains "lantern" docs whose `updated` and
 * `deadline` sit one day either side of a boundary, so each inclusive bound
 * is tested on its own document, plus offset and malformed dates. "beacon"
 * docs carry the sort tests: their text-match order is the reverse of their
 * date order, so a sort that did not run would leave them in score order.
 * The copy keeps the pinned corpus counts elsewhere untouched.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";

import { BRAIN_BIN, cleanup, keylessEnv, makeTempBrain, runCli } from "./cli-harness";

interface Doc { updated: string; deadline?: string; body?: string }

// updated: 08-09 / 08-10 / 08-11 around 2026-08-10; deadline: 10-09 / 10-10 /
// 10-11 around 2026-10-10.
const DOCS: Record<string, Doc> = {
  "notes/lantern-a.md": { updated: "2026-08-09", deadline: "2026-10-09" },
  "notes/lantern-b.md": { updated: "2026-08-10", deadline: "2026-10-10" },
  "notes/lantern-c.md": { updated: "2026-08-11", deadline: "2026-10-11" },
  // A quoted timestamp stays a string with its time on it.
  "notes/lantern-timed.md": { updated: '"2026-08-10T09:30:00Z"' },
  // Offsets: 00:30 at +02:00 is still 08-09 in UTC; 23:30 at -02:00 is
  // already 08-10.
  "notes/lantern-east.md": { updated: '"2026-08-10T00:30:00+02:00"' },
  "notes/lantern-west.md": { updated: '"2026-08-09T23:30:00-02:00"' },
  // Malformed dates survive indexing as strings. SQLite alone would read
  // 2026-02-30 as March 2 and "now" as the current time.
  "notes/lantern-garbled.md": { updated: '"not-a-date"', deadline: '"someday"' },
  "notes/lantern-rollover.md": { updated: '"2026-02-30"', deadline: '"2026-02-30"' },
  "notes/lantern-now.md": { updated: '"now"', deadline: '"now"' },
  "notes/lantern-midnight.md": { updated: '"2026-08-10T24:00:00"', deadline: '"2026-08-10T"' },
  // Two instants within one second: flare-early is the stronger text match,
  // flare-late the newer update.
  "notes/flare-early.md": { updated: '"2026-08-10T09:30:00.100Z"', body: "flare flare flare flare" },
  "notes/flare-late.md": { updated: '"2026-08-10T09:30:00.900Z"', body: "flare" },
  // Two deadlines within one second on 2026-12-05: tick-b is due first, tick-a
  // was updated later (the filter-only tie-break).
  "notes/tick-a.md": { updated: "2026-08-02", deadline: '"2026-12-05T09:00:00.900Z"' },
  "notes/tick-b.md": { updated: "2026-08-01", deadline: '"2026-12-05T09:00:00.100Z"' },
  "notes/lantern-far.md": { updated: "2026-08-01", deadline: "2099-01-01" },
  "notes/lantern-past.md": { updated: "2026-08-01", deadline: "2000-01-01" },
  // Text-match strength falls from beacon-u to beacon-3, while the deadline
  // gets earlier and the update newer. beacon-u has no deadline and the
  // oldest update.
  "notes/beacon-u.md": { updated: "2026-05-01", body: "beacon beacon beacon beacon beacon beacon" },
  "notes/beacon-1.md": { updated: "2026-05-02", deadline: "2026-12-03", body: "beacon beacon beacon beacon" },
  "notes/beacon-2.md": { updated: "2026-05-03", deadline: "2026-12-02", body: "beacon beacon" },
  "notes/beacon-3.md": { updated: "2026-05-04", deadline: "2026-12-01", body: "beacon" },
};

let root: string;

beforeAll(async () => {
  root = makeTempBrain();
  mkdirSync(join(root, "notes"), { recursive: true });
  for (const [path, { updated, deadline, body }] of Object.entries(DOCS)) {
    // A beacon note's title leaves out "beacon": its match strength is its body's alone.
    const title = path.includes("beacon") ? `Signal ${path.replace("beacon", "signal")}` : `Lantern ${path}`;
    const lines = ["---", "type: note", `title: "${title}"`, "created: 2026-01-01", `updated: ${updated}`, "tags: [t]"];
    if (deadline) lines.push(`deadline: ${deadline}`);
    lines.push("---", "", body ?? "Check the lantern wick.", "Some shared filler text for every note.", "");
    writeFileSync(join(root, path), lines.join("\n"));
  }
  const idx = await runCli(root, ["index", "--json"]);
  expect(idx.code).toBe(0);
});

afterAll(() => cleanup(root));

async function search(...args: string[]): Promise<string[]> {
  const limit = args.includes("--limit") ? [] : ["--limit", "50"];
  const { stdout, stderr, code } = await runCli(root, ["search", ...args, ...limit, "--json"]);
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
      const paths = await search(...query, "--deadline-from", "2026-10-09", "--deadline-to", "2026-11-30", "--sort", "deadline");
      expect(paths).toEqual(["notes/lantern-a.md", "notes/lantern-b.md", "notes/lantern-c.md"]);
    });
  });
}

describe("stored dates are compared as UTC days", () => {
  test("an offset timestamp late on the previous UTC day is excluded by --updated-since", async () => {
    expect(await search("lantern", "--mode", "fts", "--updated-since", "2026-08-10")).not.toContain("notes/lantern-east.md");
  });
  test("an offset timestamp late on the previous UTC day is included by --updated-before that day", async () => {
    expect(await search("lantern", "--mode", "fts", "--updated-before", "2026-08-09")).toContain("notes/lantern-east.md");
  });
  test("a negative offset that crosses into the next UTC day is included by --updated-since", async () => {
    expect(await search("lantern", "--mode", "fts", "--updated-since", "2026-08-10")).toContain("notes/lantern-west.md");
  });
  test("a negative offset that crosses into the next UTC day is excluded by --updated-before the day before", async () => {
    expect(await search("lantern", "--mode", "fts", "--updated-before", "2026-08-09")).not.toContain("notes/lantern-west.md");
  });
  test("a malformed updated matches no bound", async () => {
    expect(await search("lantern", "--mode", "fts", "--updated-since", "2000-01-01")).not.toContain("notes/lantern-garbled.md");
    expect(await search("lantern", "--mode", "fts", "--updated-before", "2100-01-01")).not.toContain("notes/lantern-garbled.md");
  });
  test("a malformed deadline matches no bound", async () => {
    expect(await search("lantern", "--mode", "fts", "--deadline-from", "2000-01-01")).not.toContain("notes/lantern-garbled.md");
    expect(await search("lantern", "--mode", "fts", "--deadline-to", "2100-01-01")).not.toContain("notes/lantern-garbled.md");
  });
  for (const [value, path] of [
    ["2026-02-30", "notes/lantern-rollover.md"],
    ["now", "notes/lantern-now.md"],
    ["2026-08-10T24:00:00 / 2026-08-10T", "notes/lantern-midnight.md"],
  ] as const) {
    test(`a stored "${value}" matches no updated bound`, async () => {
      expect(await search("lantern", "--mode", "fts", "--updated-since", "2000-01-01")).not.toContain(path);
      expect(await search("--updated-before", "2100-01-01")).not.toContain(path);
    });
    test(`a stored "${value}" matches no deadline bound`, async () => {
      expect(await search("lantern", "--mode", "fts", "--deadline-from", "2026-03-02", "--deadline-to", "2026-03-02")).not.toContain(path);
      expect(await search("--deadline-from", "2000-01-01", "--deadline-to", "2100-01-01")).not.toContain(path);
    });
    test(`a stored "${value}" deadline sorts with the undated, after every valid deadline`, async () => {
      const paths = await search("lantern", "--mode", "fts", "--rerank", "none", "--sort", "deadline");
      expect(paths.indexOf(path)).toBeGreaterThan(paths.indexOf("notes/lantern-far.md"));
    });
  }

  test("--sort updated orders two updates within one second", async () => {
    const paths = await search("flare", "--mode", "fts", "--rerank", "none", "--sort", "updated");
    expect(paths).toEqual(["notes/flare-late.md", "notes/flare-early.md"]);
  });

  test("filter-only --sort deadline orders two deadlines within one second", async () => {
    const paths = await search("--deadline-from", "2026-12-05", "--deadline-to", "2026-12-05", "--sort", "deadline");
    expect(paths).toEqual(["notes/tick-b.md", "notes/tick-a.md"]);
  });

  test("malformed updated values sort last under --sort updated", async () => {
    const paths = await search("lantern", "--mode", "fts", "--rerank", "none", "--sort", "updated");
    const malformed = ["notes/lantern-garbled.md", "notes/lantern-midnight.md", "notes/lantern-now.md", "notes/lantern-rollover.md"];
    expect(paths.slice(-4).sort()).toEqual(malformed);
  });
});

describe("sorting a query's results", () => {
  // Reranking off, so the base order is the text-match score alone.
  const beacon = (...args: string[]) => search("beacon", "--mode", "fts", "--rerank", "none", ...args);

  test("the premise: score order runs opposite to date order", async () => {
    expect(await beacon()).toEqual(["notes/beacon-u.md", "notes/beacon-1.md", "notes/beacon-2.md", "notes/beacon-3.md"]);
  });

  test("--sort deadline orders dated results earliest first", async () => {
    expect((await beacon("--sort", "deadline")).slice(0, 3)).toEqual(["notes/beacon-3.md", "notes/beacon-2.md", "notes/beacon-1.md"]);
  });

  test("--sort deadline puts an undated result last", async () => {
    expect((await beacon("--sort", "deadline")).at(-1)).toBe("notes/beacon-u.md");
  });

  test("--sort updated orders newest first", async () => {
    expect(await beacon("--sort", "updated")).toEqual(["notes/beacon-3.md", "notes/beacon-2.md", "notes/beacon-1.md", "notes/beacon-u.md"]);
  });

  test("a date sort chooses the limit by date, not from the top of the score order", async () => {
    // beacon-3 has the weakest match and the earliest deadline and newest
    // update: a pool of only the best-scored candidates would miss it.
    expect(await beacon("--sort", "deadline", "--limit", "1")).toEqual(["notes/beacon-3.md"]);
    expect(await beacon("--sort", "updated", "--limit", "1")).toEqual(["notes/beacon-3.md"]);
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

  test("applies the date filters", async () => {
    const res = await call({ updated_since: "2026-08-10", deadline_to: "2026-10-10" });
    expect(res.isError).toBeFalsy();
    expect(paths(res)).toEqual(["notes/lantern-b.md"]);
  });

  test("applies the deadline sort against score order", async () => {
    const res = await call({ query: "beacon", rerank: "none", sort: "deadline" });
    expect(paths(res)).toEqual(["notes/beacon-3.md", "notes/beacon-2.md", "notes/beacon-1.md", "notes/beacon-u.md"]);
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
