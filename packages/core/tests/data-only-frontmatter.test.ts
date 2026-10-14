import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { buildTaxonomy } from "../src/lib/taxonomy";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { frontmatterEngineSentinel } from "../../../tests/helpers/frontmatter-engine-sentinel";
import { parseMarkdownFiles } from "../src/lib/indexer/parse";
import type { IndexRun } from "../src/lib/indexer/types";
import { stringifyDocument } from "../src/lib/frontmatter";

test("index parsing and serialization refuse unsupported content before engine dispatch", () => {
  const root = mkdtempSync(join(tmpdir(), "odyssey-data-only-"));
  const sentinel = frontmatterEngineSentinel({ title: "Return to Ithaca", type: "note" });
  const warnings: string[] = [];
  const db = new Database(":memory:");
  const run: IndexRun = { root, db, taxonomy: buildTaxonomy({}), force: true, wantEmbeddings: false,
    now: "2026-07-12", stats: { total: 0, added: 0, updated: 0, deleted: 0, unchanged: 0,
      chunks: 0, embeddings: 0, assets: 0, graphMs: 0, graphNodes: 0 },
    report: () => {}, warn: message => { warnings.push(message); } };
  try {
    for (const language of ["js", "javascript", "JS", "json", "odyssey"]) {
      const content = `---${language}\nOdysseus\n---\n`;
      writeFileSync(join(root, "voyage.md"), content);
      const parsed = parseMarkdownFiles(run, ["voyage.md"], new Map());
      expect(sentinel.dispatched, "INDEX_NO_ENGINE_DISPATCH").toEqual([]);
      expect(parsed.files).toEqual([]); expect(warnings.at(-1)).toContain("invalid frontmatter");
      let error: unknown;
      try { stringifyDocument(content, { title: "Return to Ithaca" }); } catch (caught) { error = caught; }
      expect(sentinel.dispatched, "SERIALIZER_NO_ENGINE_DISPATCH").toEqual([]);
      expect(String(error)).toContain("use YAML data only");
    }
    writeFileSync(join(root, "voyage.md"), "---\ntitle: Return to Ithaca\ntype: note\n---\nOdysseus\n");
    expect(parseMarkdownFiles(run, ["voyage.md"], new Map()).files).toHaveLength(1);
    expect(stringifyDocument("Odysseus\n", { title: "Return to Ithaca" })).toContain("title: Return to Ithaca");
  } finally { sentinel.restore(); db.close(); rmSync(root, { recursive: true, force: true }); }
});
