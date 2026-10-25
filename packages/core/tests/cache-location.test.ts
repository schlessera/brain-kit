/**
 * The committed generated-text caches live in `.brain-cache/` (#2725). A
 * clone from before 0.44.0 keeps every line it committed at the old
 * root-level names: reads union both files, and the first write moves the old
 * lines into the new file. The move is idempotent, keeps union-merged lines,
 * and survives a merge with a clone that still writes the old names.
 */
import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { ASSET_CACHE_PATH, CACHE_DIR, CONTEXT_CACHE_PATH } from "@schlessera/brain-common/internal/cache-location";

import { chunkContextKey, indexAll } from "../src/lib/indexer";
import { forgetContextEntries, loadAssetCache, loadContextCache, migrateSidecarCaches } from "../src/lib/indexer/caches";
import { classifyPostSyncDirt, workingTreeDirt } from "../src/lib/sync/assess";
import { migrateVecSchema, openDatabase } from "../src/lib/db";
import { buildTaxonomy } from "../src/lib/taxonomy";
import type { EmbeddingProvider } from "../src/lib/seams";
import type { Enrichment } from "../src/lib/enrichment";
import { vecAvailable } from "./vec-fixture";
import { makeTempBrain, runCli } from "./cli-harness";
import { brainWithRemote, cleanupFixtures, git, write } from "./sync-fixture";

const DIM = 16;
const taxonomy = buildTaxonomy({ user: null });
const OLD_CONTEXTS = ".context-cache.jsonl";
const OLD_ASSETS = ".asset-cache.jsonl";
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  cleanupFixtures();
});

function brain(files: Record<string, string | Buffer> = {}): string {
  const root = mkdtempSync(join(tmpdir(), "brain-cache-location-"));
  dirs.push(root);
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), content);
  }
  return root;
}

const read = (root: string, rel: string) => readFileSync(join(root, rel), "utf8");

/** Ithaca's harbour log, in sections big enough to stay chunks of their own. */
function harbourLog(): string {
  const sections = ["moorings", "beacons"].flatMap((word) => [`## About ${word}`, "", `${word} `.repeat(120).trim(), ""]);
  return ["---", "type: note", "title: Ithaca harbour log", 'created: "2026-07-12"', 'updated: "2026-07-12"', "---", "", ...sections].join("\n");
}

function provider(): EmbeddingProvider {
  const vector = (seed: number) => Float32Array.from({ length: DIM }, (_, i) => ((seed * 31 + i * 7) % 97) / 97);
  return {
    id: "fake:v1",
    dimensions: DIM,
    async embed(texts) { return texts.map((t, i) => vector(t.length + i)); },
    async embedQuery(text) { return vector(text.length); },
    async embedImage(_buffer, _mime, description) { return vector(description.length + 1); },
    async embedPdf(_buffer, description) { return vector(description.length + 2); },
  };
}

/** A fake model that counts every paid call, so a reused cache line shows as none. */
function enrichment(): { enrichment: Enrichment; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    enrichment: {
      async describeAsset(_buffer, _mime, context) { calls.push(`describe ${context}`); return `Penelope's description of ${context}`; },
      async generateChunkContext(_title, _text, heading) { calls.push(`context ${heading}`); return `Penelope's context for ${heading}`; },
    },
  };
}

async function embeddingsRun(root: string, model: Enrichment): Promise<void> {
  const db = openDatabase(join(root, ".brain-index", "brain.db"), { embeddingDimensions: DIM });
  if (vecAvailable) await migrateVecSchema(db, DIM);
  await indexAll(db, { root, taxonomy, quiet: true, embeddings: true, provider: provider(), enrichment: model });
  db.close();
}

