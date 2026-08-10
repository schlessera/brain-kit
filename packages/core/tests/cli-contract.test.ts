/**
 * CLI contract tests. Spawns the real bin against a temp copy of the fixture
 * corpus (keyless) and asserts the stable `--json` envelope shapes and exit
 * codes from docs/integration-contract.md.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { cleanup, makeTempBrain, runCli } from "./cli-harness";

let root: string;

beforeAll(async () => {
  root = makeTempBrain();
  const idx = await runCli(root, ["index", "--json"]);
  expect(idx.code).toBe(0);
});

afterAll(() => cleanup(root));

describe("search", () => {
  test("FTS mode returns the { results, warnings } envelope", async () => {
    const { stdout, code } = await runCli(root, ["search", "astronomy", "--mode", "fts", "--json"]);
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

  test("hybrid mode without a key degrades to FTS with a warning", async () => {
    const { stdout, code } = await runCli(root, ["search", "telescope", "--mode", "hybrid", "--json"]);
    expect(code).toBe(0);
    const out = JSON.parse(stdout);
    expect(Array.isArray(out.results)).toBe(true);
    expect(out.warnings.some((w: string) => /vector search/i.test(w))).toBe(true);
  });

  test("no query and no filter is a usage error (exit 1)", async () => {
    const { code } = await runCli(root, ["search", "--json"]);
    expect(code).toBe(1);
  });
});

describe("audit", () => {
  test("returns the { issues, ... } envelope", async () => {
    const { stdout, code } = await runCli(root, ["audit", "--json"]);
    expect(code).toBe(0);
    const out = JSON.parse(stdout);
    expect(Array.isArray(out.issues)).toBe(true);
    expect(typeof out.errors).toBe("number");
    expect(typeof out.warnings).toBe("number");
    // Assets are excluded — no issue should point at a binary asset.
    for (const issue of out.issues) {
      expect(issue.path).not.toMatch(/\.(png|pdf|jpe?g)$/i);
    }
  });
});

describe("index", () => {
  test("emits an IndexStats object", async () => {
    const { stdout, code } = await runCli(root, ["index", "--json"]);
    expect(code).toBe(0);
    const stats = JSON.parse(stdout);
    for (const field of ["total", "added", "updated", "deleted", "unchanged", "chunks", "embeddings", "assets"]) {
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
    expect(results.every((r: { type: string }) => r.type === "health")).toBe(true);
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
    const { stdout, code } = await runCli(root, ["context", "astronomy", "--max-tokens", "1000"]);
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

    const version = await runCli(root, ["--version"]);
    expect(version.code).toBe(0);
    expect(version.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);

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
});
