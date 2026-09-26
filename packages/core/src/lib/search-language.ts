/**
 * `search.language`: the one setting that decides how full-text search reads
 * text, the index's tokenizer and the query builder's stopwords together.
 *
 * `english` (the default) is `porter unicode61` with English stopwords, as
 * before the setting existed. `none` is `unicode61 remove_diacritics 2` with
 * no stopwords: the Porter stemmer is English-only, and in another language
 * it stems nothing useful and can conflate unrelated words.
 */
import type { Database } from "bun:sqlite";

export type SearchLanguage = "english" | "none";

const TOKENIZERS: Record<SearchLanguage, string> = {
  english: "porter unicode61",
  none: "unicode61 remove_diacritics 2",
};

/** The FTS5 tokenizer a language builds `documents_fts` with. */
export function ftsTokenizer(language: SearchLanguage): string {
  return TOKENIZERS[language];
}

/** `index_metadata` key: the tokenizer the current `documents_fts` was built with. */
export const FTS_TOKENIZER_META = "fts_tokenizer";

/**
 * The tokenizer a full-text table (`documents_fts` unless named) was actually
 * created with, read from its definition in `sqlite_master`; null when the
 * table does not exist.
 */
export function builtFtsTokenizer(db: Database, table: "documents_fts" | "chunks_fts" = "documents_fts"): string | null {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as
    | { sql: string }
    | null;
  if (!row) return null;
  return row.sql.match(/tokenize\s*=\s*'([^']*)'/i)?.[1] ?? "unicode61";
}

/** Whether the index was built with English stemming, and so wants English stopwords in its queries. */
export function ftsIsEnglish(db: Database): boolean {
  return /\bporter\b/.test(builtFtsTokenizer(db) ?? TOKENIZERS.english);
}