test("an embeddings run writes both caches into .brain-cache/ and nothing into the root", async () => {
  const root = brain({ "notes/harbour.md": harbourLog(), "assets/ithaca.png": PNG });
  await embeddingsRun(root, enrichment().enrichment);
  expect(read(root, CONTEXT_CACHE_PATH).trim(), "CONTEXTS_IN_CACHE_DIRECTORY").not.toBe("");
  expect(read(root, ASSET_CACHE_PATH).trim(), "ASSETS_IN_CACHE_DIRECTORY").not.toBe("");
  for (const name of [OLD_CONTEXTS, OLD_ASSETS]) expect(existsSync(join(root, name)), `NO_ROOT_LEVEL_${name}`).toBe(false);
});

test("an existing clone keeps its cached contexts and asset descriptions after the move: no paid call is repeated", async () => {
  // A clone from before 0.44.0: the caches committed at the root, and no
  // index (a fresh clone, or a migrated brain whose index was rebuilt).
  const root = brain({ "notes/harbour.md": harbourLog(), "assets/ithaca.png": PNG });
  const first = enrichment();
  await embeddingsRun(root, first.enrichment);
  expect(first.calls.length, "FIRST_RUN_PAID_FOR_ENRICHMENT").toBeGreaterThan(0);
  const contexts = read(root, CONTEXT_CACHE_PATH), assets = read(root, ASSET_CACHE_PATH);
  renameSync(join(root, CONTEXT_CACHE_PATH), join(root, OLD_CONTEXTS));
  renameSync(join(root, ASSET_CACHE_PATH), join(root, OLD_ASSETS));
  rmSync(join(root, CACHE_DIR), { recursive: true });
  rmSync(join(root, ".brain-index"), { recursive: true });

  // Read before any write: both locations count.
  expect(loadContextCache(root).size, "LEGACY_CONTEXTS_READ_BEFORE_THE_MOVE").toBe(contexts.trim().split("\n").length);
  expect(loadAssetCache(root).size, "LEGACY_ASSETS_READ_BEFORE_THE_MOVE").toBe(1);

  const second = enrichment();
  await embeddingsRun(root, second.enrichment);
  expect(second.calls, "NO_PAID_CALL_REPEATED_AFTER_THE_MOVE").toEqual([]);
  expect(read(root, CONTEXT_CACHE_PATH), "CONTEXT_LINES_MOVED_BYTE_FOR_BYTE").toBe(contexts);
  expect(read(root, ASSET_CACHE_PATH), "ASSET_LINES_MOVED_BYTE_FOR_BYTE").toBe(assets);
  for (const name of [OLD_CONTEXTS, OLD_ASSETS]) expect(existsSync(join(root, name)), `LEGACY_${name}_REMOVED`).toBe(false);
});

/** A union-merged legacy file: unsorted, a key held twice with different text, and a line no reader accepts. */
const UNION_MERGED = ['{"k":"oar","v":"from Ithaca"}', '{"k":"loom","v":"Penelope weaves"}', '{"k":"oar","v":"from Ogygia"}', "not json at all"];

test.each([
  ["old-only", null, UNION_MERGED],
  ["new-only", ['{"k":"bow","v":"Odysseus strings it"}'], null],
  ["both-present", ['{"k":"bow","v":"Odysseus strings it"}', '{"k":"oar","v":"from Ithaca"}'], UNION_MERGED],
] as const)("the move keeps every line and is idempotent (%s)", (_label, current, legacy) => {
  const root = brain();
  if (current) write(root, CONTEXT_CACHE_PATH, `${current.join("\n")}\n`);
  if (legacy) write(root, OLD_CONTEXTS, `${legacy.join("\n")}\n`);
  const before = loadContextCache(root);
  const expected = [...new Set([...(current ?? []), ...(legacy ?? [])])].sort();

  expect(migrateSidecarCaches(root), "MOVED_ONLY_WHAT_WAS_THERE").toEqual(legacy ? [OLD_CONTEXTS] : []);
  expect(read(root, CONTEXT_CACHE_PATH), "EVERY_DISTINCT_LINE_KEPT_SORTED").toBe(`${expected.join("\n")}\n`);
  expect(existsSync(join(root, OLD_CONTEXTS)), "LEGACY_FILE_REMOVED").toBe(false);
  expect(loadContextCache(root), "READERS_RESOLVE_THE_SAME_VALUES").toEqual(before);

  const moved = read(root, CONTEXT_CACHE_PATH);
  expect(migrateSidecarCaches(root), "REPEATED_MOVE_DOES_NOTHING").toEqual([]);
  expect(read(root, CONTEXT_CACHE_PATH), "REPEATED_MOVE_BYTE_IDENTICAL").toBe(moved);
});

