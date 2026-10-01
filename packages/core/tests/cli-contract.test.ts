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
  // Bare `brain sync` runs the whole sync and hands the agent only what the
  // rules left — here a file nothing could classify. Human mode prints the
  // report, then the agent's text; machine mode one `{ run, agent }` result
  // (#290). A stub runner stands in so nothing real is launched.
  test("human mode: the report, then the agent's text; machine mode: one result", async () => {
    const brain = makeTempBrain({ empty: true });
    const remote = mkdtempSync(join(tmpdir(), "brain-contract-remote-"));
    const git = (...args: string[]) => {
      const result = Bun.spawnSync(["git", "-C", brain, ...args]);
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
      const human = await runCli(brain, ["sync", "--human"]);
      expect(human.code).toBe(0);
      expect(human.stdout).toStartWith("brain sync: complete\n");
      expect(human.stdout).toContain("  unknown: survey.xyz\n");
      expect(human.stdout).toEndWith("\nstub agent ran /sync\n");
      expect(() => JSON.parse(human.stdout)).toThrow();

      // …and `--json`, or a stdout that is not a terminal, the one result.
      for (const flags of [[], ["--json"]]) {
        const { stdout, code } = await runCli(brain, ["sync", ...flags]);
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

      const unknown = await runCli(brain, ["sync", "--not-a-flag"]);
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
