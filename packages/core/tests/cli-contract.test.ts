/**
 * CLI contract tests. Spawns the real bin against a temp copy of the fixture
 * corpus (keyless) and asserts the stable `--json` envelope shapes and exit
 * codes from docs/integration-contract.md.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { cleanup, keylessEnv, makeTempBrain, runCli } from "./cli-harness";
import { withoutSigning } from "./git-fixture";
import { packageVersion } from "../src/package-version";
import { createFakeGog, type FakeGog } from "../../common/tests/support/fake-gog.ts";
import { watchdogMs } from "../../../scripts/test-deadlines";

let root: string;

beforeAll(async () => {
  root = makeTempBrain();
  const idx = await runCli(root, ["index", "--json"]);
  expect(idx.code).toBe(0);
});

afterAll(() => cleanup(root));

describe("search", () => {
  test("FTS mode returns the { results, warnings } envelope", async () => {
    const { stdout, code } = await runCli(root, ["search", "navigation", "--mode", "fts", "--json"]);
    expect(code).toBe(0);
    const out = JSON.parse(stdout);
    expect(Array.isArray(out.results)).toBe(true);
    expect(Array.isArray(out.warnings)).toBe(true);
    expect(out.results.length).toBeGreaterThan(0);
    const first = out.results[0];
    for (const field of ["path", "title", "type", "snippet", "score"]) {
      expect(first).toHaveProperty(field);
    }
  });

  test("a result carries the document's deadline and freshness fields", async () => {
    const { stdout, code } = await runCli(root, ["search", "raft", "--mode", "fts", "--json"]);
    expect(code).toBe(0);
    const out = JSON.parse(stdout);
    const status = out.results.find((r: { path: string }) => r.path === "projects/active/raft/status.md");
    expect(status).toBeDefined();
    expect(status.deadline).toBe("2026-07-29");
    expect(status.updated).toBe("2026-06-30");
  });

  test("--chunks adds each result's matching chunks; without it the results carry none", async () => {
    const withChunks = JSON.parse((await runCli(root, ["search", "pine deck", "--mode", "fts", "--chunks", "--json"])).stdout);
    const first = withChunks.results[0];
    expect(first.chunks.length).toBeGreaterThan(0);
    const source = readFileSync(join(root, first.path), "utf-8");
    for (const chunk of first.chunks) {
      expect(Object.keys(chunk).sort()).toEqual(["chunk_index", "content", "heading", "path", "score"]);
      expect(chunk.path).toBe(first.path);
      // The chunk's heading is one of the file's own section headings.
      if (chunk.heading !== "(intro)") expect(source).toMatch(new RegExp(`^## ${chunk.heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"));
    }
    const without = JSON.parse((await runCli(root, ["search", "pine deck", "--mode", "fts", "--json"])).stdout);
    expect(without.results.map((r: { path: string }) => r.path)).toEqual(withChunks.results.map((r: { path: string }) => r.path));
    for (const r of without.results) expect(r).not.toHaveProperty("chunks");
  });

  test("--chunks on a filter-only search gives each result an empty chunks list", async () => {
    const out = JSON.parse((await runCli(root, ["search", "--type", "note", "--chunks", "--json"])).stdout);
    expect(out.results.length).toBeGreaterThan(0);
    for (const r of out.results) expect(r.chunks).toEqual([]);
  });

  test("hybrid mode without a key degrades to FTS with a warning", async () => {
    const { stdout, code } = await runCli(root, ["search", "star guide", "--mode", "hybrid", "--json"]);
    expect(code).toBe(0);
    const out = JSON.parse(stdout);
    expect(Array.isArray(out.results)).toBe(true);
    expect(out.warnings.some((w: string) => /vector search/i.test(w))).toBe(true);
  });

  test("no query and no filter is a usage error (exit 1)", async () => {
    const { code } = await runCli(root, ["search", "--json"]);
    expect(code).toBe(1);
  });

  test("--deadline-from with --sort deadline puts the next deadline first", async () => {
    const { stdout, code } = await runCli(root, ["search", "status", "--deadline-from", "2026-07-12", "--sort", "deadline", "--json"]);
    expect(code).toBe(0);
    const out = JSON.parse(stdout);
    expect(Array.isArray(out.warnings)).toBe(true);
    expect(out.results[0]?.path).toBe("projects/active/raft/status.md");
  });

  test("an invalid date is a usage error (exit 1) naming the flag, not an empty result", async () => {
    for (const args of [["--updated-since", "2026-02-30"], ["--deadline-to", "tomorrow"], ["--deadline-from"]]) {
      const { stdout, stderr, code } = await runCli(root, ["search", "status", ...args, "--json"]);
      expect({ args, code }).toEqual({ args, code: 1 });
      expect(stderr).toContain(args[0]!);
      expect(stdout).not.toContain("results");
    }
  });

  test("an unknown --sort is a usage error (exit 1)", async () => {
    const { stderr, code } = await runCli(root, ["search", "status", "--sort", "newest", "--json"]);
    expect(code).toBe(1);
    expect(stderr).toContain("--sort");
  });
});

// #1352: flag values go through one typed accessor (cli/flags.ts). A malformed
// one is a usage error (exit 1, message on stderr, nothing on stdout) in both
// output modes, and is refused before any query runs.
describe("malformed flag values", () => {
  const whole = (flag: string, got: string) => `--${flag} must be a whole number of 1 or more, got ${got}`;
  const invalid: Array<[string, string[], string]> = [
    ["search --limit abc", ["search", "raft", "--limit", "abc"], whole("limit", '"abc"')],
    ["search --limit 0", ["search", "raft", "--limit", "0"], whole("limit", '"0"')],
    ["search --limit -5", ["search", "raft", "--limit", "-5"], whole("limit", '"-5"')],
    ["search --limit 1.5", ["search", "raft", "--limit", "1.5"], whole("limit", '"1.5"')],
    ["search --limit 10abc", ["search", "raft", "--limit", "10abc"], whole("limit", '"10abc"')],
    ["search --mode bogus", ["search", "raft", "--mode", "bogus"], '--mode must be one of fts, vector, hybrid, got "bogus"'],
    ["a bare search --type", ["search", "raft", "--type"], "--type needs a value"],
    ["search --tag before another flag", ["search", "raft", "--tag", "--mode", "fts"], "--tag needs a value"],
    ["list --tag before another flag", ["list", "--tag", "--status", "active"], "--tag needs a value"],
    ["context --max-tokens abc", ["context", "raft", "--max-tokens", "abc"], whole("max-tokens", '"abc"')],
    ["briefing --limit abc", ["briefing", "--limit", "abc"], whole("limit", '"abc"')],
    // These two were usage errors before #1352 and keep their messages.
    ["search --sort bogus", ["search", "raft", "--sort", "bogus"], '--sort must be one of score, updated, deadline, got "bogus"'],
    [
      "a malformed search --updated-since",
      ["search", "raft", "--updated-since", "yesterday"],
      '--updated-since needs a date written YYYY-MM-DD, got "yesterday"',
    ],
  ];
  for (const mode of ["--json", "--human"]) {
    for (const [what, args, message] of invalid) {
      test(`${what} is a usage error in ${mode} mode, with no output`, async () => {
        const { stdout, stderr, code } = await runCli(root, [...args, mode]);
        expect({ code, stdout, stderr: stderr.trim() }).toEqual({ code: 1, stdout: "", stderr: message });
      });
    }
  }

  // Without an index, a query fails with "Database not found". A malformed
  // flag reports itself instead, so it is refused before any query is tried.
  test("a malformed flag is refused before the database is opened", async () => {
    const unindexed = makeTempBrain();
    try {
      const valid = await runCli(unindexed, ["search", "raft", "--limit", "5", "--json"]);
      expect({ code: valid.code, stderr: valid.stderr.trim() }).toEqual({
        code: 1,
        stderr: "Database not found. Run `brain index` first.",
      });
      for (const [what, args, message] of invalid) {
        if (args[0] === "list") continue;
        const bad = await runCli(unindexed, [...args, "--json"]);
        expect({ what, code: bad.code, stdout: bad.stdout, stderr: bad.stderr.trim() }).toEqual({
          what,
          code: 1,
          stdout: "",
          stderr: message,
        });
      }
      const add = await runCli(unindexed, ["add", "Penelope weaves by day", "--tags", "--json"]);
      expect({ code: add.code, stdout: add.stdout, stderr: add.stderr.trim() }).toEqual({
        code: 1,
        stdout: "",
        stderr: "--tags needs a value",
      });
      expect(existsSync(join(unindexed, "brain.db"))).toBe(false);
    } finally {
      cleanup(unindexed);
    }
  });

  const paths = async (args: string[]) => {
    const { stdout, stderr, code } = await runCli(root, ["search", "raft", "--mode", "fts", ...args, "--json"]);
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
    return (JSON.parse(stdout) as { results: Array<{ path: string }> }).results.map((r) => r.path);
  };

  test("a repeated --limit keeps its last value", async () => {
    const seven = await paths(["--limit", "7"]);
    expect(seven).toHaveLength(7);
    expect(await paths(["--limit", "5", "--limit", "7"])).toEqual(seven);
  });

  test("valid values keep their results: --limit 50 and --mode fts", async () => {
    const all = await paths(["--limit", "50"]);
    // The corpus has fewer than 20 raft matches, so 50 and the default agree.
    expect(all.length).toBeGreaterThan(7);
    expect(all.length).toBeLessThan(20);
    expect(await paths([])).toEqual(all);
  });
});

describe("read", () => {
  test("prints the whole file with no flag", async () => {
    const { stdout, code } = await runCli(root, ["read", "me/identity.md"]);
    expect(code).toBe(0);
    expect(stdout).toBe(readFileSync(join(root, "me/identity.md"), "utf-8") + "\n");
  });

  test("--section prints that section and no other", async () => {
    const { stdout, code } = await runCli(root, ["read", "me/identity.md", "--section", "How to Work With Odysseus"]);
    expect(code).toBe(0);
    expect(stdout.startsWith("## How to Work With Odysseus\n")).toBe(true);
    expect(stdout).toContain("Name the cost and the next action");
    expect(stdout).not.toContain("## Current Identity");
  });

  test("--max-tokens over the file's size prints the outline, not the body", async () => {
    const { stdout, code } = await runCli(root, ["read", "me/identity.md", "--max-tokens", "50"]);
    expect(code).toBe(0);
    expect(stdout).toContain("- ## Current Identity (~173 tokens)\n- ## How to Work With Odysseus (~51 tokens)\n");
    expect(stdout).toContain('--section "<heading>"');
    expect(stdout).not.toContain("Name the cost");
  });

  test("an unknown --section is a usage error naming the available headings", async () => {
    const { stderr, code } = await runCli(root, ["read", "me/identity.md", "--section", "No Such Heading"]);
    expect(code).toBe(1);
    expect(stderr).toContain('available headings: "Current Identity", "How to Work With Odysseus"');
  });

  test("--max-tokens must be a positive safe integer", async () => {
    for (const bad of ["0", "-3", "1.5", "many", "9007199254740992"]) {
      const { code } = await runCli(root, ["read", "me/identity.md", "--max-tokens", bad]);
      expect({ bad, code }).toEqual({ bad, code: 1 });
    }
    const { code } = await runCli(root, ["read", "me/identity.md", "--max-tokens", "9007199254740991"]);
    expect(code).toBe(0);
  });
});

describe("audit", () => {
  test("returns the { issues, errors, warnings, infos, mustFix, informational } envelope", async () => {
    const { stdout, code } = await runCli(root, ["audit", "--json"]);
    expect(code).toBe(0);
    const out = JSON.parse(stdout);
    expect(Array.isArray(out.issues)).toBe(true);
    // The fixture corpus is dated, so it always has stale documents: an empty
    // list would pass every per-issue check below without running one.
    expect(out.issues.length).toBeGreaterThan(0);
    for (const issue of out.issues) {
      expect(typeof issue.path).toBe("string");
      // A path is a real document or a parenthesised sentinel, never both.
      if (issue.path.startsWith("(")) {
        expect(["(corpus)", "(module)"]).toContain(issue.path);
      } else {
        expect(existsSync(join(root, issue.path))).toBe(true);
      }
      expect(["error", "warning", "info"]).toContain(issue.severity);
      expect(typeof issue.category).toBe("string");
      expect(typeof issue.message).toBe("string");
      if ("suggestion" in issue) expect(typeof issue.suggestion).toBe("string");
      // Assets are excluded — no issue should point at a binary asset.
      expect(issue.path).not.toMatch(/\.(png|pdf|jpe?g)$/i);
    }
    expect(out.issues.some((i: { suggestion?: string }) => typeof i.suggestion === "string")).toBe(true);
    // The fixture's tags are mostly singletons, so the corpus-wide check fires.
    expect(out.issues.find((i: { category: string }) => i.category === "tag-noise")?.path).toBe("(corpus)");

    const count = (severity: string) =>
      out.issues.filter((i: { severity: string }) => i.severity === severity).length;
    expect(out.errors).toBe(count("error"));
    expect(out.warnings).toBe(count("warning"));
    expect(out.infos).toBe(count("info"));
    // #394: must-fix and informational totals, over the same findings.
    expect(out.mustFix).toBe(out.errors + out.warnings);
    expect(out.informational).toBe(out.infos);
    expect(out.warnings).toBeGreaterThan(0);
    expect(out.infos).toBeGreaterThan(0);
  });

  test("groups the fixture's markers per document, both info, with count and examples (#394)", async () => {
    const { stdout } = await runCli(root, ["audit", "--json"]);
    const markers = (JSON.parse(stdout).issues as Array<{ category: string }>).filter(
      (i) => i.category === "todo" || i.category === "verify"
    );
    expect(markers).toEqual([
      // Documents in path order.
      expect.objectContaining({
        category: "verify",
        path: "notes/quick-note-eagle.md",
        severity: "info",
        count: 1,
        examples: ["[VERIFY: confirm who saw the eagle and whether the report is first-hand]"],
      }),
      expect.objectContaining({
        category: "todo",
        path: "notes/quick-note-water.md",
        severity: "info",
        count: 1,
        examples: ["[TODO: measure the cask opening before cutting the blank]"],
      }),
    ]);
  });

  test("reports the fixture's broken links as warnings, the same ones brain validate reports (#394)", async () => {
    const audited = JSON.parse((await runCli(root, ["audit", "--json"])).stdout).issues as Array<{
      category: string;
      path: string;
      severity: string;
      message: string;
    }>;
    const broken = audited.filter((i) => i.category === "broken-link").map((i) => [i.path, i.severity, i.message]);
    expect(broken).toEqual([
      ["context/current-focus.md", "warning", "Unresolved wiki-link: [[does-not-exist]]"],
      ["notes/quick-note-eagle.md", "warning", "Unresolved wiki-link: [[does-not-exist]]"],
    ]);
    const validated = JSON.parse((await runCli(root, ["validate", "--json"])).stdout).issues as Array<{
      file: string;
      level: string;
      message: string;
    }>;
    expect(validated.filter((i) => i.message.includes("wiki-link")).map((i) => [i.file, i.level, i.message])).toEqual(broken);
  });
  test("reports the fixture's one drifted fact, on long-bio.md (#392)", async () => {
    const { stdout } = await runCli(root, ["audit", "--json"]);
    const drift = (JSON.parse(stdout).issues as Array<{ category: string; path: string; message: string }>).filter(
      (i) => i.category === "fact-drift"
    );
    expect(drift).toEqual([
      expect.objectContaining({ path: "me/basics/long-bio.md", message: "troy_fell: found 2015, canonical 2016" }),
    ]);
  });

  test("the fixture corpus repeats no paragraph (#431)", async () => {
    const { stdout } = await runCli(root, ["audit", "--json"]);
    const issues = JSON.parse(stdout).issues as Array<{ category: string }>;
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.filter((i) => i.category === "repeated-text")).toEqual([]);
  });
});

describe("index", () => {
  test("emits an IndexStats object", async () => {
    const { stdout, code } = await runCli(root, ["index", "--json"]);
    expect(code).toBe(0);
    const stats = JSON.parse(stdout);
    for (const field of [
      "total", "added", "updated", "deleted", "unchanged", "chunks", "embeddings", "assets",
      "graphMs", "graphNodes",
    ]) {
      expect(typeof stats[field]).toBe("number");
    }
    expect(stats.total).toBeGreaterThan(0);
  });
});

describe("list", () => {
  test("returns a plain array of documents", async () => {
    const { stdout, code } = await runCli(root, ["list", "--type", "health", "--json"]);
    expect(code).toBe(0);
    const results = JSON.parse(stdout);
    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBeGreaterThan(0);
    for (const doc of results) {
      expect(doc.type).toBe("health");
      for (const field of ["path", "title", "relevance", "status", "updated", "snippet"]) {
        expect(typeof doc[field]).toBe("string");
      }
      // Nullable: no summary in the frontmatter, no tags on the document.
      for (const field of ["summary", "tags"]) {
        expect(doc).toHaveProperty(field);
        expect(doc[field] === null || typeof doc[field] === "string").toBe(true);
      }
      // A filter has no query to rank against.
      expect(doc.score).toBe(0);
    }
    // Every health fixture is tagged, so this is the comma-joined form.
    expect(results[0].tags).toContain(", ");
  });

  test("a document's deadline is listed, and null where it sets none", async () => {
    const { stdout, code } = await runCli(root, ["list", "--type", "project", "--limit", "100", "--json"]);
    expect(code).toBe(0);
    const results = JSON.parse(stdout) as Array<{ path: string; deadline: string | null }>;
    const status = results.find((d) => d.path === "projects/active/raft/status.md");
    expect(status?.deadline).toBe("2026-07-29");
    expect(results.some((d) => d.deadline === null)).toBe(true);
  });
});

// #3643: --path-prefix, --overview and --cursor print one bounded page of the
// shared paged listing; without them the bare array above is unchanged.
describe("list paged discovery", () => {
  type Page = { documents: Array<Record<string, unknown>>; next_cursor: string | null; total: number; warnings: string[] };
  const paged = async (args: string[]) => {
    const { stdout, stderr, code } = await runCli(root, ["list", ...args, "--json"]);
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
    return JSON.parse(stdout) as Page;
  };

  test("prints { documents, next_cursor, total, warnings } and pages to the end", async () => {
    const first = await paged(["--path-prefix", "projects/active/raft", "--overview", "--limit", "2"]);
    expect(Object.keys(first)).toEqual(["documents", "next_cursor", "total", "warnings"]);
    expect(first.documents).toHaveLength(2);
    expect(first.next_cursor).toBeString();
    const rest = await paged(["--path-prefix", "projects/active/raft", "--overview", "--limit", "100", "--cursor", first.next_cursor!]);
    expect(rest.next_cursor).toBeNull();
    const paths = [...first.documents, ...rest.documents].map((d) => d.path);
    expect(paths.length).toBe(first.total);
    expect(new Set(paths).size).toBe(first.total);
    expect(paths.every((p) => (p as string).startsWith("projects/active/raft/"))).toBe(true);
    const status = [...first.documents, ...rest.documents].find((d) => d.path === "projects/active/raft/status.md");
    expect(status).toMatchObject({ updated: "2026-06-30", deadline: "2026-07-29", summary: "Latest planning check and next action for leaving Ogygia" });
    expect(typeof status!.indexed_body_bytes).toBe("number");
  });

  test("a bad prefix or cursor is a usage error with no output", async () => {
    for (const [args, message] of [
      [["--path-prefix", "../outside"], "--path-prefix: path_prefix must be a root-relative folder"],
      [["--cursor", "nope"], "--cursor: cursor is not a cursor this listing issued"],
    ] as const) {
      const { stdout, stderr, code } = await runCli(root, ["list", ...args, "--json"]);
      expect({ code, stdout }).toEqual({ code: 1, stdout: "" });
      expect(stderr).toContain(message);
    }
  });

  test("--overview does not swallow the next argument", async () => {
    const page = await paged(["--overview", "--type", "health", "--limit", "1"]);
    expect(page.documents[0]!.type).toBe("health");
  });
});

// #1351: --limit is a whole number from 1 to 100, default 20. Anything else is
// a usage error that runs no query, in both output modes.
describe("list --limit", () => {
  const listed = async (args: string[]) => {
    const { stdout, stderr, code } = await runCli(root, ["list", ...args, "--json"]);
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
    return JSON.parse(stdout) as unknown[];
  };

  test("omitted, it lists 20; 1 and 100 are accepted", async () => {
    const all = await listed(["--limit", "100"]);
    // The corpus holds more than the default, so 20 is the limit, not the corpus.
    expect(all.length).toBeGreaterThan(20);
    expect(all.length).toBeLessThanOrEqual(100);
    expect(await listed([])).toHaveLength(20);
    expect(await listed(["--limit", "1"])).toHaveLength(1);
  });

  const MESSAGE = "--limit must be a whole number from 1 to 100";
  const invalid: Array<[string, string[]]> = [
    ["a non-number", ["--limit", "abc"]],
    ["a number with trailing text", ["--limit", "10abc"]],
    ["a fraction", ["--limit", "1.5"]],
    ["zero", ["--limit", "0"]],
    ["a negative", ["--limit", "-1"]],
    ["101", ["--limit", "101"]],
    ["a missing value", ["--limit"]],
    ["a value-less flag before another flag", ["--limit", "--type", "health"]],
  ];
  for (const mode of ["--json", "--human"]) {
    for (const [what, args] of invalid) {
      test(`${what} is a usage error in ${mode} mode, with no output`, async () => {
        const { stdout, stderr, code } = await runCli(root, ["list", ...args, mode]);
        expect({ code, stdout, stderr: stderr.trim() }).toEqual({ code: 1, stdout: "", stderr: MESSAGE });
      });
    }
  }

  // Without an index, a query fails with "Database not found". An invalid
  // limit reports itself instead, so it is refused before any query is tried.
  test("an invalid limit is refused before the database is opened", async () => {
    const unindexed = makeTempBrain();
    try {
      const valid = await runCli(unindexed, ["list", "--limit", "5", "--json"]);
      expect({ code: valid.code, stderr: valid.stderr.trim() }).toEqual({
        code: 1,
        stderr: "Database not found. Run `brain index` first.",
      });
      for (const value of ["10abc", "101"]) {
        const bad = await runCli(unindexed, ["list", "--limit", value, "--json"]);
        expect({ code: bad.code, stdout: bad.stdout, stderr: bad.stderr.trim() }).toEqual({ code: 1, stdout: "", stderr: MESSAGE });
      }
    } finally {
      cleanup(unindexed);
    }
  });
});

describe("add", () => {
  test("reports the capture it wrote", async () => {
    const brain = makeTempBrain();
    try {
      const { stdout, code } = await runCli(brain, [
        "add", "--type", "note", "--title", "Contract capture", "--json", "--", "Moonrise over the ridge.",
      ]);
      expect(code).toBe(0);
      const out = JSON.parse(stdout);
      expect(out.action).toBe("created");
      expect(out.path).toBe("notes/contract-capture.md");
      expect(out.title).toBe("Contract capture");
      expect(out.type).toBe("note");
      expect(out.indexed).toBe(true);
      // Present only when indexing failed after the file was written.
      expect(out).not.toHaveProperty("indexError");
    } finally {
      cleanup(brain);
    }
  });

  test("reports a capture whose reindex failed, with the reason", async () => {
    const brain = makeTempBrain();
    try {
      expect((await runCli(brain, ["index", "--json"])).code).toBe(0);
      // Refuse every new document row, so the file is written and the
      // reindex after it throws.
      const db = new Database(join(brain, ".brain-index", "brain.db"));
      db.run(
        "CREATE TRIGGER refuse_index BEFORE INSERT ON documents BEGIN SELECT RAISE(ABORT, 'contract test: index refused'); END"
      );
      db.close();

      const { stdout, code } = await runCli(brain, [
        "add", "--type", "note", "--title", "Refused capture", "--json", "--", "Clouds all night.",
      ]);
      expect(code).toBe(0);
      const out = JSON.parse(stdout);
      expect(out.action).toBe("created");
      expect(out.path).toBe("notes/refused-capture.md");
      expect(readFileSync(join(brain, out.path), "utf-8")).toContain("Clouds all night.");
      expect(out.indexed).toBe(false);
      expect(out.indexError).toBe("contract test: index refused");
    } finally {
      cleanup(brain);
    }
  });
});

describe("sync", () => {
  // Bare `brain sync` runs the whole sync and hands the agent only what the
  // rules left — here a file nothing could classify. Human mode prints the
  // report, then the agent's text; machine mode one `{ run, agent }` result
  // (#290). A stub runner stands in so nothing real is launched.
  test("human mode: the report, then the agent's text; machine mode: one result", async () => {
    const brain = makeTempBrain({ empty: true });
    const remote = mkdtempSync(join(tmpdir(), "brain-contract-remote-"));
    // Signing is switched off per command (#3485): an environment-scoped
    // GIT_CONFIG_COUNT outranks the repository-local setting below, and both
    // the fixture's commit and the one `brain sync` makes would try to sign.
    const unsigned = withoutSigning(keylessEnv(brain));
    const git = (...args: string[]) => {
      const result = Bun.spawnSync(["git", "-C", brain, ...args], { env: unsigned });
      if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
    };
    try {
      writeFileSync(
        join(brain, "brain.config.ts"),
        `import { defineConfig } from "@schlessera/brain";
export default defineConfig({
  agentRunner: {
    id: "stub",
    capabilities: { streaming: false, skills: true },
    async run(prompt: string) { return "stub agent ran " + prompt; },
  },
});
`
      );
      writeFileSync(join(brain, ".gitignore"), "node_modules\nbrain.db\nbrain.db-*\n.agents/skills/\n.claude/skills/\n");
      Bun.spawnSync(["git", "init", "-q", "--bare", "-b", "main", remote]);
      git("init", "-q", "-b", "main");
      git("config", "user.name", "Odysseus");
      git("config", "user.email", "odysseus@example.test");
      git("config", "commit.gpgsign", "false");
      git("add", "-A");
      git("commit", "-qm", "fixture");
      git("remote", "add", "origin", remote);
      git("push", "-q", "origin", "main");
      writeFileSync(join(brain, "survey.xyz"), "eagle survey grid\n");

      // An output flag is not a verb: `--human` is the text…
      const human = await runCli(brain, ["sync", "--human"], unsigned);
      expect(human.code).toBe(0);
      expect(human.stdout).toStartWith("brain sync: complete\n");
      expect(human.stdout).toContain("  unknown: survey.xyz\n");
      expect(human.stdout).toEndWith("\nstub agent ran /sync\n");
      expect(() => JSON.parse(human.stdout)).toThrow();

      // …and `--json`, or a stdout that is not a terminal, the one result.
      for (const flags of [[], ["--json"]]) {
        const { stdout, code } = await runCli(brain, ["sync", ...flags], unsigned);
        expect(code).toBe(0);
        const body = JSON.parse(stdout);
        expect(body.run.status).toBe("complete");
        expect(body.run.report).toContain("  unknown: survey.xyz");
        // The stub reports no runtime: invoked, and nothing claimed for it.
        expect(body.agent).toEqual({
          invoked: true,
          runner: "stub",
          outcome: "success",
          runtime: null,
          text: "stub agent ran /sync",
        });
      }

      const unknown = await runCli(brain, ["sync", "--not-a-flag"], unsigned);
      expect(unknown.code).toBe(1);
      expect(unknown.stderr).toContain("Unknown flag: --not-a-flag");
    } finally {
      cleanup(brain);
      cleanup(remote);
    }
  });
});

describe("module list", () => {
  test("returns the { enabled, available } payload the cron emitter reads", async () => {
    const brain = makeTempBrain({ empty: true });
    try {
      mkdirSync(join(brain, "modules/stub"), { recursive: true });
      writeFileSync(
        join(brain, "modules/stub/module.ts"),
        `import { defineModule } from "@schlessera/brain";
import { z } from "zod";
export default defineModule({
  name: "stub",
  configSchema: z.object({}).strict(),
  setup: () => ({
    taxonomy: { types: { stubnote: { dir: "stubnotes" } } },
    commands: { stub: async () => ({ summary: "stub", async run() { return 0; } }) },
    tools: {
      second: async () => { throw new Error("list must not import tool definitions"); },
      first: async () => { throw new Error("list must not import tool definitions"); },
    },
    cron: [{ name: "stub-nightly", schedule: "0 3 * * *", command: "stub run" }],
  }),
});
`
      );
      writeFileSync(
        join(brain, "modules/stub/package.json"),
        JSON.stringify({ name: "stub", description: "A stub module" })
      );
      writeFileSync(
        join(brain, "package.json"),
        JSON.stringify({ dependencies: { "@schlessera/brain-module-example": "^1.0.0" } })
      );
      writeFileSync(
        join(brain, "brain.config.ts"),
        `import { defineConfig } from "@schlessera/brain";
export default defineConfig({ modules: { "./modules/stub": {}, "./modules/empty": {} } });
`
      );
      mkdirSync(join(brain, "modules/empty"), { recursive: true });
      writeFileSync(join(brain, "modules/empty/module.ts"), 'export default { name: "empty", setup: () => ({}) };');

      const { stdout, code } = await runCli(brain, ["module", "list", "--json"]);
      expect(code).toBe(0);
      const out = JSON.parse(stdout);
      expect(out.enabled).toHaveLength(2);
      const [mod, empty] = out.enabled;
      expect(mod.name).toBe("stub");
      expect(mod.key).toBe("./modules/stub");
      expect(mod.description).toBe("A stub module");
      expect(mod.types).toEqual(["stubnote"]);
      expect(mod.commands).toEqual(["stub"]);
      expect(mod.tools).toEqual(["stub_second", "stub_first"]);
      expect(empty.name).toBe("empty");
      expect(empty.tools).toEqual([]);
      expect(mod.cron).toEqual([{ name: "stub-nightly", schedule: "0 3 * * *", command: "stub run" }]);

      // Declared in package.json, not enabled, and not installed.
      expect(out.available).toEqual([
        { key: "@schlessera/brain-module-example", description: null, enabled: false },
      ]);
    } finally {
      cleanup(brain);
    }
  });
});

describe("init --check", () => {
  test("emits the preflight object", async () => {
    const { stdout, code } = await runCli(root, ["init", "--check", "--json"]);
    expect(code).toBe(0);
    const out = JSON.parse(stdout);
    expect(typeof out.bun.version).toBe("string");
    expect(out.bun.ok).toBe(true);
    expect(typeof out.git.repo).toBe("boolean");
    expect(typeof out.hooksPath.set).toBe("boolean");
    expect(out.hooksPath).toHaveProperty("value");
    expect(out.config).toMatchObject({ exists: true, valid: true, initialized: true });
    expect(typeof out.config.path).toBe("string");
    expect(out.contentDirs.present.length).toBeGreaterThan(0);
    expect(Array.isArray(out.contentDirs.missing)).toBe(true);
    // Keyless harness: both are reported, as absent.
    expect(out.keys).toEqual({ GEMINI_API_KEY: false, ANTHROPIC_API_KEY: false });
  });
});

describe("graph", () => {
  test("compute --json emits the rebuild summary", async () => {
    const { stdout, code } = await runCli(root, ["graph", "compute", "--json"]);
    expect(code).toBe(0);
    const out = JSON.parse(stdout);
    for (const field of ["nodes", "edges", "brokenLinks", "components", "communities", "reachable", "durationMs"]) {
      expect(typeof out[field]).toBe("number");
    }
    expect(out.nodes).toBeGreaterThan(0);
    expect(out).toHaveProperty("root");
    expect(typeof out.layoutSkipped).toBe("boolean");
  });

  test("stats --json emits counts, the algorithm settings and communities", async () => {
    const { stdout, code } = await runCli(root, ["graph", "stats", "--json"]);
    expect(code).toBe(0);
    const out = JSON.parse(stdout);
    expect(typeof out.computedAt).toBe("string");
    for (const field of ["nodes", "edges", "brokenLinks", "components", "reachable"]) {
      expect(typeof out[field]).toBe("number");
    }
    expect(out).toHaveProperty("root");
    expect(typeof out.layoutSkipped).toBe("boolean");
    expect(typeof out.algo).toBe("object");
    expect(out.algo).not.toBeNull();
    expect(out.communities.length).toBeGreaterThan(0);
  });

  test("export --json emits { nodes, edges, truncated } for the three view modes", async () => {
    for (const args of [
      ["--mode", "clusters"],
      ["--mode", "discovery"],
      ["--mode", "local", "--center", "me/identity.md"],
    ]) {
      const { stdout, code } = await runCli(root, ["graph", "export", ...args, "--json"]);
      expect(code).toBe(0);
      const out = JSON.parse(stdout);
      expect(Array.isArray(out.nodes)).toBe(true);
      expect(Array.isArray(out.edges)).toBe(true);
      expect(typeof out.truncated).toBe("boolean");
    }
  });

  test("export --mode maintenance --json emits the findings", async () => {
    const { stdout, code } = await runCli(root, ["graph", "export", "--mode", "maintenance", "--json"]);
    expect(code).toBe(0);
    const out = JSON.parse(stdout);
    expect(out.staleDays).toBe(180);
    expect(out).toHaveProperty("root");
    for (const field of ["orphans", "unreachable", "brokenLinks", "stale"]) {
      expect(Array.isArray(out[field])).toBe(true);
    }
    expect(out.orphans.length).toBeGreaterThan(0);
  });
});

describe("briefing", () => {
  test("runs and emits mechanical text (exit 0)", async () => {
    const { stdout, code } = await runCli(root, ["briefing"]);
    expect(code).toBe(0);
    expect(stdout).toContain("## Current Focus");
  });
});

describe("context", () => {
  test("emits plain-text markdown, not JSON", async () => {
    const { stdout, code } = await runCli(root, ["context", "navigation", "--max-tokens", "1000"]);
    expect(code).toBe(0);
    expect(() => JSON.parse(stdout)).toThrow();
    expect(stdout).toContain("##");
  });
});

describe("validate", () => {
  test("exits 0 on the clean corpus", async () => {
    const { stdout, code } = await runCli(root, ["validate", "--json"]);
    expect(code).toBe(0);
    const out = JSON.parse(stdout);
    expect(out.ok).toBe(true);
    expect(out.errors).toBe(0);
  });
});

describe("okf", () => {
  test("exports the indexed fixture scope with repeated excludes and checks it", async () => {
    const exported = await runCli(root, [
      "okf", "export", "--exclude", "health", "--exclude", "journal", "--no-assets", "--json",
    ]);
    expect(exported.code).toBe(0);
    const report = JSON.parse(exported.stdout);
    expect(report.filesExported).toBeGreaterThan(0);
    expect(report.assetsCopied).toBe(0);
    expect(report.topLevelDirectories).not.toContain("health");
    expect(report.topLevelDirectories).not.toContain("journal");

    const checked = await runCli(root, ["okf", "check", "--json"]);
    expect(checked.code).toBe(0);
    expect(JSON.parse(checked.stdout)).toMatchObject({ ok: true, errors: 0 });
  });
});

describe("eval", () => {
  // The set lives outside the brain root so it cannot change any count the
  // other tests in this file pin.
  test("returns the { schema_version, meta, rows, per_query, warnings } envelope", async () => {
    const dir = mkdtempSync(join(tmpdir(), "brain-eval-set-"));
    try {
      const set = join(dir, "retrieval.jsonl");
      writeFileSync(
        set,
        [
          { id: "scope", q: "star bearings orientation", class: "exact", expected: ["studies/star-bearings.md"] },
          { id: "none", q: "star guide", class: "no-answer", expected: [] },
        ].map((q) => JSON.stringify(q)).join("\n")
      );
      const { stdout, code } = await runCli(root, ["eval", "--set", set, "--mode", "fts", "--json"]);
      expect(code).toBe(0);
      const out = JSON.parse(stdout);
      expect(Object.keys(out).sort()).toEqual(["meta", "per_query", "rows", "schema_version", "warnings"]);
      expect(out.schema_version).toBe(1);
      expect(Object.keys(out.meta).sort()).toEqual([
        "documents", "embedding_model", "k", "modes", "now", "pool", "queries",
        "rerank", "reranker", "set", "set_sha256", "source", "version",
      ]);
      expect(out.meta).toMatchObject({ version: packageVersion(), queries: 2, modes: ["fts"], k: [1, 3, 10] });
      expect(out.rows.length).toBeGreaterThan(0);
      for (const row of out.rows) {
        expect(Object.keys(row).sort()).toEqual([
          "class", "current_first", "hit_at", "mode", "mrr_at_10", "n", "oracle", "top1_score_median",
        ]);
      }
      expect(out.per_query).toHaveLength(2);
      for (const query of out.per_query) {
        expect(Object.keys(query).sort()).toEqual([
          "class", "current_first", "expected", "hit_at", "id", "mode", "q", "rank", "rr", "top", "top1_score",
        ]);
      }
      expect(out.warnings).toEqual([]);
    } finally {
      cleanup(dir);
    }
  });
});

describe("stats", () => {
  // The additive guarantee, at the machine surface: `brain stats --json` grew
  // `health` and `size`, and every field a consumer already reads is still
  // there under the same name. A rename fails here. Every one keeps its type
  // too, except `embeddings`, which became `number | null` in 0.37.0 (#169);
  // it is a number here because this corpus's vector table can be counted.
  test("keeps every pre-existing field and adds the health/size blocks", async () => {
    const { stdout, code } = await runCli(root, ["stats", "--json"]);
    expect(code).toBe(0);
    const out = JSON.parse(stdout);

    for (const field of ["documents", "tags", "links", "brokenLinks", "chunks", "embeddings"]) {
      expect(typeof out[field]).toBe("number");
    }
    for (const field of ["byType", "byStatus", "byRelevance"]) {
      expect(typeof out[field]).toBe("object");
      expect(out[field]).not.toBeNull();
      expect(Array.isArray(out[field])).toBe(false);
    }

    // This link-bearing fixture has a known numeric ratio; malformed JSON
    // values (including a missing field) must fail at the machine boundary.
    expect(out.health.brokenLinkRate).toBeCloseTo(2 / 37, 10);
    // The keyless fixture has no embedding coverage. Full coverage and the
    // absent/empty-table null states also remain in cli-vector-stats.test.ts.
    expect(out.health.embeddingCoverage).toBeNull();
    for (const field of ["stale", "orphans", "untagged"]) {
      expect(typeof out.health[field]).toBe("number");
    }
    expect(typeof out.health.thresholds.coverageFloor).toBe("number");
    expect(typeof out.health.thresholds.brokenLinkCeiling).toBe("number");

    expect(typeof out.size.corpus.bytes).toBe("number");
    expect(typeof out.size.corpus.files).toBe("number");
    expect(out.size.corpus.files).toBeGreaterThan(0);
    expect(typeof out.size.db.tables.documents).toBe("number");
    expect(out.size.db.bytes).toBeGreaterThan(0);
  });
});

describe("output mode + exit codes", () => {
  test("non-TTY stdout defaults to JSON without --json", async () => {
    const { stdout } = await runCli(root, ["stats"]);
    expect(() => JSON.parse(stdout)).not.toThrow();
  });

  test("--human forces non-JSON output", async () => {
    const { stdout } = await runCli(root, ["stats", "--human"]);
    expect(() => JSON.parse(stdout)).toThrow();
    expect(stdout).toContain("Brain Statistics");
  });

  test("global surface is discoverable and unknown commands exit 1", async () => {
    const help = await runCli(root, ["--help"]);
    expect(help.code).toBe(0);
    expect(help.stdout).toMatch(/^\s*mcp\s+Start the stdio MCP server$/m);

    // The chat server parses this as SemVer and refuses to boot below its
    // minimum, so it is the bare version and a newline, nothing else.
    for (const flag of ["--version", "-v"]) {
      const version = await runCli(root, [flag]);
      expect(version.code).toBe(0);
      expect(version.stdout).toBe(`${packageVersion()}\n`);
    }

    const nestedVersion = await runCli(root, ["add", "-v"]);
    expect(nestedVersion.stdout.trim()).not.toMatch(/^\d+\.\d+\.\d+$/);

    const { code, stderr } = await runCli(root, ["bogus-command"]);
    expect(code).toBe(1);
    expect(stderr).toContain("Unknown command");
  });

  test("unknown flag exits 1", async () => {
    const { code } = await runCli(root, ["search", "x", "--not-a-flag"]);
    expect(code).toBe(1);
  });

  test("an unknown rerank mode is a usage error, not a silent fallback", async () => {
    const { code, stderr } = await runCli(root, ["search", "navigation", "--mode", "fts", "--rerank", "title", "--json"]);
    expect(code).toBe(1);
    expect(stderr).toMatch(/Unknown rerank mode "title"/);
  });

  test("--rerank jev without a key keeps the lifecycle ordering and says so", async () => {
    const enabledRoot = makeTempBrain();
    try {
      writeFileSync(join(enabledRoot, "brain.config.ts"), "export default { reranker: { enabled: true } };\n");
      expect((await runCli(enabledRoot, ["index", "--json"])).code).toBe(0);
      const res = await runCli(enabledRoot, ["search", "navigation", "--mode", "fts", "--rerank", "jev", "--json"]);
      expect(res.code).toBe(0);
      const out = JSON.parse(res.stdout);
      expect(out.results.length).toBeGreaterThan(0);
      expect(out.warnings.some((w: string) => /rerank "jev" unavailable: TYPESAFE_API_KEY not set/.test(w))).toBe(true);
    } finally { cleanup(enabledRoot); }
  });

  test("--rerank-dry-run prints the jev request without a key and sends nothing", async () => {
    const res = await runCli(root, ["search", "navigation", "--mode", "fts", "--rerank", "jev", "--rerank-dry-run", "--json"]);
    expect(res.code).toBe(0);
    const out = JSON.parse(res.stdout);
    expect(out.warnings.some((w: string) => /rerank dry run \(jev:/.test(w))).toBe(true);
    const preview = JSON.parse(res.stderr.slice(res.stderr.indexOf("{")));
    expect(preview.url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(preview.apiKeyEnv).toBe("TYPESAFE_API_KEY");
    expect(preview.questions.ranking.type).toBe("choice");
  });

  test("brain eval refuses --rerank jev it cannot run instead of scoring the fallback", async () => {
    const dir = mkdtempSync(join(tmpdir(), "brain-eval-set-"));
    try {
      const set = join(dir, "retrieval.jsonl");
      writeFileSync(set, JSON.stringify({ id: "scope", q: "star bearings orientation", class: "exact", expected: ["studies/star-bearings.md"] }));
      const res = await runCli(root, ["eval", "--set", set, "--mode", "fts", "--rerank", "jev", "--json"]);
      expect(res.code).toBe(2);
      expect(res.stderr).toMatch(/--rerank jev cannot run/);
    } finally {
      cleanup(dir);
    }
  });
});

/**
 * `brain google` (#4208): the real bin with the fake gog, handed to the child
 * through the command's seam by `helpers/google-fake-gog-preload.ts`. Every
 * run gets a temporary HOME and XDG_DATA_HOME (`keylessEnv`), a synthetic
 * keyring password and a home of its own; nothing resolves a real home.
 */