test("a move interrupted after writing the new file finishes on the next run without duplicating a line", () => {
  const root = brain();
  write(root, OLD_ASSETS, `${UNION_MERGED.join("\n")}\n`);
  // The new file already holds the lines; the old one was never removed.
  write(root, ASSET_CACHE_PATH, `${[...UNION_MERGED].sort().join("\n")}\n`);
  expect(migrateSidecarCaches(root)).toEqual([OLD_ASSETS]);
  expect(read(root, ASSET_CACHE_PATH), "NO_LINE_DUPLICATED").toBe(`${[...UNION_MERGED].sort().join("\n")}\n`);
});

test("the move leaves a cache it cannot treat as a file, and refuses a linked cache directory", () => {
  const root = brain();
  mkdirSync(join(root, OLD_CONTEXTS));
  expect(migrateSidecarCaches(root), "A_DIRECTORY_IS_NOT_MOVED").toEqual([]);
  rmSync(join(root, OLD_CONTEXTS), { recursive: true });
  write(root, OLD_CONTEXTS, '{"k":"oar","v":"from Ithaca"}\n');
  const elsewhere = brain();
  Bun.spawnSync(["ln", "-s", elsewhere, join(root, CACHE_DIR)]);
  expect(() => migrateSidecarCaches(root), "LINKED_CACHE_DIRECTORY_REFUSED").toThrow(`${CACHE_DIR} in the brain root is not a directory`);
  expect(read(root, OLD_CONTEXTS), "REFUSED_MOVE_KEEPS_THE_OLD_FILE").toBe('{"k":"oar","v":"from Ithaca"}\n');
});

test("brain doctor names root-level caches and --fix moves them", async () => {
  const root = makeTempBrain();
  dirs.push(root);
  // A context for a chunk the corpus has, so the fix's own index pass, which
  // prunes what no document reaches, keeps it.
  expect((await runCli(root, ["index", "--json"])).code).toBe(0);
  const db = new Database(join(root, ".brain-index", "brain.db"), { readonly: true });
  const chunk = db.prepare("SELECT d.title, c.heading, c.content FROM chunks c JOIN documents d ON d.id = c.document_id WHERE d.asset_type = 'markdown' LIMIT 1")
    .get() as { title: string; heading: string; content: string };
  db.close();
  write(root, OLD_CONTEXTS, `${JSON.stringify({ k: chunkContextKey(chunk.title, chunk.heading, chunk.content), v: "from Ithaca" })}\n`);
  const checks = async () => Object.fromEntries((JSON.parse((await runCli(root, ["doctor", "--json"])).stdout).checks as { id: string; status: string; detail: string }[])
    .map((check) => [check.id, check]));
  const before = await checks();
  expect(before["legacy-caches"]?.status, "LEGACY_CACHES_REPORTED").toBe("warn");
  expect(before["legacy-caches"]?.detail).toContain(`${OLD_CONTEXTS} in the brain root is a cache from an earlier release`);
  const fixed = await runCli(root, ["doctor", "--fix", "--json"]);
  expect(fixed.stdout + fixed.stderr).not.toContain("legacy-caches fix failed");
  expect(read(root, CONTEXT_CACHE_PATH), "FIX_MOVED_THE_LINE").toContain('"from Ithaca"');
  expect(existsSync(join(root, OLD_CONTEXTS)), "FIX_REMOVED_THE_OLD_FILE").toBe(false);
  expect((await checks())["legacy-caches"]?.status, "LEGACY_CACHES_CHECK_PASSES_AFTER_FIX").toBe("pass");
});

