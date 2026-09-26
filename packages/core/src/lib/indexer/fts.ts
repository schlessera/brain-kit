/**
 * The full-text table follows `search.language`.
 *
 * `documents_fts` is built with the tokenizer the configured language names.
 * When an index run finds it built with another one, the run marks every
 * markdown document changed (planFtsTokenizer), and its persist transaction
 * recreates the table with the configured tokenizer, fills it from the
 * documents table, and then writes each markdown document's own row, aliases
 * included (applyFtsTokenizer). The new table, its rows and `fts_tokenizer`
 * commit together or not at all: a run that fails leaves the old table, its
 * rows and its metadata as they were, and the next run finds the mismatch
 * again. A document the run could not read keeps the row copied from the
 * documents table, searchable by its title, summary, text and tags. Nothing
 * is re-embedded: chunks and vectors are untouched.
 */
import { setMeta } from "../db.js";
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
    run.db.run("DROP TABLE IF EXISTS documents_fts");
    run.db.run(`CREATE VIRTUAL TABLE documents_fts USING fts5(
      title, summary, content, tags,
      tokenize='${wanted}'
    )`);
    run.db.run(
      `INSERT INTO documents_fts(rowid, title, summary, content, tags)
       SELECT d.id, d.title, COALESCE(d.summary, ''), d.content,
              COALESCE((SELECT GROUP_CONCAT(t.name, ' ')
                        FROM document_tags dt JOIN tags t ON t.id = dt.tag_id
                        WHERE dt.document_id = d.id), '')
       FROM documents d`
    );
  }
  setMeta(run.db, FTS_TOKENIZER_META, wanted);
}
