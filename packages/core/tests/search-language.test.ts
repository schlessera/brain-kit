/**
 * `search.language` (#421): the full-text tokenizer and the query's stopwords
 * change together, and switching rebuilds the full-text table on the next
 * `brain index` without touching chunks or vectors.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

import { cleanup, makeTempBrain, runCli } from "./cli-harness";

const roots: string[] = [];
afterAll(() => roots.forEach(cleanup));

/** A German note: "was" is a content word here, and an English stopword. */
const GERMAN = [
  "---",
  "type: note",
  "title: Himmelsbeobachtung",
  'created: "2026-01-01"',
  'updated: "2026-01-02"',
  "---",
  "",
  "Was am Nachthimmel zu sehen war, notiert nach jeder Nacht am Fernrohr.",
  "",
].join("\n");

function brain(language?: "english" | "none"): string {
  const root = makeTempBrain();
  roots.push(root);
  writeFileSync(join(root, "notes/himmel.md"), GERMAN);
  if (language) setLanguage(root, language);
  return root;
}

function setLanguage(root: string, language: "english" | "none"): void {
  const path = join(root, "brain.config.ts");
  const config = readFileSync(path, "utf8").replace(/\n  search: \{ language: "\w+" \},/, "");
  writeFileSync(path, config.replace(/\n\}\);\s*$/, `\n  search: { language: "${language}" },\n});\n`));
}

function tokenizer(root: string): string {
  const db = new Database(join(root, "brain.db"), { readonly: true });
  const { sql } = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'documents_fts'").get() as { sql: string };
  db.close();
  return sql.match(/tokenize='([^']*)'/)![1];
}

async function paths(root: string, query: string): Promise<string[]> {
  const r = await runCli(root, ["search", query, "--mode", "fts", "--limit", "50", "--json"]);
  expect(r.code).toBe(0);
  return (JSON.parse(r.stdout).results as Array<{ path: string }>).map((x) => x.path);
}

describe("search.language", () => {
  test('with "none" an English stopword that is a content word elsewhere finds its document; the default does not', async () => {
    const none = brain("none");
    expect((await runCli(none, ["index", "--json"])).code).toBe(0);
    const english = brain();
    expect((await runCli(english, ["index", "--json"])).code).toBe(0);

    // "telescope" keeps both queries non-empty; "was" is the difference.
    const withNone = await paths(none, "was telescope");
    const withDefault = await paths(english, "was telescope");
    expect(withDefault.length).toBeGreaterThan(0);
    expect(withNone).toContain("notes/himmel.md");
    expect(withDefault).not.toContain("notes/himmel.md");
  }, 120_000);

  test("switching rebuilds the full-text table on the next index, keeps chunks, and --force reproduces it", async () => {
    const root = brain();
    await runCli(root, ["index", "--json"]);
    expect(tokenizer(root)).toBe("porter unicode61");
    const chunkIds = () => {
      const db = new Database(join(root, "brain.db"), { readonly: true });
      const ids = db.prepare("SELECT id FROM chunks ORDER BY id").all();
      const counts = db.prepare("SELECT (SELECT COUNT(*) FROM documents) AS docs, (SELECT COUNT(*) FROM documents_fts) AS fts").get();
      db.close();
      return { ids, counts };
    };
    const before = chunkIds();

    setLanguage(root, "none");
    const doctorBefore = JSON.parse((await runCli(root, ["doctor", "--json"])).stdout).checks.find(
      (c: { id: string }) => c.id === "search-language"
    );
    expect(doctorBefore).toMatchObject({ status: "warn" });

    const human = await runCli(root, ["index", "--human"]);
    expect(human.code).toBe(0);
    expect(tokenizer(root)).toBe("unicode61 remove_diacritics 2");
    expect(human.stdout).toContain('Full-text index rebuilt for search.language "none"');
    const after = chunkIds();
    expect(after.ids).toEqual(before.ids);
    expect(after.counts).toEqual(before.counts);

    const doctorAfter = JSON.parse((await runCli(root, ["doctor", "--json"])).stdout).checks.find(
      (c: { id: string }) => c.id === "search-language"
    );
    expect(doctorAfter).toMatchObject({ status: "pass" });

    await runCli(root, ["index", "--force", "--json"]);
    expect(tokenizer(root)).toBe("unicode61 remove_diacritics 2");
    expect(chunkIds().counts).toEqual(before.counts);
  }, 180_000);

  test("an unknown language fails config validation", async () => {
    const root = brain();
    const path = join(root, "brain.config.ts");
    writeFileSync(path, readFileSync(path, "utf8").replace(/\n\}\);\s*$/, '\n  search: { language: "german" },\n});\n'));
    const r = await runCli(root, ["index", "--json"]);
    expect(r.code).not.toBe(0);
    expect(r.stdout + r.stderr).toContain("search.language");
  }, 60_000);
});