/** Push one commit from another clone of `remote`, as a machine still on an older release would. */
function pushFromOldClone(remote: string, rel: string, text: string): void {
  const clone = mkdtempSync(join(tmpdir(), "brain-cache-old-clone-"));
  dirs.push(clone);
  git(clone, "clone", "-q", remote, ".");
  git(clone, "config", "user.name", "Odysseus");
  git(clone, "config", "user.email", "odysseus@example.test");
  git(clone, "config", "commit.gpgsign", "false");
  write(clone, rel, text);
  git(clone, "add", "--", rel);
  git(clone, "commit", "-qm", "Refresh derived index caches");
  git(clone, "push", "-q", "origin", "main");
}

test.each([
  ["a rename git follows", 0],
  ["a modify/delete conflict", 40],
] as const)("a moved clone that pulls an older clone's root-level additions keeps both sides' lines (%s)", async (_label, extra) => {
  const b = brainWithRemote();
  const base = ['{"k":"loom","v":"Penelope weaves"}', '{"k":"oar","v":"from Ithaca"}'];
  write(b.root, OLD_CONTEXTS, `${base.join("\n")}\n`);
  git(b.root, "add", "--", OLD_CONTEXTS);
  git(b.root, "commit", "-qm", "Refresh derived index caches");
  git(b.root, "push", "-q", "origin", "main");
  // The older clone keeps appending at the root-level name.
  const theirs = '{"k":"bow","v":"Odysseus strings it"}';
  pushFromOldClone(b.remote, OLD_CONTEXTS, `${[...base, theirs].sort().join("\n")}\n`);
  // This clone moves its lines, plus enough of its own to defeat rename
  // detection in the second case, and commits the move.
  const ours = Array.from({ length: extra }, (_, i) => `{"k":"suitor-${String(i).padStart(2, "0")}","v":"turned away"}`);
  if (ours.length) write(b.root, OLD_CONTEXTS, `${[...base, ...ours].sort().join("\n")}\n`);
  expect(migrateSidecarCaches(b.root)).toEqual([OLD_CONTEXTS]);
  git(b.root, "add", "-A", "--", OLD_CONTEXTS, CACHE_DIR);
  git(b.root, "commit", "-qm", "Move the caches into .brain-cache/");

  const pull = JSON.parse((await runCli(b.root, ["sync", "pull", "--json"])).stdout) as { status: string; conflicts: string[] };
  expect(["rebased", "merged"], `PULL_INTEGRATED: ${JSON.stringify(pull)}`).toContain(pull.status);
  expect(pull.conflicts, "NO_CACHE_CONFLICT_LEFT").toEqual([]);
  // The pull itself moves what the older clone committed at the old name.
  expect(existsSync(join(b.root, OLD_CONTEXTS)), "PULL_MOVES_THE_INCOMING_ROOT_LEVEL_CACHE").toBe(false);
  expect([...loadContextCache(b.root).keys()].sort(), "BOTH_CLONES_ENTRIES_KEPT").toEqual(["bow", "loom", "oar", ...ours.map((line) => JSON.parse(line).k)].sort());
});

