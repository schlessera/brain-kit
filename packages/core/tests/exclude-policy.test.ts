import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";

import { loadUserConfig, type BrainConfig } from "../src/lib/config";
import { openDatabase } from "../src/lib/db";
import { indexAll } from "../src/lib/indexer";
import { collectStats } from "../src/lib/stats";
import { buildTaxonomy } from "../src/lib/taxonomy";
import { runCli } from "./cli-harness";

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "brain-exclude-policy-"));
  roots.push(root);
  return root;
}

describe("exclude.files configuration loading", () => {
  for (const format of ["json", "ts"] as const) {
    const save = (root: string, files: string[]) => {
      const config = JSON.stringify({ exclude: { files } });
      writeFileSync(join(root, `brain.config.${format}`), format === "ts" ? `export default ${config};\n` : config);
    };

    test(`${format} loading rejects a trailing slash with the field, value and correction`, async () => {
      const root = fixture();
      save(root, ["notes/keep.md", "drafts/"]);
      await expect(loadUserConfig(root)).rejects.toThrow(/exclude\.files\.1:.*"drafts\/".*exclude\.dirs/);
    });

    test(`${format} loading preserves valid exact file paths`, async () => {
      const root = fixture();
      const files = ["notes/keep.md", "drafts"];
      save(root, files);
      expect((await loadUserConfig(root)).config?.exclude?.files).toEqual(files);
    });

    for (const command of ["index", "stats"]) {
      test(`${format} ${command} rejects the invalid config before creating an index`, async () => {
        const root = fixture();
        save(root, ["drafts/"]);
        mkdirSync(join(root, "drafts"));
        writeFileSync(join(root, "drafts/a.md"), "A nonempty note.\n");
        const result = await runCli(root, [command, "--json"]);
        expect(result.code).not.toBe(0);
        expect(result.stderr + result.stdout).toMatch(/exclude\.files\.0:.*"drafts\/".*exclude\.dirs/);
        expect(existsSync(join(root, "brain.db"))).toBe(false);
      });
    }
  }
});

describe("directory pruning agrees with actual indexing", () => {
  const paths = [
    "notes/keep.md", "notes/drop.md", "drafts/a.md", "drafts/deep/b.md",
    "drafts/private/drop.md", "drafts-old/keep.md", "private/drop.md", "notes/private/drop.md",
  ];
  const cases: { name: string; exclude: BrainConfig["exclude"]; kept: string[] }[] = [
    {
      name: "programmatic trailing-slash exact file rules cannot prune directories",
      exclude: { files: ["drafts/", "drafts", "notes/drop.md"] },
      kept: paths.filter((p) => p !== "notes/drop.md"),
    },
    {
      name: "valid exact file rules remove only their named file",
      exclude: { files: ["drafts/a.md"] },
      kept: paths.filter((p) => p !== "drafts/a.md"),
    },
    {
      name: "normalized nested directory rules preserve whole-prefix matching",
      exclude: { dirs: ["./drafts/private/", "./private/"] },
      kept: paths.filter((p) => !p.startsWith("drafts/private/") && !p.startsWith("private/")),
    },
    {
      name: "segment rules exclude root and nested directories",
      exclude: { segments: ["private"] },
      kept: paths.filter((p) => !p.split("/").includes("private")),
    },
    {
      name: "segment rules do not exclude a file whose basename matches",
      exclude: { segments: ["drop.md"] },
      kept: paths,
    },
  ];

  for (const { name, exclude, kept } of cases) {
    test(name, async () => {
      const root = fixture();
      const contents = new Map(paths.map((path, i) => [path, `---\ntitle: Fixture ${i}\ntype: note\n---\n\n${"x".repeat(2 ** i)}\n`]));
      for (const [path, content] of contents) {
        mkdirSync(dirname(join(root, path)), { recursive: true });
        writeFileSync(join(root, path), content);
      }
      // Bypass schema validation deliberately: directory pruning must protect
      // in-process callers independently of the config-loading guard.
      const taxonomy = buildTaxonomy({ user: { exclude } });
      const dbPath = join(root, "brain.db");
      const db = openDatabase(dbPath);
      try {
        await indexAll(db, { root, taxonomy, quiet: true });
        const indexed = (db.query("SELECT path FROM documents ORDER BY path").all() as { path: string }[]).map((row) => row.path);
        expect(kept.length).toBeGreaterThan(0);
        expect(indexed).toEqual([...kept].sort());
        const bytes = kept.reduce((sum, path) => sum + Buffer.byteLength(contents.get(path)!), 0);
        expect(bytes).toBeGreaterThan(0);
        const stats = await collectStats(db, { root, dbPath, taxonomy, config: null });
        expect(stats.documents).toBe(kept.length);
        expect(stats.size.corpus).toEqual({ files: kept.length, bytes });
      } finally {
        db.close();
      }
    });
  }
});
