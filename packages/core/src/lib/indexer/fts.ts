/**
 * The full-text table follows `search.language`.
 *
 * `documents_fts` is built with the tokenizer the configured language names.
 * When an index run finds it built with another one, the run marks every
 * markdown document changed (planFtsTokenizer), and its persist transaction
 * recreates the table with the configured tokenizer, fills it with the old
 * table's rows, copied whole with their rowids, and then writes each markdown
 * document's own row again (applyFtsTokenizer). The new table, its rows and
 * `fts_tokenizer` commit together or not at all: a run that fails leaves the
 * old table, its rows and its metadata as they were, and the next run finds
 * the mismatch again. A document the run could not read keeps its old row
 * exactly, aliases and tag order included, so it is found by everything it was
 * found by. `chunks_fts` (the chunk table) is recreated with the same
 * tokenizer and rebuilt from `chunks`. Nothing is re-embedded: chunks and
 * vectors are untouched.
 */
import { createChunksFts, setMeta } from "../db.js";
import { builtFtsTokenizer, FTS_TOKENIZER_META, ftsTokenizer } from "../search-language.js";
import type { IndexRun } from "./types.js";

/**
 * Before parsing: whether `documents_fts` needs rebuilding for the configured
 * language. When it does, every markdown document is written again this run
 * (`run.ftsRebuilt`). Writes nothing.
 */
export function planFtsTokenizer(run: IndexRun): boolean {
  const wanted = ftsTokenizer(run.taxonomy.searchLanguage);
  const built = builtFtsTokenizer(run.db);
  if (built === wanted) return false;
  run.ftsRebuilt = true;
  // A new index was simply built for the language; only a real switch is news.
  const indexed = (run.db.prepare("SELECT COUNT(*) AS n FROM documents").get() as { n: number }).n > 0;
  if (indexed) {
    run.report(`Full-text index rebuilt for search.language "${run.taxonomy.searchLanguage}" (tokenizer ${wanted}, was ${built})`);
  }
  return true;
}

/**
 * Inside the persist transaction, before any document is written: recreate
 * `documents_fts` when the plan asked for it and the table is still another
 * tokenizer's, and record the tokenizer the table now has. The check and the
 * write share the transaction, so a concurrent run cannot slip between them.
 * A table that changed under an unplanned run is left for the next one, which
 * plans its rebuild.
 */
export function applyFtsTokenizer(run: IndexRun): void {
  const wanted = ftsTokenizer(run.taxonomy.searchLanguage);
  const built = builtFtsTokenizer(run.db);
  if (built !== wanted) {
    if (!run.ftsRebuilt) return;
    // Every row's text as it is, rowid included, before the table goes: a
    // document this run cannot read keeps exactly what it had (its aliases,
    // its tags in their order), and the rows the run does write replace
    // their copies below. A fresh index has no table to copy.
    const columns = built === null ? [] : (run.db.prepare("PRAGMA table_info(documents_fts)").all() as { name: string }[]).map((c) => c.name);
    if (columns.length > 0) {
      run.db.run("DROP TABLE IF EXISTS temp.documents_fts_copy");
      run.db.run(`CREATE TEMP TABLE documents_fts_copy AS SELECT rowid AS id, ${columns.join(", ")} FROM documents_fts`);
    }
    run.db.run("DROP TABLE IF EXISTS documents_fts");
    run.db.run(`CREATE VIRTUAL TABLE documents_fts USING fts5(
      title, summary, content, tags, aliases,
      tokenize='${wanted}'
    )`);
    if (columns.length > 0) {
      const kept = columns.filter((c) => ["title", "summary", "content", "tags", "aliases"].includes(c));
      run.db.run(
        `INSERT INTO documents_fts(rowid, ${kept.join(", ")}) SELECT id, ${kept.join(", ")} FROM temp.documents_fts_copy`
      );
      run.db.run("DROP TABLE temp.documents_fts_copy");
    }
  }
  // The chunk table follows the same tokenizer. Its text lives in `chunks`,
  // so it is recreated and rebuilt from them, whenever it differs.
  const chunks = builtFtsTokenizer(run.db, "chunks_fts");
  if (chunks !== null && chunks !== wanted) {
    run.db.run("DROP TABLE chunks_fts");
    createChunksFts(run.db);
    run.db.run("INSERT INTO chunks_fts(chunks_fts) VALUES ('rebuild')");
  }
  setMeta(run.db, FTS_TOKENIZER_META, wanted);
}
