/**
 * The asset scan applies `exclude.*` to the path as it is on disk (#234).
 *
 * It used to lowercase the whole path first, so on a case-sensitive
 * filesystem `dirs: ["drafts"]` excluded the assets under `Drafts/` (and the
 * next `brain index` deleted any already indexed), while the markdown scan,
 * the `brain stats` corpus walk and the MCP file listing all kept that
 * directory. `dirs: ["Drafts"]` did the opposite. Entries are literal; the
 * lowercasing belonged to the extension lookup only.
 *
 * Keyless: the one embedding run uses the fake provider from vec-fixture.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { brainConfigSchema } from "../src/lib/config";
import { migrateVecSchema, openDatabase } from "../src/lib/db";
import { indexAll } from "../src/lib/indexer";
import { getAssetFiles, getMarkdownFiles } from "../src/lib/indexer/scan";
import { buildTaxonomy } from "../src/lib/taxonomy";
import { fakeEmbeddingProvider, VEC_DIMENSIONS } from "./vec-fixture";

const temps: string[] = [];
afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

/** A one-pixel PNG: enough bytes for the scan to stat. */
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** A brain with a note and an image under `Drafts/`, and a lowercase `drafts/` beside it. */
function brainWithDrafts(): string {
  const root = mkdtempSync(join(tmpdir(), "brain-asset-exclude-"));
  temps.push(root);
  mkdirSync(join(root, "Drafts"), { recursive: true });
  mkdirSync(join(root, "drafts"), { recursive: true });
  writeFileSync(join(root, "Drafts/note.md"), "---\ntitle: Upper note\ntype: note\n---\n\nUpper case directory.\n");
  writeFileSync(join(root, "Drafts/photo.png"), PNG);
  writeFileSync(join(root, "drafts/lower.png"), PNG);
  return root;
}

const taxonomyExcluding = (dirs: string[]) =>
  buildTaxonomy({ user: brainConfigSchema.parse({ exclude: { dirs } }) });

describe("exclude entries match an asset's path as it is", () => {
  test('dirs: ["drafts"] keeps the assets under Drafts/, as it keeps the notes', () => {
    const root = brainWithDrafts();
    const taxonomy = taxonomyExcluding(["drafts"]);

    const assets = getAssetFiles(root, taxonomy).map((a) => a.path);
    expect(assets).toContain("Drafts/photo.png");
    expect(assets).not.toContain("drafts/lower.png");
    // The markdown scan and the asset scan give one answer for one directory.
    expect(getMarkdownFiles(root, taxonomy)).toContain("Drafts/note.md");
  });

  test('dirs: ["Drafts"] excludes the assets under Drafts/, as it excludes the notes', () => {
    const root = brainWithDrafts();
    const taxonomy = taxonomyExcluding(["Drafts"]);

    const assets = getAssetFiles(root, taxonomy).map((a) => a.path);
    expect(assets).not.toContain("Drafts/photo.png");
    expect(assets).toContain("drafts/lower.png");
    expect(getMarkdownFiles(root, taxonomy)).not.toContain("Drafts/note.md");
  });

  test("an upper-case extension is still an asset — the lowercasing that stays is the extension's", () => {
    const root = brainWithDrafts();
    writeFileSync(join(root, "Drafts/SCAN.PNG"), PNG);
    const assets = getAssetFiles(root, taxonomyExcluding([]));
    expect(assets.find((a) => a.path === "Drafts/SCAN.PNG")?.mimeType).toBe("image/png");
  });
});

describe("an asset already in the index under a case-distinct directory", () => {
  test("is not removed by the next index when a lower-case entry names a different directory", async () => {
    const root = brainWithDrafts();
    const dbPath = join(root, "brain.db");
    const assetRows = (db: Database) =>
      (
        db.prepare("SELECT path FROM documents WHERE asset_type != 'markdown' ORDER BY path").all() as {
          path: string;
        }[]
      ).map((r) => r.path);

    const db = openDatabase(dbPath);
    try {
      // Assets are only indexed by an embedding run; the fake provider keeps it keyless.
      expect(await migrateVecSchema(db, VEC_DIMENSIONS)).toBe(true);
      await indexAll(db, {
        root,
        taxonomy: taxonomyExcluding([]),
        quiet: true,
        graph: false,
        embeddings: true,
        provider: fakeEmbeddingProvider(),
      });
      expect(assetRows(db)).toEqual(["Drafts/photo.png", "drafts/lower.png"]);

      // `drafts` now excluded, on a plain index — the deletion sweep runs on
      // every run. The lower-case directory leaves; Drafts/ stays.
      await indexAll(db, { root, taxonomy: taxonomyExcluding(["drafts"]), quiet: true, graph: false });
      expect(assetRows(db)).toEqual(["Drafts/photo.png"]);
    } finally {
      db.close();
    }
  });
});
