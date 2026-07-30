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
  const root = mkdtempSync(join(tmpdir(), "endoxa-ingest-test-"));
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

  test("rejects an invalid explicit type with the valid list", async () => {
    const root = makeCorpus();
    const db = openDatabase(join(root, "brain.db"));
    await expect(
      ingest({ content: "x", type: "bogus" }, db, { root, taxonomy })
    ).rejects.toThrow('Invalid type "bogus"');
    db.close();
  });
});
