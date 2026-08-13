import type { Database } from "bun:sqlite";

/** Number of terms kept per community. */
const TOP_TERMS = 5;
/** Tags are a deliberate signal; title words are incidental. */
const TAG_WEIGHT = 2;
/** Terms shorter than this are never topical. */
const MIN_TERM_LENGTH = 3;
/**
 * A term this common describes the corpus, not a community. The absolute floor
 * keeps small corpora (where every term is "common") from suppressing
 * everything.
 */
const CORPUS_COMMON_RATIO = 0.25;
const CORPUS_COMMON_FLOOR = 3;

const STOP_WORDS = new Set([
  "the", "and", "for", "with", "from", "into", "that", "this", "these", "those",
  "are", "was", "were", "been", "being", "have", "has", "had", "not", "but",
  "you", "your", "our", "its", "his", "her", "their", "them", "they", "she",
  "him", "who", "whom", "what", "when", "where", "which", "while", "how", "why",
  "can", "will", "would", "should", "could", "may", "might", "must", "about",
  "over", "under", "than", "then", "there", "here", "some", "any", "all",
  "each", "more", "most", "other", "such", "only", "own", "same", "too", "very",
  "just", "also", "new", "old", "one", "two", "get", "got", "use", "using",
  "notes", "note", "index", "draft", "todo", "misc",
]);

export interface TermIndex {
  /** document id → weighted terms (a term repeats once per weight unit). */
  byDoc: Map<number, string[]>;
  /** term → number of documents carrying it. */
  documentFrequency: Map<string, number>;
  totalDocs: number;
}

function tokenizeTitle(title: string): string[] {
  return title
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= MIN_TERM_LENGTH && !STOP_WORDS.has(token));
}

function normalizeTag(tag: string): string | null {
  const normalized = tag.toLowerCase().trim();
  if (normalized.length < MIN_TERM_LENGTH || STOP_WORDS.has(normalized)) return null;
  return normalized;
}

/**
 * Build the per-document term pool once, so labelling N communities is N cheap
 * merges rather than N queries.
 */
export function buildTermIndex(db: Database): TermIndex {
  const byDoc = new Map<number, string[]>();
  const documentFrequency = new Map<string, number>();

  const docs = db
    .prepare("SELECT id, title FROM documents WHERE asset_type = 'markdown' ORDER BY id")
    .all() as { id: number; title: string }[];

  const tagRows = db
    .prepare(
      `SELECT dt.document_id AS documentId, t.name AS name
       FROM document_tags dt
       JOIN tags t ON t.id = dt.tag_id
       ORDER BY dt.document_id, t.name`
    )
    .all() as { documentId: number; name: string }[];

  const tagsByDoc = new Map<number, string[]>();
  for (const row of tagRows) {
    const tag = normalizeTag(row.name);
    if (!tag) continue;
    const tags = tagsByDoc.get(row.documentId) ?? [];
    tags.push(tag);
    tagsByDoc.set(row.documentId, tags);
  }

  for (const doc of docs) {
    const terms: string[] = [];
    for (const tag of tagsByDoc.get(doc.id) ?? []) {
      for (let i = 0; i < TAG_WEIGHT; i++) terms.push(tag);
    }
    terms.push(...tokenizeTitle(doc.title));
    byDoc.set(doc.id, terms);

    for (const term of new Set(terms)) {
      documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
    }
  }

  return { byDoc, documentFrequency, totalDocs: docs.length };
}

/**
 * The terms that distinguish this community from the rest of the corpus, most
 * distinctive first. Ties break alphabetically so the label is reproducible.
 */
export function communityTopTerms(index: TermIndex, members: number[]): string[] {
  const commonThreshold = Math.max(
    CORPUS_COMMON_FLOOR,
    Math.ceil(index.totalDocs * CORPUS_COMMON_RATIO)
  );

  const counts = new Map<string, number>();
  for (const id of members) {
    for (const term of index.byDoc.get(id) ?? []) {
      counts.set(term, (counts.get(term) ?? 0) + 1);
    }
  }

  return [...counts.entries()]
    .filter(([term]) => (index.documentFrequency.get(term) ?? 0) < commonThreshold)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, TOP_TERMS)
    .map(([term]) => term);
}
