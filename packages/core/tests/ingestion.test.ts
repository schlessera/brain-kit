import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";

import { ingest, classifyContent } from "../src/lib/ingestion";
import { indexAll } from "../src/lib/indexer";
import { openDatabase } from "../src/lib/db";
import { buildTaxonomy } from "../src/lib/taxonomy";
import { brainConfigSchema } from "../src/lib/config";

const taxonomy = buildTaxonomy({
  user: brainConfigSchema.parse({
    taxonomy: {
      types: {
        health: { dir: "health" },
        project: { dir: "projects/active", match: ["projects/"], appendMatch: true },
      },
      classifierHints: {
        health: ["symptom", "appointment", "prescription", "blood pressure"],
      },
    },
  }),
});

const fixtures: string[] = [];
afterAll(() => {
  for (const dir of fixtures) rmSync(dir, { recursive: true, force: true });
});

function makeCorpus(files: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), "brain-kit-ingest-test-"));
  fixtures.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const full = join(root, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return root;
}

function doc(title: string, type: string, body = "body"): string {
  return [
    "---",
    `type: ${type}`,
    `title: ${title}`,
    'created: "2026-01-01"',
    'updated: "2026-01-02"',
    "tags: [test]",
    "---",
    "",
    body,
    "",
  ].join("\n");
}

describe("classifyContent", () => {
  test("classifies via a taxonomy classifier hint, else the inbox type", () => {
    const db = openDatabase(":memory:");
    expect(classifyContent("Renew my prescription today", db, taxonomy).type).toBe("health");
    expect(classifyContent("just some loose thought", db, taxonomy).type).toBe("note");
    db.close();
  });
});

