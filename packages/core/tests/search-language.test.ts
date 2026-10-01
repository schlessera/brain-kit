/**
 * `search.language` (#421): the full-text tokenizer and the query's stopwords
 * change together, and switching rebuilds the full-text table on the next
 * `brain index` without touching chunks or vectors.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

import { cleanup, makeTempBrain, runCli } from "./cli-harness";
import { embedTempBrain, loadVec, vecAvailable } from "./vec-fixture";

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

/** What a switch must leave alone or complete: the table's tokenizer, its metadata, and its row count against the documents. */
async function state(root: string): Promise<{ tokenizer: string; meta: string | null; docs: number; fts: number }> {
  const db = new Database(join(root, "brain.db"), { readonly: true });
  try {
    const meta = db.prepare("SELECT value FROM index_metadata WHERE key = 'fts_tokenizer'").get() as { value: string } | null;
    const counts = db
      .prepare("SELECT (SELECT COUNT(*) FROM documents) AS docs, (SELECT COUNT(*) FROM documents_fts) AS fts")
      .get() as { docs: number; fts: number };
    return { tokenizer: tokenizer(root), meta: meta?.value ?? null, ...counts };
  } finally {
    db.close();
  }
}

/** Make every document write fail, as a crash in the middle of the persist phase would. */
function failWrites(root: string, fail: boolean): void {
  const db = new Database(join(root, "brain.db"));
  db.run(
    fail
      ? "CREATE TRIGGER fail_writes BEFORE UPDATE ON documents BEGIN SELECT RAISE(ABORT, 'injected failure'); END"
      : "DROP TRIGGER fail_writes"
  );
  db.close();
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

    // "star guide" keeps both queries non-empty; "was" is the difference.
    const withNone = await paths(none, "was star guide");
    const withDefault = await paths(english, "was star guide");
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
      const counts = db.prepare("SELECT (SELECT COUNT(*) FROM documents) AS docs, (SELECT COUNT(*) FROM documents_fts) AS fts").get() as { docs: number; fts: number };
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

    const force = await runCli(root, ["index", "--force", "--json"]);
    expect(force.code).toBe(0);
    expect(JSON.parse(force.stdout).updated + JSON.parse(force.stdout).added).toBeGreaterThan(0);
    expect(await state(root)).toMatchObject({
      tokenizer: "unicode61 remove_diacritics 2",
      meta: "unicode61 remove_diacritics 2",
      fts: before.counts.fts,
    });
  }, 180_000);

  test("the chunk full-text table follows the switch too, and stays whole", async () => {
    const root = brain();
    await runCli(root, ["index", "--json"]);
    const chunkTable = () => {
      const db = new Database(join(root, "brain.db"), { readonly: true });
      const { sql } = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'chunks_fts'").get() as { sql: string };
      db.close();
      return sql.match(/tokenize='([^']*)'/)![1];
    };
    expect(chunkTable()).toBe("porter unicode61");
    // Porter stems "orientations" and the corpus's "orientation" alike.
    expect((await paths(root, "orientations")).length).toBeGreaterThan(0);

    setLanguage(root, "none");
    expect((await runCli(root, ["index", "--json"])).code).toBe(0);
    expect(chunkTable()).toBe("unicode61 remove_diacritics 2");
    // Without a stemmer, no table matches the plural any more.
    expect(await paths(root, "orientations")).toEqual([]);
    expect((await paths(root, "orientation")).length).toBeGreaterThan(0);
    const db = new Database(join(root, "brain.db"));
    db.run("INSERT INTO chunks_fts(chunks_fts, rank) VALUES ('integrity-check', 1)");
    db.close();
  }, 180_000);

  test("a switch that fails part-way leaves the old table, its rows and its metadata whole", async () => {
    const root = brain();
    expect((await runCli(root, ["index", "--json"])).code).toBe(0);
    const english = await state(root);
    expect(english).toMatchObject({ tokenizer: "porter unicode61", meta: "porter unicode61" });
    expect(english.fts).toBe(english.docs);

    setLanguage(root, "none");
    failWrites(root, true);
    expect((await runCli(root, ["index", "--json"])).code).not.toBe(0);
    expect(await state(root)).toEqual(english);
  }, 180_000);

  test("the run after a failed switch completes it, every document back in the table", async () => {
    const root = brain();
    await runCli(root, ["index", "--json"]);
    setLanguage(root, "none");
    failWrites(root, true);
    await runCli(root, ["index", "--json"]);
    failWrites(root, false);

    expect((await runCli(root, ["index", "--json"])).code).toBe(0);
    const after = await state(root);
    expect(after).toMatchObject({ tokenizer: "unicode61 remove_diacritics 2", meta: "unicode61 remove_diacritics 2" });
    expect(after.fts).toBe(after.docs);
    expect(await paths(root, "Fernrohr")).toContain("notes/himmel.md");
  }, 180_000);

  test("a document the switching run cannot read stays searchable", async () => {
    // Root reads anything; the case only exists for a normal user.
    if (process.getuid?.() === 0) return;
    const root = brain();
    await runCli(root, ["index", "--json"]);
    setLanguage(root, "none");
    const note = join(root, "notes/himmel.md");
    chmodSync(note, 0o000);
    try {
      expect((await runCli(root, ["index", "--json"])).code).toBe(0);
      const after = await state(root);
      expect(after.tokenizer).toBe("unicode61 remove_diacritics 2");
      expect(after.fts).toBe(after.docs);
      expect(await paths(root, "Fernrohr")).toContain("notes/himmel.md");
    } finally {
      chmodSync(note, 0o644);
    }
  }, 180_000);

  test("an unreadable document keeps its aliases and tag order through a switch, and after it is readable again", async () => {
    // Root reads anything; the case only exists for a normal user.
    if (process.getuid?.() === 0) return;
    const root = brain();
    await runCli(root, ["index", "--json"]);
    const scope = "studies/star-bearings.md"; // aliases ["my bearings", "the Calypso guide", "the bearingbook"]
    const plan = "projects/active/raft/plan.md"; // tags [project, shipbuilding, raft, plan]
    const found = async () => ({
      alias: (await paths(root, "bearingbook")).includes(scope),
      phrase: (await paths(root, '"project shipbuilding"')).includes(plan),
    });
    expect(await found()).toEqual({ alias: true, phrase: true }); // the premise

    setLanguage(root, "none");
    const files = [scope, plan].map((path) => join(root, path));
    for (const file of files) chmodSync(file, 0o000);
    try {
      expect((await runCli(root, ["index", "--json"])).code).toBe(0);
      expect(tokenizer(root)).toBe("unicode61 remove_diacritics 2");
      expect(await found()).toEqual({ alias: true, phrase: true });
    } finally {
      for (const file of files) chmodSync(file, 0o644);
    }
    // Readable again, and unchanged, the next run skips it: what it kept is what it has.
    expect((await runCli(root, ["index", "--json"])).code).toBe(0);
    expect(await found()).toEqual({ alias: true, phrase: true });
  }, 180_000);

  test.skipIf(!vecAvailable)("a switch keeps every vector and chunk context", async () => {
    const root = brain();
    expect(await embedTempBrain(root)).toBeGreaterThan(0);
    const db = new Database(join(root, "brain.db"));
    db.run("UPDATE chunks SET context = 'context ' || id");
    db.close();
    const kept = async () => {
      const db = new Database(join(root, "brain.db"), { readonly: true });
      await loadVec(db);
      const vectors = (db.prepare("SELECT COUNT(*) AS n FROM vec_chunks").get() as { n: number }).n;
      const contexts = db.prepare("SELECT id, context FROM chunks ORDER BY id").all();
      db.close();
      return { vectors, contexts };
    };
    const before = await kept();
    expect(before.vectors).toBeGreaterThan(0);
    expect(before.contexts.length).toBeGreaterThan(0);

    setLanguage(root, "none");
    expect((await runCli(root, ["index", "--json"])).code).toBe(0);
    expect(tokenizer(root)).toBe("unicode61 remove_diacritics 2");
    expect(await kept()).toEqual(before);
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
