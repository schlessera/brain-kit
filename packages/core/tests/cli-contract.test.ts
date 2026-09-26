/**
 * CLI contract tests. Spawns the real bin against a temp copy of the fixture
 * corpus (keyless) and asserts the stable `--json` envelope shapes and exit
 * codes from docs/integration-contract.md.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { cleanup, makeTempBrain, runCli } from "./cli-harness";
import { packageVersion } from "../src/package-version";

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

  test("a result carries the document's deadline and freshness fields", async () => {
    const { stdout, code } = await runCli(root, ["search", "bookshelf", "--mode", "fts", "--json"]);
    expect(code).toBe(0);
    const out = JSON.parse(stdout);
    const status = out.results.find((r: { path: string }) => r.path === "projects/active/bookshelf/status.md");
    expect(status).toBeDefined();
    expect(status.deadline).toBe("2026-08-15");
    expect(status.updated).toBe("2026-06-30");
  });

  test("--chunks adds each result's matching chunks; without it the results carry none", async () => {
    const withChunks = JSON.parse((await runCli(root, ["search", "walnut shelves", "--mode", "fts", "--chunks", "--json"])).stdout);
    const first = withChunks.results[0];
    expect(first.chunks.length).toBeGreaterThan(0);
    const source = readFileSync(join(root, first.path), "utf-8");
    for (const chunk of first.chunks) {
      expect(Object.keys(chunk).sort()).toEqual(["chunk_index", "content", "heading", "path", "score"]);
      expect(chunk.path).toBe(first.path);
      // The chunk's heading is one of the file's own section headings.
      if (chunk.heading !== "(intro)") expect(source).toMatch(new RegExp(`^## ${chunk.heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"));
    }
    const without = JSON.parse((await runCli(root, ["search", "walnut shelves", "--mode", "fts", "--json"])).stdout);
    expect(without.results.map((r: { path: string }) => r.path)).toEqual(withChunks.results.map((r: { path: string }) => r.path));
    for (const r of without.results) expect(r).not.toHaveProperty("chunks");
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

  test("--deadline-from with --sort deadline puts the next deadline first", async () => {
    const { stdout, code } = await runCli(root, ["search", "status", "--deadline-from", "2026-07-12", "--sort", "deadline", "--json"]);
    expect(code).toBe(0);
    const out = JSON.parse(stdout);
    expect(Array.isArray(out.warnings)).toBe(true);
    expect(out.results[0]?.path).toBe("projects/active/bookshelf/status.md");
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

describe("read", () => {
  test("prints the whole file with no flag", async () => {
    const { stdout, code } = await runCli(root, ["read", "me/identity.md"]);
    expect(code).toBe(0);
    expect(stdout).toBe(readFileSync(join(root, "me/identity.md"), "utf-8") + "\n");
  });

  test("--section prints that section and no other", async () => {
    const { stdout, code } = await runCli(root, ["read", "me/identity.md", "--section", "How to Work With Alex"]);
    expect(code).toBe(0);
    expect(stdout.startsWith("## How to Work With Alex\n")).toBe(true);
    expect(stdout).toContain("Prefer concrete, checklist-shaped guidance");
    expect(stdout).not.toContain("## Current Identity");
  });

  test("--max-tokens over the file's size prints the outline, not the body", async () => {
    const { stdout, code } = await runCli(root, ["read", "me/identity.md", "--max-tokens", "50"]);
    expect(code).toBe(0);
    expect(stdout).toContain("- ## Current Identity (~206 tokens)\n- ## How to Work With Alex (~63 tokens)\n");
    expect(stdout).toContain('--section "<heading>"');
    expect(stdout).not.toContain("Prefer concrete");
  });

  test("an unknown --section is a usage error naming the available headings", async () => {
    const { stderr, code } = await runCli(root, ["read", "me/identity.md", "--section", "No Such Heading"]);
    expect(code).toBe(1);
    expect(stderr).toContain('available headings: "Current Identity", "How to Work With Alex"');
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
  test("returns the { issues, errors, warnings, infos } envelope", async () => {
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
  });
  test("reports the fixture's one drifted fact, on long-bio.md (#392)", async () => {
    const { stdout } = await runCli(root, ["audit", "--json"]);
    const drift = (JSON.parse(stdout).issues as Array<{ category: string; path: string; message: string }>).filter(
      (i) => i.category === "fact-drift"
    );
    expect(drift).toEqual([
      expect.objectContaining({ path: "me/basics/long-bio.md", message: "ranger_since: found 2018, canonical 2019" }),
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
    const status = results.find((d) => d.path === "projects/active/bookshelf/status.md");
    expect(status?.deadline).toBe("2026-08-15");
    expect(results.some((d) => d.deadline === null)).toBe(true);
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
      const db = new Database(join(brain, "brain.db"));
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
  // Bare `brain sync` hands the whole workflow to the coding agent and prints
  // its final text. A stub runner stands in so nothing real is launched.
  test("prints the agent's text, not JSON", async () => {
    const brain = makeTempBrain({ empty: true });
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
      const { stdout, code } = await runCli(brain, ["sync"]);
      expect(code).toBe(0);
      expect(stdout).toBe("stub agent ran /sync\n");
      expect(() => JSON.parse(stdout)).toThrow();

      // An output flag is not a verb: it still takes the agent path and
      // still prints the agent's text, whatever mode it asks for.
      for (const flag of ["--json", "--human"]) {
        const flagged = await runCli(brain, ["sync", flag]);
        expect(flagged.code).toBe(0);
        expect(flagged.stdout).toBe("stub agent ran /sync\n");
      }

      const unknown = await runCli(brain, ["sync", "--not-a-flag"]);
      expect(unknown.code).toBe(1);
      expect(unknown.stderr).toContain("Unknown flag: --not-a-flag");
    } finally {
      cleanup(brain);
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
export default defineConfig({ modules: { "./modules/stub": {} } });
`
      );

      const { stdout, code } = await runCli(brain, ["module", "list", "--json"]);
      expect(code).toBe(0);
      const out = JSON.parse(stdout);
      expect(out.enabled).toHaveLength(1);
      const [mod] = out.enabled;
      expect(mod.name).toBe("stub");
      expect(mod.key).toBe("./modules/stub");
      expect(mod.description).toBe("A stub module");
      expect(mod.types).toEqual(["stubnote"]);
      expect(mod.commands).toEqual(["stub"]);
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
          { id: "scope", q: "telescope setup", class: "exact", expected: ["studies/telescope-setup.md"] },
          { id: "none", q: "telescope", class: "no-answer", expected: [] },
        ].map((q) => JSON.stringify(q)).join("\n")
      );
      const { stdout, code } = await runCli(root, ["eval", "--set", set, "--mode", "fts", "--json"]);
      expect(code).toBe(0);
      const out = JSON.parse(stdout);
      expect(Object.keys(out).sort()).toEqual(["meta", "per_query", "rows", "schema_version", "warnings"]);
      expect(out.schema_version).toBe(1);
      expect(Object.keys(out.meta).sort()).toEqual([
        "documents", "embedding_model", "k", "modes", "now", "pool", "queries",
        "rerank", "set", "set_sha256", "source", "version",
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
    }

    for (const field of ["brokenLinkRate", "embeddingCoverage"]) {
      // A ratio is a number or, when it cannot be known, null — never 0.
      expect(["number", "object"]).toContain(typeof out.health[field]);
    }
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
});