describe("ingest", () => {
  test("rejects an explicit path that escapes the brain root", async () => {
    const root = makeCorpus();
    const db = openDatabase(":memory:");
    await expect(
      ingest({ content: "x", type: "note", path: "../evil.md" }, db, { root, taxonomy })
    ).rejects.toThrow(/escapes the brain root/);
    await expect(
      ingest({ content: "x", type: "note", path: "/tmp/evil.md" }, db, { root, taxonomy })
    ).rejects.toThrow(/escapes the brain root/);
    db.close();
  });

  test("creates a new file under the type's canonical directory", async () => {
    const root = makeCorpus();
    const db = openDatabase(join(root, "brain.db"));
    const out = await ingest({ content: "# Trail Notes\n\nSaw an owl.", type: "note" }, db, {
      root,
      taxonomy,
    });
    db.close();

    expect(out.action).toBe("created");
    expect(out.type).toBe("note");
    expect(out.path).toBe("notes/trail-notes.md");
    expect(out.indexed).toBe(true);
    const written = readFileSync(join(root, out.path), "utf-8");
    expect(written).toContain("title: Trail Notes");
    expect(written).toContain("Saw an owl.");
  });

  test("appends into an existing append-match document titled the same", async () => {
    const root = makeCorpus({
      "projects/active/bookshelf.md": doc("Bookshelf", "project", "Original plan."),
    });
    const db = openDatabase(join(root, "brain.db"));
    // Index so classifyContent can find the existing project by title.
    await indexAll(db, { root, taxonomy, quiet: true });

    const out = await ingest({ content: "Bookshelf\n\nAdded a top shelf." }, db, { root, taxonomy });
    db.close();

    expect(out.action).toBe("appended");
    expect(out.path).toBe("projects/active/bookshelf.md");
    const written = readFileSync(join(root, "projects/active/bookshelf.md"), "utf-8");
    expect(written).toContain("Original plan.");
    expect(written).toContain("Added a top shelf.");
    expect(written).toContain("Update"); // dated append heading
  });

  test("an append changes only `updated` in the frontmatter and keeps every other byte (#492)", async () => {
    const frontmatter = [
      "---",
      "# Kept by hand; brain add must not drop this line.",
      "type: project",
      'title: "Bookshelf"',
      "created: '2026-01-01' # first sketch",
      "updated: 2026-01-02",
      "tags: [woodwork, 'home']",
      "---",
    ];
    const original = [...frontmatter, "", "Original plan.", ""].join("\n");
    const root = makeCorpus({ "projects/active/bookshelf.md": original });
    const db = openDatabase(join(root, "brain.db"));
    await indexAll(db, { root, taxonomy, quiet: true });

    const out = await ingest({ content: "Bookshelf\n\nAdded a top shelf." }, db, { root, taxonomy });
    db.close();

    expect(out.action).toBe("appended");
    const written = readFileSync(join(root, "projects/active/bookshelf.md"), "utf-8");
    const date = written.match(/^updated: (\S+)$/m)?.[1] ?? "";
    expect(date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(date).not.toBe("2026-01-02");
    const expected = [
      ...frontmatter.map((line) => (line.startsWith("updated:") ? `updated: ${date}` : line)),
      "",
      "Original plan.",
      "",
      `## ${date} Update`,
      "",
      "Bookshelf",
      "",
      "Added a top shelf.",
      "",
    ].join("\n");
    expect(written).toBe(expected);
  });

  test("rejects an invalid explicit type with the valid list", async () => {
    const root = makeCorpus();
    const db = openDatabase(join(root, "brain.db"));
    await expect(
      ingest({ content: "x", type: "bogus" }, db, { root, taxonomy })
    ).rejects.toThrow('Invalid type "bogus"');
    db.close();
  });
});

describe("capture collisions", () => {
  test("distinct and repeated titles create separate documents, including Unicode and empty slugs", async () => {
    const root = makeCorpus();
    const db = openDatabase(join(root, "brain.db"));
    try {
      const titles = ["C++", "C#", "C++", "日本語", "中文", "!!!", "???", "é", "e\u0301"];
      const paths: string[] = [];
      for (const [i, title] of titles.entries()) {
        const result = await ingest({ content: `Separate body ${i}`, title, type: "note" }, db, { root, taxonomy });
        expect(result.action).toBe("created");
        expect(result.indexed).toBe(true);
        expect(result.title).toBe(title);
        expect(result.path).not.toBe("notes/.md");
        paths.push(result.path);
      }
      expect(new Set(paths).size).toBe(titles.length);
      expect(paths.slice(0, 3)).toEqual(["notes/c.md", "notes/c-2.md", "notes/c-3.md"]);
      for (const [i, path] of paths.entries()) {
        const body = readFileSync(join(root, path), "utf8");
        expect(body).toContain(`Separate body ${i}`);
        expect(body).not.toContain("## ");
      }
    } finally { db.close(); }
  });

  test("explicit title overrides do not append to the content's classified target", async () => {
    const original = doc("Bookshelf", "project", "Original plan.");
    const root = makeCorpus({ "projects/active/bookshelf.md": original });
    const db = openDatabase(join(root, "brain.db"));
    try {
      await indexAll(db, { root, taxonomy, quiet: true });
      const result = await ingest({ content: "Bookshelf\nDifferent project.", title: "Workbench" }, db, { root, taxonomy });
      expect(result.action).toBe("created");
      expect(result.path).toBe("projects/active/workbench.md");
      expect(readFileSync(join(root, "projects/active/bookshelf.md"), "utf8")).toBe(original);
    } finally { db.close(); }
  });

  test("a stale classified path cannot append to a renamed document", async () => {
    const root = makeCorpus({ "projects/active/bookshelf.md": doc("Bookshelf", "project") });
    const db = openDatabase(join(root, "brain.db"));
    try {
      await indexAll(db, { root, taxonomy, quiet: true });
      const replacement = doc("Workbench", "project", "Do not append here.");
      writeFileSync(join(root, "projects/active/bookshelf.md"), replacement);
      const result = await ingest({ content: "Bookshelf\nNew plan." }, db, { root, taxonomy });
      expect(result.action).toBe("created");
      expect(result.path).toBe("projects/active/bookshelf-2.md");
      expect(readFileSync(join(root, "projects/active/bookshelf.md"), "utf8")).toBe(replacement);
    } finally { db.close(); }
  });

  test("an explicit occupied path fails without replacing its contents", async () => {
    const root = makeCorpus({ "notes/existing.md": doc("Existing", "note", "Keep me.") });
    const before = readFileSync(join(root, "notes/existing.md"), "utf8");
    const db = openDatabase(":memory:");
    try {
      await expect(ingest({ content: "Replacement", path: "notes/existing.md" }, db, { root, taxonomy })).rejects.toThrow("already exists");
      expect(readFileSync(join(root, "notes/existing.md"), "utf8")).toBe(before);
    } finally { db.close(); }
  });
});