test("a cache the move cannot read is never removed, whichever side fails", () => {
  const root = brain();
  write(root, OLD_CONTEXTS, '{"k":"oar","v":"from Ithaca"}\n');
  chmodSync(join(root, OLD_CONTEXTS), 0o000);
  try {
    expect(migrateSidecarCaches(root), "UNREADABLE_LEGACY_NOT_MOVED").toEqual([]);
    expect(existsSync(join(root, OLD_CONTEXTS)), "UNREADABLE_LEGACY_KEPT").toBe(true);
  } finally { chmodSync(join(root, OLD_CONTEXTS), 0o644); }
  write(root, CONTEXT_CACHE_PATH, '{"k":"bow","v":"Odysseus strings it"}\n');
  chmodSync(join(root, CONTEXT_CACHE_PATH), 0o000);
  try {
    expect(migrateSidecarCaches(root), "UNREADABLE_DESTINATION_NOT_OVERWRITTEN").toEqual([]);
    expect(existsSync(join(root, OLD_CONTEXTS)), "LEGACY_KEPT_BESIDE_AN_UNREADABLE_DESTINATION").toBe(true);
  } finally { chmodSync(join(root, CONTEXT_CACHE_PATH), 0o644); }
  expect(read(root, CONTEXT_CACHE_PATH), "DESTINATION_ONLY_LINE_KEPT").toBe('{"k":"bow","v":"Odysseus strings it"}\n');
});

test("a cache is published whole: when its new copy cannot be staged, both files stay as they were", () => {
  const root = brain();
  write(root, OLD_CONTEXTS, '{"k":"oar","v":"from Ithaca"}\n');
  write(root, CONTEXT_CACHE_PATH, '{"k":"bow","v":"Odysseus strings it"}\n');
  chmodSync(join(root, CACHE_DIR), 0o555);
  try {
    expect(migrateSidecarCaches(root), "NOTHING_MOVED_WITHOUT_A_STAGED_COPY").toEqual([]);
  } finally { chmodSync(join(root, CACHE_DIR), 0o755); }
  expect(read(root, CONTEXT_CACHE_PATH), "DESTINATION_UNTOUCHED").toBe('{"k":"bow","v":"Odysseus strings it"}\n');
  expect(read(root, OLD_CONTEXTS), "LEGACY_UNTOUCHED").toBe('{"k":"oar","v":"from Ithaca"}\n');
});

test("a linked .brain-cache is refused by every cache write, even when nothing would change, and never pruned through", () => {
  const root = brain(), elsewhere = brain();
  write(elsewhere, "contexts.jsonl", '{"k":"oar","v":"from Ithaca"}\n');
  symlinkSync(elsewhere, join(root, CACHE_DIR));
  // Same lines on both sides: the move would write nothing.
  write(root, OLD_CONTEXTS, '{"k":"oar","v":"from Ithaca"}\n');
  expect(() => migrateSidecarCaches(root), "EQUAL_CONTENT_MOVE_REFUSED").toThrow(`${CACHE_DIR} in the brain root is not a directory`);
  expect(existsSync(join(root, OLD_CONTEXTS)), "REFUSED_MOVE_KEEPS_THE_LEGACY_FILE").toBe(true);
  rmSync(join(root, OLD_CONTEXTS));
  expect(() => forgetContextEntries(root, new Set(["oar"])), "PRUNE_THROUGH_LINK_REFUSED").toThrow(`${CACHE_DIR} in the brain root is not a directory`);
  expect(read(elsewhere, "contexts.jsonl"), "LINKED_TREE_UNTOUCHED").toBe('{"k":"oar","v":"from Ithaca"}\n');
});

test("a staged cache move, which git reports as a rename, lists the legacy name for post-sync to commit too", () => {
  const b = brainWithRemote();
  write(b.root, OLD_CONTEXTS, '{"k":"oar","v":"from Ithaca"}\n');
  git(b.root, "add", "--", OLD_CONTEXTS);
  git(b.root, "commit", "-qm", "Refresh derived index caches");
  expect(migrateSidecarCaches(b.root)).toEqual([OLD_CONTEXTS]);
  git(b.root, "add", "-A", "--", OLD_CONTEXTS, CACHE_DIR);
  expect(git(b.root, "status", "--porcelain"), "GIT_PAIRS_THE_MOVE_AS_A_RENAME").toContain("R  ");
  expect(classifyPostSyncDirt(workingTreeDirt(b.root)).caches.sort(), "BOTH_ENDS_OF_THE_MOVE_ARE_DERIVED_DIRT").toEqual([CONTEXT_CACHE_PATH, OLD_CONTEXTS].sort());
});
