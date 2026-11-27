import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "fs";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";
import type { Database } from "bun:sqlite";
import * as frontmatter from "@schlessera/brain-common/internal/frontmatter";
import { openDatabase } from "../src/lib/db";
import { indexAll } from "../src/lib/indexer";
import * as links from "../src/lib/indexer/links";
import { buildTaxonomy, type Taxonomy } from "../src/lib/taxonomy";
import { countExecutions } from "./statement-counter";
import { cleanup, makeTempBrain, runCli } from "./cli-harness";

// A complete run reads and hashes every markdown file, and parses only the
// files whose bytes or chunker version changed (#4781). The titles and aliases
// of the files it did not parse come from the index, so link resolution sees
// the corpus a full parse would.
const taxonomy = buildTaxonomy({ user: null });
const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

const note = (title: string, body: string, extra = "") =>
  `---\ntitle: ${title}\ntype: note\ncreated: "2026-07-01"\nupdated: "2026-07-12"\n${extra}---\n${body}\n`;

function brain(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "brain-index-parse-skip-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  for (const [path, text] of Object.entries(files)) write(root, path, text);
  return root;
}
function write(root: string, path: string, text: string) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}
function open(root: string, name: string): Database {
  const db = openDatabase(join(root, ".brain-index", `${name}.db`));
  cleanups.push(() => db.close());
  return db;
}
const options = (root: string, tax: Taxonomy = taxonomy) => ({ root, taxonomy: tax, quiet: true });

/** Count the frontmatter parses `run` performs; the spy is gone when it returns. */
async function countParses<T>(run: () => Promise<T>): Promise<{ result: T; parses: number }> {
  const original = frontmatter.parseFrontmatter;
  const spy = spyOn(frontmatter, "parseFrontmatter").mockImplementation(((...args: Parameters<typeof original>) =>
    original(...args)) as typeof original);
  try {
    const result = await run();
    return { result, parses: spy.mock.calls.length };
  } finally {
    spy.mockRestore();
  }
}