describe("google", () => {
  const PRELOAD = join(import.meta.dir, "helpers/google-fake-gog-preload.ts");
  const FIXTURES = join(import.meta.dir, "../../common/tests/fixtures/gog");
  const fixture = (name: string) => JSON.parse(readFileSync(join(FIXTURES, name), "utf8"));
  const ADDRESS = "odysseus@example.com";
  const PASSWORD = "penelope-weaves-by-day";
  const HALL = "19a0c3d2e4f50601";
  const SWINE = "19a0c3d2e4f50700";
  const READONLY = "https://www.googleapis.com/auth/gmail.readonly";
  const MODIFY = "https://www.googleapis.com/auth/gmail.modify";
  const IDENTITY = ["email", "https://www.googleapis.com/auth/userinfo.email", "openid"];
  const GRANT_READONLY = [...IDENTITY, READONLY].sort();
  const GRANT_WRITE = [...IDENTITY, READONLY, MODIFY].sort();
  const POLICY = { enabled: true, account: "ithaca", services: ["gmail"] };
  /** The hall thread's first message, as `gog gmail get` returns it: its own labels carry nothing hidden. */
  const CLEAN_MESSAGE = (() => {
    const message = fixture("message-get.json");
    message.message.id = HALL;
    message.message.labelIds = ["INBOX", "CATEGORY_PERSONAL"];
    return message;
  })();

  let brain: string;
  let home: string;
  let fake: FakeGog;
  const scratch: string[] = [];

  function policy(google: Record<string, unknown> | null, extra = ""): void {
    mkdirSync(join(brain, "context/policies"), { recursive: true });
    writeFileSync(join(brain, "context/policies/governance.md"),
      `---\nschema_version: 1\n${google ? `google: ${JSON.stringify(google)}\n` : ""}${extra}---\n`);
  }

  function freshHome(): string {
    const dir = mkdtempSync(join(tmpdir(), "brain-google-home-"));
    chmodSync(dir, 0o700);
    scratch.push(dir);
    return dir;
  }

  const accounts = (scopes: string[]) => ({ stdout: { accounts: [{ email: ADDRESS, services: ["gmail"], scopes, created_at: "2026-07-12T08:00:00Z", auth: "oauth" }] } });
  const CONNECTED = { "auth.alias.list": { stdout: { aliases: { ithaca: ADDRESS } } }, "auth.list": accounts(GRANT_READONLY) };
  const SEARCH = {
    "gmail.search": { stdout: fixture("search-ids.json") },
    [`gmail.thread.get ${HALL}`]: { stdout: fixture("thread-hall.json") },
    [`gmail.thread.get ${SWINE}`]: { stdout: fixture("thread-swine.json") },
    "gmail.labels.list": { stdout: fixture("labels-list.json") },
  };

  const google = (args: string[], env: Record<string, string> = {}) => runCli(brain, ["google", ...args, "--json"], {
    BRAIN_TEST_FAKE_GOG: fake.executable, BRAIN_GOOGLE_HOME: home, BRAIN_GOOGLE_KEYRING_PASSWORD: PASSWORD, ...env,
  }, { preload: PRELOAD });

  beforeAll(() => {
    brain = makeTempBrain();
  });
  afterAll(() => {
    cleanup(brain);
    for (const dir of scratch) cleanup(dir);
  });
  beforeEach(() => {
    fake = createFakeGog();
    home = freshHome();
    policy(POLICY);
  });
  afterEach(() => fake.dispose());

  test("google status reports the home, the pin, the policy, the alias and its scopes, and the standalone statement", async () => {
    fake.setScenario(CONNECTED);
    const res = await google(["status"]);
    expect(res.code).toBe(0);
    const out = JSON.parse(res.stdout);
    expect(Object.keys(out).sort()).toEqual(["data", "ok", "operation"]);
    expect(out).toMatchObject({ ok: true, operation: "status" });
    expect(Object.keys(out.data).sort()).toEqual(["account", "boundary", "home", "pin", "policy", "reason", "scopes", "state", "statement", "warnings"]);
    expect(out.data).toMatchObject({
      state: "available", reason: null, boundary: "standalone",
      home: { source: "BRAIN_GOOGLE_HOME", exists: true, ok: true, reason: null },
      pin: { state: "fake" },
      policy: { status: "valid", enabled: true, account: "ithaca", services: ["gmail"], read: "allow", standalone_reversible: "deny" },
      account: { alias: "ithaca", connected: true },
      scopes: { granted: GRANT_READONLY, needed: [READONLY], broader: [], missing: [], write: false },
      warnings: [],
    });
    expect(out.data.statement).toMatch(/local agent with shell access .* inside this boundary/);
    // The address behind the alias, and the password, never leave gog's home.
    expect(res.stdout).not.toContain(ADDRESS);
    expect(res.stdout + res.stderr).not.toContain(PASSWORD);
    expect(fake.calls().map(call => call.command)).toEqual(["auth.alias.list", "auth.list"]);
  });

  test("google status warns on a grant broader than the policy can use", async () => {
    fake.setScenario({ ...CONNECTED, "auth.list": accounts([...GRANT_WRITE, "https://www.googleapis.com/auth/gmail.settings.sharing"]) });
    const out = JSON.parse((await google(["status"])).stdout);
    expect(out.data.state).toBe("available");
    expect(out.data.scopes).toMatchObject({ broader: ["https://www.googleapis.com/auth/gmail.settings.sharing"], write: true });
    expect(out.data.warnings).toEqual([expect.stringMatching(/scopes the policy cannot use \(https:\/\/www.googleapis.com\/auth\/gmail.settings.sharing\)/)]);
  });

  test("google status on an unconnected alias, an absent policy block and an unset password", async () => {
    fake.setScenario({ "auth.alias.list": { stdout: { aliases: {} } } });
    expect(JSON.parse((await google(["status"])).stdout).data).toMatchObject({ state: "unavailable", reason: "not_connected", account: { connected: false } });
    policy(null);
    expect(JSON.parse((await google(["status"])).stdout).data).toMatchObject({ state: "unavailable", reason: "not_enabled" });
    policy(POLICY);
    const unset = JSON.parse((await google(["status"], { BRAIN_GOOGLE_KEYRING_PASSWORD: "" })).stdout).data;
    expect(unset).toMatchObject({ state: "unavailable", reason: "keyring_password_unset", pin: { state: "not_checked" } });
  });

  test("google gmail search: both views, hidden threads dropped, a host cursor that pages on", async () => {
    fake.setScenario(SEARCH);
    const content = await google(["gmail", "search", "from:penelope", "-in:spam"]);
    expect(content.code).toBe(0);
    const page = JSON.parse(content.stdout);
    expect(page).toMatchObject({ ok: true, operation: "gmail.search", data: { view: "content" } });
    expect(page.data.threads.map((thread: { thread_id: string }) => thread.thread_id)).toEqual([HALL, SWINE]);
    expect(page.data.threads[0].untrusted).toBeDefined();
    expect(page.data.threads[0].labels).toContainEqual({ id: "Label_12", name: "Ithaca/Household" });
    expect(page.data.next_cursor).toMatch(/^gc_[A-Za-z0-9_-]{16,64}$/);
    expect(content.stdout).not.toContain("09876543210987654321");
    const [search] = fake.callsOf("gmail.search");
    expect(search!.argv).toEqual(["--no-input", "--json", "--color=never", "--account=ithaca", "--enable-commands-exact=gmail.search", "--readonly", "--gmail-no-send",
      "gmail", "search", "--ids-only", "--max=10", "--", "from:penelope -in:spam"]);

    const next = await google(["gmail", "search", "from:penelope", "-in:spam", "--cursor", page.data.next_cursor, "--view", "structured", "--limit", "5"]);
    expect(next.code).toBe(0);
    const structured = JSON.parse(next.stdout).data;
    expect(structured.view).toBe("structured");
    for (const thread of structured.threads) expect(thread.untrusted).toBeUndefined();
    // No address, name, subject or snippet anywhere in a structured page.
    expect(JSON.stringify(structured)).not.toMatch(/@example\.com|Penelope|Telemachus|Suitors|weav/i);
    expect(fake.callsOf("gmail.search")[1]!.argv).toContain("--page=09876543210987654321");
    expect(fake.callsOf("gmail.search")[1]!.argv).toContain("--max=5");

    // A cursor is bound to its query.
    const other = JSON.parse((await google(["gmail", "search", "from:eumaeus", "--cursor", page.data.next_cursor])).stdout);
    expect(other).toMatchObject({ ok: false, operation: "gmail.search", error: { code: "invalid_input", reason: "cursor" } });

    policy({ ...POLICY, gmail: { hidden_labels: ["Label_12"] } });
    const hidden = JSON.parse((await google(["gmail", "search", "from:penelope"])).stdout).data;
    expect(hidden.threads.map((thread: { thread_id: string }) => thread.thread_id)).toEqual([SWINE]);
  });

  test("google gmail read: a thread, a message, a draft and the labels in each view", async () => {
    fake.setScenario({
      ...SEARCH,
      "gmail.get": { stdout: fixture("message-get.json") },
      "gmail.drafts.get": { stdout: fixture("draft-raw.json") },
    });
    const thread = JSON.parse((await google(["gmail", "read", "thread", HALL])).stdout);
    expect(thread).toMatchObject({ ok: true, operation: "gmail.thread.get", data: { view: "content", thread_id: HALL, message_count: 2 } });
    expect(thread.data.messages[1].untrusted.body_text).toBeDefined();
    const structured = JSON.parse((await google(["gmail", "read", "thread", HALL, "--view", "structured"])).stdout).data;
    expect(structured.view).toBe("structured");
    expect(JSON.stringify(structured)).not.toContain("untrusted");
    expect(JSON.stringify(structured)).not.toMatch(/@example\.com|Penelope|Telemachus|Suitors|Pylos/i);
    const message = JSON.parse((await google(["gmail", "read", "message", "19a0c3d2e4f50602"])).stdout);
    expect(message).toMatchObject({ ok: true, operation: "gmail.message.get", data: { view: "content", message: { message_id: "19a0c3d2e4f50602", thread_id: HALL } } });
    const draft = JSON.parse((await google(["gmail", "read", "draft", "r-1234567890123456789", "--view", "structured"])).stdout);
    expect(draft).toMatchObject({ ok: true, operation: "gmail.draft.get", data: { view: "structured", draft_id: "r-1234567890123456789" } });
    const labels = JSON.parse((await google(["gmail", "labels"])).stdout);
    expect(labels).toMatchObject({ ok: true, operation: "gmail.labels.list", data: { view: "structured" } });
    expect(labels.data.labels).toContainEqual(expect.objectContaining({ id: "Label_12", name: "Ithaca/Household", type: "user" }));
    for (const call of fake.calls()) {
      expect(call.argv).toContain("--readonly");
      expect(call.argv).toContain("--gmail-no-send");
      expect(call.argv).toContain(`--enable-commands-exact=${call.command}`);
    }
  });

  test("google gmail read answers a hidden thread, message or draft exactly as a miss", async () => {
    policy({ ...POLICY, gmail: { hidden_labels: ["Label_12"] } });
    fake.setScenario({
      ...SEARCH,
      "gmail.get": { stdout: CLEAN_MESSAGE },
      "gmail.drafts.get": { stdout: fixture("draft-raw.json") },
      [`gmail.thread.get ${SWINE}`]: { exit: 5 },
    });
    const miss = JSON.parse((await google(["gmail", "read", "thread", SWINE])).stdout);
    expect(miss).toEqual({ ok: false, operation: "gmail.thread.get", error: { code: "not_found", reason: null, message: "No such Gmail thread, message or draft was found." } });
    const hiddenThread = await google(["gmail", "read", "thread", HALL]);
    expect(hiddenThread.code).toBe(1);
    expect(JSON.parse(hiddenThread.stdout).error).toEqual(miss.error);
    // A message whose own labels are clean, hidden by Label_12 on the other message of its thread; and the draft in that thread.
    expect(JSON.parse((await google(["gmail", "read", "message", "19a0c3d2e4f50601"])).stdout).error).toEqual(miss.error);
    expect(fake.callsOf("gmail.thread.get").map(call => call.argv.at(-1))).toContain(HALL);
    expect(JSON.parse((await google(["gmail", "read", "draft", "r-1234567890123456789"])).stdout).error).toEqual(miss.error);
    // A thread whose labels cannot be read is never clean, and its failure says nothing: its message reads as a miss.
    for (const failing of [{ exit: 5 }, { exit: 7 }, { stdout: fixture("thread-swine.json") }]) {
      fake.setScenario({ ...SEARCH, "gmail.get": { stdout: CLEAN_MESSAGE }, [`gmail.thread.get ${HALL}`]: failing });
      expect(JSON.parse((await google(["gmail", "read", "message", "19a0c3d2e4f50601"])).stdout).error).toEqual(miss.error);
    }
    // A draft with no message has no labels to establish.
    fake.setScenario({ "gmail.drafts.get": { stdout: { draft: { id: "r-1234567890123456789" } } } });
    expect(JSON.parse((await google(["gmail", "read", "draft", "r-1234567890123456789"])).stdout).error).toEqual(miss.error);
    // A target whose fetch failed in a way that may be its own was never seen: it reads as a miss while anything is hidden.
    fake.setScenario({ "gmail.thread.get": { stdout_bytes: 9 * 1024 * 1024 }, "gmail.get": { stdout: "not json" }, "gmail.drafts.get": { stdout: { draft: { id: "r-1" } } } });
    expect(JSON.parse((await google(["gmail", "read", "thread", HALL])).stdout).error).toEqual(miss.error);
    expect(JSON.parse((await google(["gmail", "read", "message", "19a0c3d2e4f50601"])).stdout).error).toEqual(miss.error);
    expect(JSON.parse((await google(["gmail", "read", "draft", "r-1234567890123456789"])).stdout).error).toEqual(miss.error);
    for (const exit of [1, 6]) {
      fake.setScenario({ "gmail.thread.get": { exit }, "gmail.get": { exit }, "gmail.drafts.get": { exit } });
      for (const [target, id] of [["thread", HALL], ["message", "19a0c3d2e4f50601"], ["draft", "r-1234567890123456789"]]) {
        expect(JSON.parse((await google(["gmail", "read", target!, id!])).stdout).error, `${target} exit ${exit}`).toEqual(miss.error);
      }
    }
    // A failure that says nothing about the target keeps its code.
    fake.setScenario({ "gmail.thread.get": { exit: 7 } });
    expect(JSON.parse((await google(["gmail", "read", "thread", HALL])).stdout).error).toMatchObject({ code: "rate_limited" });
    // A hidden label on the message itself decides without reading its thread.
    fake.dispose();
    fake = createFakeGog({ "gmail.get": { stdout: fixture("message-get.json") } });
    expect(JSON.parse((await google(["gmail", "read", "message", "19a0c3d2e4f50602"])).stdout).error).toEqual(miss.error);
    expect(fake.callsOf("gmail.thread.get")).toEqual([]);
  });

  test("google refusals: unavailable, policy_denied and transport_incompatible, each before or instead of any text", async () => {
    policy(null);
    const disabled = await google(["gmail", "labels"]);
    expect(disabled.code).toBe(1);
    expect(JSON.parse(disabled.stdout)).toMatchObject({ ok: false, operation: "gmail.labels.list", error: { code: "unavailable", reason: "not_enabled" } });

    policy(POLICY);
    expect(JSON.parse((await google(["gmail", "labels"], { BRAIN_GOOGLE_KEYRING_PASSWORD: "" })).stdout).error)
      .toMatchObject({ code: "unavailable", reason: "keyring_password_unset" });

    policy({ ...POLICY, modes: { read: "deny" } });
    expect(JSON.parse((await google(["gmail", "search", "from:penelope"])).stdout).error).toMatchObject({ code: "policy_denied", reason: "class_denied" });

    // No conversation to inspect: a provider rule that keeps folders from google is unproven.
    policy(POLICY, "providers:\n  - paths: [\"me/**\"]\n    allow: [\"anthropic\"]\n");
    expect(JSON.parse((await google(["gmail", "read", "thread", HALL])).stdout).error).toMatchObject({ code: "policy_denied", reason: "recipient_unproven" });
    expect(fake.calls()).toEqual([]);

    policy(POLICY);
    fake.setScenario({ "gmail.labels.list": { stdout: "not json" } });
    expect(JSON.parse((await google(["gmail", "labels"])).stdout).error).toMatchObject({ code: "transport_incompatible", reason: "unexpected_output" });
    fake.setScenario({ "gmail.labels.list": { exit: 2 } });
    expect(JSON.parse((await google(["gmail", "labels"])).stdout).error).toMatchObject({ code: "transport_incompatible", reason: "usage" });
    // An answer about another thread, message or draft than the one asked for.
    fake.setScenario({ ...SEARCH, [`gmail.thread.get ${HALL}`]: { stdout: fixture("thread-swine.json") }, "gmail.get": { stdout: fixture("message-get.json") },
      "gmail.drafts.get": { stdout: fixture("draft-raw.json") } });
    const shape = { code: "transport_incompatible", reason: "unexpected_shape" };
    expect(JSON.parse((await google(["gmail", "read", "thread", HALL])).stdout).error).toMatchObject(shape);
    expect(JSON.parse((await google(["gmail", "read", "message", "19a0c3d2e4f50a01"])).stdout).error).toMatchObject(shape);
    expect(JSON.parse((await google(["gmail", "read", "draft", "r-9876543210"])).stdout).error).toMatchObject(shape);
    // A message-less draft is an answer, while nothing is hidden.
    fake.setScenario({ "gmail.drafts.get": { stdout: { draft: { id: "r-1234567890123456789" } } } });
    expect(JSON.parse((await google(["gmail", "read", "draft", "r-1234567890123456789"])).stdout)).toMatchObject({ ok: true, data: { draft_id: "r-1234567890123456789", message: null } });
    // An account command that answers more than it may is not read.
    fake.setScenario({ "auth.alias.list": { stdout: { aliases: { ithaca: ADDRESS } } }, "auth.list": { stdout_bytes: 2 * 1024 * 1024 } });
    expect(JSON.parse((await google(["status"])).stdout).data).toMatchObject({ state: "unavailable", reason: "output_too_large" });
  });

  const authAdd = (flags: string[]) => ["--no-input", "--json", "--color=never", "--enable-commands-exact=auth.add", ...flags];

  test("google connect argv: read-only and --write shapes, the alias set after the grant is verified", async () => {
    fake.setScenario({ "auth.add": { stdout: { stored: true }, stderr: "Open this URL to authorize\n" }, "auth.list": accounts(GRANT_READONLY), "auth.alias.set": { stdout: { alias: "ithaca" } } });
    const readOnly = await google(["connect", ADDRESS]);
    expect(readOnly.code).toBe(0);
    // The browser flow shows gog's own stderr: the URL to open when no browser starts.
    expect(readOnly.stderr).toContain("Open this URL to authorize");
    expect(JSON.parse(readOnly.stdout)).toMatchObject({ ok: true, operation: "connect", data: { state: "connected", alias: "ithaca", write: false, scopes: GRANT_READONLY } });
    expect(readOnly.stdout).not.toContain(ADDRESS);
    expect(fake.calls().map(call => call.command)).toEqual(["auth.add", "auth.list", "auth.alias.set"]);
    expect(fake.callsOf("auth.add")[0]!.argv).toEqual(authAdd(["--readonly", "--gmail-no-send", "auth", "add",
      "--services=gmail", "--gmail-scope=readonly", "--force-consent", "--", ADDRESS]));
    expect(fake.callsOf("auth.alias.set")[0]!.argv.slice(-3)).toEqual(["--", "ithaca", ADDRESS]);

    fake.dispose();
    fake = createFakeGog({ "auth.add": { stdout: { stored: true } }, "auth.list": accounts(GRANT_WRITE), "auth.alias.set": { stdout: { alias: "ithaca" } } });
    const write = JSON.parse((await google(["connect", ADDRESS, "--write"])).stdout);
    expect(write).toMatchObject({ ok: true, data: { state: "connected", write: true, scopes: GRANT_WRITE } });
    expect(fake.callsOf("auth.add")[0]!.argv).toEqual(authAdd(["--gmail-no-send", "auth", "add",
      "--services=gmail", "--gmail-scope=readonly", `--extra-scopes=${MODIFY}`, "--force-consent", "--", ADDRESS]));
  });

  test("google connect --remote: step 1 prints the URL, step 2 exchanges the redirect", async () => {
    const url = "https://accounts.google.com/o/oauth2/auth?client_id=ithaca&state=telemachus";
    fake.setScenario({ "auth.add": { stdout: { auth_url: url, state_reused: false }, stderr: "gog hint: run gog auth add again\n" } });
    const run = await google(["connect", ADDRESS, "--remote"]);
    // A remote step prompts for nothing, so gog's own stderr is not shown.
    expect(run.stderr).not.toContain("gog hint");
    const first = JSON.parse(run.stdout);
    expect(first).toMatchObject({ ok: true, operation: "connect", data: { state: "authorize", alias: "ithaca", auth_url: url } });
    expect(fake.calls().map(call => call.command)).toEqual(["auth.add"]);
    expect(fake.callsOf("auth.add")[0]!.argv).toEqual(authAdd(["--readonly", "--gmail-no-send", "auth", "add",
      "--services=gmail", "--gmail-scope=readonly", "--force-consent", "--remote", "--step=1", "--", ADDRESS]));

    fake.dispose();
    fake = createFakeGog({ "auth.add": { stdout: { stored: true }, stderr: "gog hint: exchanged\n" }, "auth.list": accounts(GRANT_READONLY), "auth.alias.set": { stdout: {} } });
    const redirect = "http://127.0.0.1:8765/oauth2/callback?state=telemachus&code=ithaca-code";
    const exchanged = await google(["connect", ADDRESS, "--remote", "--auth-url", redirect]);
    expect(exchanged.stderr).not.toContain("gog hint");
    const second = JSON.parse(exchanged.stdout);
    expect(second).toMatchObject({ ok: true, data: { state: "connected" } });
    expect(fake.callsOf("auth.add")[0]!.argv).toEqual(authAdd(["--readonly", "--gmail-no-send", "auth", "add",
      "--services=gmail", "--gmail-scope=readonly", "--force-consent", "--remote", "--step=2", `--auth-url=${redirect}`, "--", ADDRESS]));
  });

  test("google connect removes and refuses a grant broader than it asked for", async () => {
    fake.setScenario({
      "auth.add": { stdout: { stored: true } },
      "auth.list": accounts([...GRANT_READONLY, "https://www.googleapis.com/auth/gmail.settings.basic"]),
      "auth.remove": { stdout: { deleted: true } },
    });
    const res = await google(["connect", ADDRESS]);
    expect(res.code).toBe(1);
    expect(JSON.parse(res.stdout)).toMatchObject({ ok: false, operation: "connect", error: { code: "policy_denied", reason: "scopes_broader" } });
    expect(fake.calls().map(call => call.command)).toEqual(["auth.add", "auth.list", "auth.remove"]);
    expect(fake.callsOf("auth.remove")[0]!.argv).toEqual(["--no-input", "--json", "--color=never", "--enable-commands-exact=auth.remove", "--gmail-no-send", "--force",
      "auth", "remove", "--", ADDRESS]);
  });

  test("google connect refuses a grant that lacks a scope it asked for, and names no alias", async () => {
    fake.setScenario({ "auth.add": { stdout: { stored: true } }, "auth.list": accounts(GRANT_READONLY) });
    const res = await google(["connect", ADDRESS, "--write"]);
    expect(res.code).toBe(1);
    expect(JSON.parse(res.stdout)).toMatchObject({ ok: false, operation: "connect", error: { code: "unavailable", reason: "scopes_missing" } });
    expect(fake.calls().map(call => call.command)).toEqual(["auth.add", "auth.list"]);
  });

  test("google connect selects the home: BRAIN_UI_GOOGLE_HOME on a host, BRAIN_GOOGLE_HOME, else $XDG_DATA_HOME/brain/google", async () => {
    const scenario = { "auth.add": { stdout: { stored: true } }, "auth.list": accounts(GRANT_READONLY), "auth.alias.set": { stdout: {} } };
    fake.setScenario(scenario);
    const standalone = join(freshHome(), "standalone");
    const named = JSON.parse((await google(["connect", ADDRESS], { BRAIN_GOOGLE_HOME: standalone })).stdout);
    expect(named.data).toMatchObject({ boundary: "standalone", home: realpathSync(standalone) });
    // What gog itself was given, for every command of the connect.
    const homes = () => [...new Set(fake.calls().map(call => call.gog_home))];
    expect(homes()).toEqual([realpathSync(standalone)]);
    expect(statSync(standalone).mode & 0o777).toBe(0o700);

    const data = freshHome();
    fake.dispose();
    fake = createFakeGog(scenario);
    const fallback = JSON.parse((await google(["connect", ADDRESS], { BRAIN_GOOGLE_HOME: "", XDG_DATA_HOME: data })).stdout);
    expect(fallback.data).toMatchObject({ boundary: "standalone", home: join(realpathSync(data), "brain/google") });
    expect(homes()).toEqual([join(realpathSync(data), "brain/google")]);

    const host = join(freshHome(), "host");
    fake.dispose();
    fake = createFakeGog(scenario);
    const hosted = JSON.parse((await google(["connect", ADDRESS], { BRAIN_UI_GOOGLE_HOME: host, BRAIN_UI_GOOGLE_KEYRING_PASSWORD: PASSWORD })).stdout);
    expect(hosted.data).toMatchObject({ boundary: "host", home: realpathSync(host) });
    expect(homes()).toEqual([realpathSync(host)]);
    // On a host the host's password is the one that counts.
    const unset = JSON.parse((await google(["connect", ADDRESS], { BRAIN_UI_GOOGLE_HOME: host })).stdout);
    expect(unset.error).toMatchObject({ code: "unavailable", reason: "keyring_password_unset", message: expect.stringContaining("BRAIN_UI_GOOGLE_KEYRING_PASSWORD") });

    // Never inside a brain repository.
    const inside = JSON.parse((await google(["connect", ADDRESS], { BRAIN_GOOGLE_HOME: join(brain, "google") })).stdout);
    expect(inside.error).toMatchObject({ code: "unavailable", reason: "home_inside_brain" });
    expect(existsSync(join(brain, "google"))).toBe(false);
    expect(fake.callsOf("auth.add")).toHaveLength(1);
  });

  test("google search running across a reconnect keeps no page of the old connection", async () => {
    const gate = fake.path("search-may-answer");
    fake.setScenario({ ...SEARCH, "gmail.search": { stdout: fixture("search-ids.json"), wait_for: gate },
      "auth.add": { stdout: { stored: true } }, "auth.list": accounts(GRANT_READONLY), "auth.alias.set": { stdout: {} } });
    const search = google(["gmail", "search", "from:penelope"]);
    const deadline = Date.now() + watchdogMs(20_000);
    while (fake.callsOf("gmail.search").length === 0 && Date.now() < deadline) await Bun.sleep(20);
    expect(fake.callsOf("gmail.search")).toHaveLength(1);
    expect((await google(["connect", ADDRESS])).code).toBe(0);
    writeFileSync(gate, "");
    const out = JSON.parse((await search).stdout);
    expect(out).toMatchObject({ ok: false, operation: "gmail.search", error: { code: "unavailable", reason: "connection_changed" } });
  });

  test("google search paging across a reconnect returns nothing it was answered, even on a last page", async () => {
    const gate = fake.path("page-may-answer");
    const last = { ...fixture("search-ids.json"), nextPageToken: "", has_more: false };
    fake.setScenario({ ...SEARCH, "gmail.search": [{ stdout: fixture("search-ids.json") }, { stdout: last, wait_for: gate }],
      "auth.add": { stdout: { stored: true } }, "auth.list": accounts(GRANT_READONLY), "auth.alias.set": { stdout: {} } });
    const cursor = JSON.parse((await google(["gmail", "search", "from:penelope"])).stdout).data.next_cursor;
    const next = google(["gmail", "search", "from:penelope", "--cursor", cursor]);
    const deadline = Date.now() + watchdogMs(20_000);
    while (fake.callsOf("gmail.search").length < 2 && Date.now() < deadline) await Bun.sleep(20);
    expect(fake.callsOf("gmail.search")[1]!.argv).toContain("--page=09876543210987654321");
    expect((await google(["connect", ADDRESS])).code).toBe(0);
    writeFileSync(gate, "");
    expect(JSON.parse((await next).stdout)).toMatchObject({ ok: false, error: { code: "unavailable", reason: "connection_changed" } });
  });

  test("google connect warns when it cannot forget earlier search cursors", async () => {
    mkdirSync(join(home, "brain-search-generation", "occupied"), { recursive: true });
    fake.setScenario({ "auth.add": { stdout: { stored: true } }, "auth.list": accounts(GRANT_READONLY), "auth.alias.set": { stdout: {} } });
    const out = JSON.parse((await google(["connect", ADDRESS])).stdout);
    expect(out).toMatchObject({ ok: true, data: { state: "connected" } });
    expect(out.data.warnings).toEqual([expect.stringMatching(/cursors could not be forgotten/)]);
  });

  test("google connect --credentials stores the OAuth client from stdin first, and refuses a file it will not read", async () => {
    const client = JSON.stringify({ installed: { client_id: "ithaca.apps.example.com", client_secret: "loom-shroud", redirect_uris: ["http://localhost"] } });
    const dir = freshHome();
    const file = join(dir, "client.json");
    writeFileSync(file, client);
    fake.setScenario({ "auth.credentials.set": { stdout: { saved: true } }, "auth.add": { stdout: { stored: true } }, "auth.list": accounts(GRANT_READONLY), "auth.alias.set": { stdout: {} } });
    const res = await google(["connect", ADDRESS, "--credentials", file]);
    expect(res.code).toBe(0);
    expect(fake.calls().map(call => call.command)).toEqual(["auth.credentials.set", "auth.add", "auth.list", "auth.alias.set"]);
    const [stored] = fake.callsOf("auth.credentials.set");
    expect(stored!.argv).toEqual(["--no-input", "--json", "--color=never", "--enable-commands-exact=auth.credentials.set", "--gmail-no-send", "auth", "credentials", "set", "--", "-"]);
    expect(Buffer.from(stored!.stdin_base64, "base64").toString("utf8")).toBe(client);
    expect(res.stdout + res.stderr).not.toContain("loom-shroud");

    const large = join(dir, "large.json");
    writeFileSync(large, JSON.stringify({ installed: { padding: "x".repeat(70 * 1024) } }));
    const fifo = join(dir, "fifo");
    expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0);
    for (const path of [large, fifo, join(dir, "absent.json")]) {
      const refused = await google(["connect", ADDRESS, "--credentials", path]);
      expect(refused.code).toBe(1);
      expect(refused.stdout).toBe("");
      expect(refused.stderr).toContain("--credentials");
    }
    expect(fake.callsOf("auth.credentials.set")).toHaveLength(1);
  });

  test("google connect refuses a malformed address or redirect before running gog", async () => {
    for (const args of [["connect", "Odysseus <odysseus@example.com>"], ["connect", "odysseus"], ["connect", ADDRESS, "--remote", "--auth-url", "javascript:alert(1)"]]) {
      const res = await google(args);
      expect(res.code).toBe(1);
      expect(JSON.parse(res.stdout).error.code).toBe("invalid_input");
    }
    expect(fake.calls()).toEqual([]);
  });

  test("google status flags gmail.modify while the policy admits no write, and refuses a scope it cannot read", async () => {
    policy({ ...POLICY, modes: { reversible: "deny", irreversible: "deny" } });
    fake.setScenario({ ...CONNECTED, "auth.list": accounts(GRANT_WRITE) });
    const denied = JSON.parse((await google(["status"])).stdout).data;
    expect(denied.scopes).toMatchObject({ broader: [MODIFY], write: true });
    expect(denied.warnings).toEqual([expect.stringContaining(MODIFY)]);
    fake.setScenario({ ...CONNECTED, "auth.list": accounts([...GRANT_READONLY, `${ADDRESS}\u001b[2J`]) });
    const odd = await google(["status"]);
    expect(JSON.parse(odd.stdout).data).toMatchObject({ state: "unavailable", reason: "unexpected_shape", scopes: { granted: null } });
    expect(odd.stdout).not.toContain(ADDRESS);
  });

  test("google gmail reads carry no label names where the policy denies reading the label list", async () => {
    policy({ ...POLICY, operations: { "gmail.labels.list": "deny" } });
    fake.setScenario(SEARCH);
    const thread = JSON.parse((await google(["gmail", "read", "thread", HALL, "--view", "structured"])).stdout);
    expect(thread.ok).toBe(true);
    expect(thread.data.messages[1].labels).toContainEqual({ id: "Label_12", name: null });
    expect(fake.callsOf("gmail.labels.list")).toEqual([]);
  });

  test("google connect forgets every search cursor, so an alias pointed elsewhere inherits none", async () => {
    fake.setScenario({ ...SEARCH, "auth.add": { stdout: { stored: true } }, "auth.list": accounts(GRANT_READONLY), "auth.alias.set": { stdout: {} } });
    const cursor = JSON.parse((await google(["gmail", "search", "from:penelope"])).stdout).data.next_cursor;
    expect(cursor).toMatch(/^gc_/);
    expect((await google(["connect", ADDRESS])).code).toBe(0);
    const stale = JSON.parse((await google(["gmail", "search", "from:penelope", "--cursor", cursor])).stdout);
    expect(stale.error).toMatchObject({ code: "invalid_input", reason: "cursor" });
  });

  test("google: brain doctor fails when the standalone home is inside a brain repository", async () => {
    const doctor = async (env: Record<string, string>) => {
      const res = await runCli(brain, ["doctor", "--json"], env);
      // A diagnostic report: it exits 0 and says what failed in its checks.
      expect(res.code).toBe(0);
      return JSON.parse(res.stdout).checks.find((check: { id: string }) => check.id === "google-home");
    };
    expect(await doctor({ BRAIN_GOOGLE_HOME: join(brain, "state/google") })).toMatchObject({ status: "fail", fix: expect.stringContaining("BRAIN_GOOGLE_HOME") });
    expect(await doctor({ BRAIN_GOOGLE_HOME: home })).toMatchObject({ status: "pass" });
    // Where it lies cannot be established below a directory anyone may change: a warning, never a pass.
    const shared = freshHome();
    chmodSync(shared, 0o777);
    try {
      expect(await doctor({ BRAIN_GOOGLE_HOME: join(shared, "google") })).toMatchObject({ status: "warn" });
    } finally {
      chmodSync(shared, 0o700);
    }
  });
});
