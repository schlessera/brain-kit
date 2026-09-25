/**
 * The full-text table follows `search.language`.
 *
 * `documents_fts` is built with the tokenizer the configured language names.
 * When an index run finds it built with another one, it recreates the table
 * with the configured tokenizer, puts the asset rows back from the documents
 * table, and has the markdown documents written again by the persist phase,
 * which has their aliases (the documents table does not). Nothing is
 * re-embedded: chunks and vectors are untouched.
 */
import { setMeta } from "../db.js";
import { builtFtsTokenizer, FTS_TOKENIZER_META, ftsTokenizer } from "../search-language.js";
import type { IndexRun } from "./types.js";

/** Rebuild `documents_fts` when its tokenizer is not the configured one. Returns whether it did. */
export function alignFtsTokenizer(run: IndexRun): boolean {
  const wanted = ftsTokenizer(run.taxonomy.searchLanguage);
  const built = builtFtsTokenizer(run.db);
  const indexed = (run.db.prepare("SELECT COUNT(*) AS n FROM documents").get() as { n: number }).n > 0;
  if (built === wanted) {
    setMeta(run.db, FTS_TOKENIZER_META, wanted);
    return false;
  }
  run.db.transaction(() => {
    run.db.run("DROP TABLE IF EXISTS documents_fts");
    run.db.run(`CREATE VIRTUAL TABLE documents_fts USING fts5(
      title, summary, content, tags,
      tokenize='${wanted}'
    )`);
    run.db.run(
      `INSERT INTO documents_fts(rowid, title, summary, content, tags)
       SELECT id, title, '', content, '' FROM documents WHERE asset_type != 'markdown'`
    );
    setMeta(run.db, FTS_TOKENIZER_META, wanted);
  }).immediate();
  run.ftsRebuilt = true;
  // A new index was simply built for the language; only a real switch is news.
  if (indexed) {
    run.report(`Full-text index rebuilt for search.language "${run.taxonomy.searchLanguage}" (tokenizer ${wanted}, was ${built})`);
  }
  return true;
}