/** The corpus maps a run resolves links with: what the resolver and the alias lookup were given. */
async function captureMaps<T>(run: () => Promise<T>) {
  const createResolver = links.createWikiLinkResolver;
  const lookupAlias = links.resolveAlias;
  let fileMap: Map<string, string> | undefined;
  let aliasMap: Map<string, string[]> | undefined;
  const spies = [
    spyOn(links, "createWikiLinkResolver").mockImplementation(((map: Map<string, string>, ...rest: unknown[]) => {
      fileMap = map;
      return (createResolver as (...args: unknown[]) => ReturnType<typeof createResolver>)(map, ...rest);
    }) as typeof createResolver),
    spyOn(links, "resolveAlias").mockImplementation(((target: string, map: Map<string, string[]>, source?: string) => {
      aliasMap = map;
      return lookupAlias(target, map, source);
    }) as typeof lookupAlias),
  ];
  try {
    await run();
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
  return { fileMap: [...(fileMap ?? [])], aliasMap: [...(aliasMap ?? [])] };
}

/** The tables link resolution writes, as content keyed by path. */
function resolved(db: Database) {
  const rows = (sql: string) => db.prepare(sql).all();
  return {
    links: rows(`SELECT s.path AS source, l.target, t.path AS resolved FROM links l JOIN documents s ON s.id = l.source_id
      LEFT JOIN documents t ON t.id = l.target_id ORDER BY source, l.target`),
    supersedes: rows(`SELECT s.path AS source, x.target, t.path AS resolved FROM supersedes x JOIN documents s ON s.id = x.source_id
      LEFT JOIN documents t ON t.id = x.target_id ORDER BY source, x.target`),
    nameKeys: rows("SELECT k.key, d.path FROM name_keys k JOIN documents d ON d.id = k.document_id ORDER BY k.key, d.path"),
  };
}

const CORPUS = {
  "notes/calypso.md": note("Calypso", "Keeps [[Nymph of Ogygia]] company.", "aliases: [Nymph of Ogygia, The Island]\n"),
  "notes/odysseus.md": note("Odysseus", "Sails from [[The Island]] to [[ithaca]].", "aliases: [Ulysses]\n"),
  "notes/ithaca.md": note("Ithaca", "Home of [[Ulysses]].", "supersedes: [\"[[old-ithaca]]\"]\n"),
  "notes/old-ithaca.md": note("Old Ithaca", "Before the war."),
  "notes/raft.md": note("Raft", "Built on [[The Island]] for [[nowhere]]."),
};

describe("unchanged files are read and hashed, not parsed (#4781)", () => {
  test("a second complete run over an unchanged corpus parses no frontmatter", async () => {
    const root = brain(CORPUS);
    const db = open(root, "brain");
    expect((await countParses(() => indexAll(db, options(root)))).parses).toBe(5);
    const { result, parses } = await countParses(() => indexAll(db, options(root)));
    expect(result.unchanged).toBe(5);
    expect(parses).toBe(0);
  });

  test("the run still reads every markdown file once", async () => {
    const root = brain(CORPUS);
    const db = open(root, "brain");
    await indexAll(db, options(root));
    const readFileSync = fs.readFileSync;
    const reads: string[] = [];
    const spy = spyOn(fs, "readFileSync").mockImplementation(((path: unknown, ...rest: unknown[]) => {
      if (typeof path === "string" && path.endsWith(".md")) reads.push(resolve(path));
      return (readFileSync as (...a: unknown[]) => unknown)(path, ...rest);
    }) as typeof fs.readFileSync);
    try {
      expect((await indexAll(db, options(root))).unchanged).toBe(5);
    } finally {
      spy.mockRestore();
    }
    expect(reads.sort()).toEqual(Object.keys(CORPUS).map((path) => resolve(root, path)).sort());
  });

  test("the corpus maps and what they resolve equal a full parse", async () => {
    const root = brain(CORPUS);
    const db = open(root, "brain");
    await indexAll(db, options(root));
    // One parsed file claims an alias an unparsed file also claims.
    write(root, "notes/raft.md", note("Raft", "Built on [[The Island]] for [[nowhere]].", "aliases: [The Island]\n"));
    const skipping = await captureMaps(() => indexAll(db, options(root)));
    const skipped = resolved(db);
    const full = open(root, "full");
    const parsing = await captureMaps(() => indexAll(full, { ...options(root), force: true }));
    expect(skipped.links).toContainEqual({ source: "notes/calypso.md", target: "Nymph of Ogygia", resolved: "notes/calypso.md" });
    expect(skipped.links).toContainEqual({ source: "notes/ithaca.md", target: "Ulysses", resolved: "notes/odysseus.md" });
    expect(skipped).toEqual(resolved(full));
    expect(skipping).toEqual(parsing);
    expect(skipping.aliasMap).toContainEqual(["the island", ["notes/calypso.md", "notes/raft.md"]]);
  });

  test("the retrieval goldens hold after a run that parsed nothing", async () => {
    const root = makeTempBrain();
    cleanups.push(() => cleanup(root));
    expect((await runCli(root, ["index", "--json"])).code).toBe(0);
    const again = await runCli(root, ["index", "--json"]);
    expect(again.code).toBe(0);
    const stats = JSON.parse(again.stdout);
    expect([stats.added, stats.updated, stats.unchanged]).toEqual([0, 0, stats.total]);
    const run = await runCli(root, ["eval", "--mode", "fts", "--rerank", "heuristic", "--json"]);
    expect(run.code).toBe(0);
    const goldens = JSON.parse(readFileSync(join(root, "evals/expected-ranks.json"), "utf-8")) as
      Record<string, { rank: number | null; current_first?: boolean; top?: string[] }>;
    const outcomes = (JSON.parse(run.stdout).per_query as { id: string; rank: number | null; current_first: boolean | null; top: string[] }[]);
    expect(outcomes.map((o) => o.id).sort()).toEqual(Object.keys(goldens).sort());
    const scored = outcomes.map((o) => {
      const golden = goldens[o.id];
      return {
        id: o.id,
        rank: o.rank,
        ...(golden.current_first !== undefined ? { current_first: o.current_first } : {}),
        ...(golden.top !== undefined ? { top: o.top.slice(0, golden.top.length) } : {}),
      };
    });
    expect(scored).toEqual(outcomes.map((o) => ({ id: o.id, ...goldens[o.id] })));
  }, 60_000);

  test("an edit that keeps a file's size and modification time is still indexed", async () => {
    const root = brain(CORPUS);
    const path = join(root, "notes/old-ithaca.md");
    // A whole second, so restoring it after the edit is exact on any filesystem.
    utimesSync(path, 1_783_828_800, 1_783_828_800);
    const db = open(root, "brain");
    await indexAll(db, options(root));
    const before = statSync(path, { bigint: true });
    writeFileSync(path, note("Old Ithaca", "Before the waR."));
    utimesSync(path, 1_783_828_800, 1_783_828_800);
    const after = statSync(path, { bigint: true });
    expect(after.size).toBe(before.size);
    expect(after.mtimeNs).toBe(before.mtimeNs);
    expect((await indexAll(db, options(root))).updated).toBe(1);
    expect((db.prepare("SELECT content FROM documents WHERE path = 'notes/old-ithaca.md'").get() as { content: string }).content)
      .toContain("Before the waR.");
  });

  test("a cleared hash, an older chunker and a full-text rebuild still parse what they must", async () => {
    const root = brain(CORPUS);
    const db = open(root, "brain");
    await indexAll(db, options(root));
    db.run("UPDATE documents SET content_hash = NULL WHERE asset_type = 'markdown'");
    let run = await countParses(() => indexAll(db, options(root)));
    expect([run.parses, run.result.updated]).toEqual([5, 5]);
    db.run("UPDATE documents SET chunker_version = chunker_version - 1 WHERE path = 'notes/raft.md'");
    run = await countParses(() => indexAll(db, options(root)));
    expect([run.parses, run.result.updated, run.result.unchanged]).toEqual([1, 1, 4]);
    const none = buildTaxonomy({ user: { search: { language: "none" } } });
    run = await countParses(() => indexAll(db, options(root, none)));
    expect([run.parses, run.result.updated]).toEqual([5, 5]);
    expect((await countParses(() => indexAll(db, options(root, none)))).parses).toBe(0);
  });

  test("a file whose frontmatter became invalid is skipped with its warning and keeps its row", async () => {
    const root = brain(CORPUS);
    const db = open(root, "brain");
    await indexAll(db, options(root));
    write(root, "notes/raft.md", "---\ntitle: [unclosed\n---\nBroken.\n");
    const warnings: string[] = [];
    const warn = spyOn(console, "warn").mockImplementation((...args: unknown[]) => { warnings.push(args.map(String).join(" ")); });
    try {
      await indexAll(db, { ...options(root), quiet: false });
    } finally {
      warn.mockRestore();
    }
    expect(warnings.some((line) => line.includes("SKIP: notes/raft.md — invalid frontmatter"))).toBe(true);
    expect(db.prepare("SELECT title FROM documents WHERE path = 'notes/raft.md'").get()).toEqual({ title: "Raft" });
  });

  test("an unchanged complete run executes as many statements on 200 notes as on 20", async () => {
    const executions = async (size: number) => {
      const files: Record<string, string> = {};
      for (let i = 0; i < size; i++) files[`notes/n${String(i).padStart(3, "0")}.md`] = note(`Note ${i}`, `Body ${i}.`, `aliases: [Alias ${i}]\n`);
      const root = brain(files);
      const db = open(root, "brain");
      await indexAll(db, options(root));
      const counter = countExecutions(db);
      try {
        expect((await indexAll(db, options(root))).unchanged).toBe(size);
      } finally {
        counter.restore();
      }
      return counter.count();
    };
    const small = await executions(20);
    expect(await executions(200)).toBe(small);
  });

  test("an alias with a line break reads back as a targeted run reads it", async () => {
    const root = brain({
      ...CORPUS,
      "notes/penelope.md": note("Penelope", "Weaves.", "aliases: [\"Weaver\\nof Ithaca\"]\n"),
    });
    const db = open(root, "brain");
    await indexAll(db, options(root));
    const skipping = await captureMaps(() => indexAll(db, options(root)));
    write(root, "notes/raft.md", note("Raft", "Built on [[The Island]] for [[nowhere]] again."));
    const targeted = await captureMaps(() => indexAll(db, { ...options(root), paths: ["notes/raft.md"] }));
    expect(skipping.aliasMap).toEqual(targeted.aliasMap);
    expect(skipping.aliasMap).toContainEqual(["weaver", ["notes/penelope.md"]]);
    expect(skipping.aliasMap).toContainEqual(["of ithaca", ["notes/penelope.md"]]);
  });
});
