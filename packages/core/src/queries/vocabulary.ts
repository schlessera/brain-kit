/** Private extraction profile copied from the existing voice reader, without retuning. */
import type { Database } from "bun:sqlite";
interface Keyterm {
  term: string;
  score: number;
  source: string;
}
export const EXTRACTOR_VERSION = 2;
// Common English words to exclude from extracted vocab.
// Kept short and aggressive — anything ambiguous, drop it.
const STOPLIST = new Set([
  "the", "and", "for", "with", "from", "this", "that", "into", "your",
  "have", "will", "been", "were", "they", "their", "them", "what", "when",
  "where", "which", "while", "would", "could", "should", "about", "after",
  "before", "between", "during", "through", "than", "then", "also", "such",
  "some", "any", "all", "more", "most", "other", "over", "under",
  "you", "are", "was", "but", "not", "now", "use", "via", "let", "get",
  "yes", "no", "ok",
  // common English ALL-CAPS that are not jargon
  "USA", "UK", "EU", "AM", "PM", "OK", "TV", "DVD", "USB",
  "NOT", "IT", "JD", "FACTS", "FAQ", "ID", "OS",
]);
// Generic English nouns/adjectives that frequently appear in tags or
// document titles but carry no proper-noun signal worth biasing for.
// Lower-cased compare. A multi-word entry with ANY of these tokens (and no
// proper-noun tokens) is dropped from titles/tags.
const GENERIC_TERMS = new Set([
  "summit", "focus", "schema", "integration", "evolution", "framework",
  "strategy", "risk", "constraints", "architecture", "development",
  "interview", "angle", "narrative", "listing", "unique", "key",
  "takeaways", "title", "options", "core", "recommendation", "practical",
  "implementation", "technical", "depth", "track", "fit", "reverse", "deep",
  "dive", "measurement", "challenge", "balanced", "perspective", "global",
  "relevance", "complexity", "developer", "job", "requisition",
  "performance", "optimization", "data", "overhaul", "measurement",
  "managed", "internal", "smart", "search", "vector", "database",
  "gateway", "engine", "platform", "service", "system", "process",
  "approach", "method", "concept", "feature", "decision", "summary",
  "overview", "background", "context", "details", "notes", "content",
]);
function looksLikeProperNoun(token: string): boolean {
  if (!token)
    return false;
  // ALL-CAPS acronym (>=2 chars)
  if (/^[A-Z][A-Z0-9-]{1,7}$/.test(token))
    return true;
  // Contains accented/umlaut characters
  if (/[À-ſ]/.test(token))
    return true;
  // CamelCase (capital after lowercase, e.g. "DiTomaso", "WordPress")
  if (/[a-z][A-Z]/.test(token))
    return true;
  // Capitalized word that is not a generic common noun
  if (/^[A-Z][a-z]+$/.test(token) && !GENERIC_TERMS.has(token.toLowerCase())) {
    return true;
  }
  return false;
}
function hasProperNounSignal(term: string): boolean {
  const tokens = term.split(/\s+/);
  return tokens.some(looksLikeProperNoun);
}
// Stricter check used for multi-word phrases: at least one token must be a
// real proper-noun-shaped capitalized word (not just an ALL-CAPS acronym),
// AND no token is a generic common English noun. This rejects phrases like
// "Listing URL", "Key Takeaways", "Core Narrative" that pass the loose check.
function isStrongProperNounPhrase(term: string): boolean {
  const tokens = term.split(/\s+/);
  if (tokens.length === 1)
    return looksLikeProperNoun(tokens[0]);
  let hasNamedToken = false;
  for (const t of tokens) {
    if (GENERIC_TERMS.has(t.toLowerCase()))
      return false;
    if (/[À-ſ]/.test(t) ||
      /[a-z][A-Z]/.test(t) ||
      (/^[A-Z][a-z]{2,}$/.test(t) && !GENERIC_TERMS.has(t.toLowerCase()))) {
      hasNamedToken = true;
    }
  }
  return hasNamedToken;
}
const ALL_CAPS_KEEP = new Set<string>([
// Things you DO want even if they look generic
]);
interface TagRow {
  name: string;
}
interface LinkRow {
  target: string;
}
function normalize(s: string): string {
  return s.trim().replace(/\s+/g, " ");
}
function extractTags(db: Database): Keyterm[] {
  const rows = db.query("SELECT name FROM tags").all() as TagRow[];
  const out: Keyterm[] = [];
  for (const r of rows) {
    const t = normalize(r.name);
    if (!t || t.length < 3)
      continue;
    if (STOPLIST.has(t.toLowerCase()))
      continue;
    if (GENERIC_TERMS.has(t.toLowerCase()))
      continue;
    if (!hasProperNounSignal(t))
      continue;
    out.push({ term: t, score: 5, source: "tag" });
  }
  return out;
}
function extractTitles(db: Database): Keyterm[] {
  const rows = db
    .query("SELECT title FROM documents WHERE type IN ('network','project','talk','note','expertise','context')")
    .all() as {
    title: string;
  }[];
  const out: Keyterm[] = [];
  for (const { title } of rows) {
    const t = normalize(title);
    if (!t || t.length < 4)
      continue;
    if (/^(active|archived?|index|key|notable|current)\s/i.test(t))
      continue;
    if (!isStrongProperNounPhrase(t))
      continue;
    out.push({ term: t, score: 4, source: "title" });
  }
  return out;
}
// Curated path hierarchy maps to company/project names. Each subdirectory
// under these prefixes corresponds to an entity the user actively engages with.
// These are HUMAN-CURATED whitelists — every entry was added intentionally —
// so they outrank frequency-derived signals like acronym counts.
const PATH_PREFIXES: Array<{
  prefix: string;
  score: number;
}> = [
  { prefix: "career/opportunities/", score: 14 }, // active interview pipeline
  { prefix: "projects/active/", score: 13 },
  { prefix: "projects/catalog/", score: 9 },
  { prefix: "projects/archive/", score: 5 },
];
function kebabToTitle(slug: string): string {
  // Promote known acronym-ish 2-3 char tokens to ALL-CAPS.
  const acronymHints = new Set([
    "ai", "ml", "api", "sdk", "cli", "css", "html", "wp", "us", "uk",
    "eu", "io", "js", "ts", "qa", "hr", "vp",
  ]);
  return slug
    .split("-")
    .map((tok) => {
    if (!tok)
      return tok;
    if (acronymHints.has(tok.toLowerCase()))
      return tok.toUpperCase();
    return tok[0].toUpperCase() + tok.slice(1);
  })
    .join(" ");
}
function extractPaths(db: Database): Keyterm[] {
  const out: Keyterm[] = [];
  const seen = new Set<string>();
  for (const { prefix, score } of PATH_PREFIXES) {
    const rows = db
      .query("SELECT DISTINCT path FROM documents WHERE path LIKE ?")
      .all(`${prefix}%`) as {
      path: string;
    }[];
    for (const { path } of rows) {
      const tail = path.slice(prefix.length);
      const segment = tail.split("/")[0];
      if (!segment || segment.startsWith("_"))
        continue;
      // Skip files at the prefix root (e.g. an _index.md was filtered above)
      if (segment.endsWith(".md") || segment.endsWith(".pdf"))
        continue;
      const name = kebabToTitle(segment);
      if (!name || name.length < 2)
        continue;
      const key = name.toLowerCase();
      if (seen.has(key))
        continue;
      seen.add(key);
      out.push({ term: name, score, source: "title" });
    }
  }
  return out;
}
function extractLinks(db: Database): Keyterm[] {
  const rows = db.query("SELECT DISTINCT target FROM links").all() as LinkRow[];
  const out: Keyterm[] = [];
  for (const { target } of rows) {
    if (!target)
      continue;
    if (target.includes("/") || target.startsWith("#"))
      continue;
    const t = normalize(target);
    if (t.length < 3)
      continue;
    if (STOPLIST.has(t.toLowerCase()))
      continue;
    if (GENERIC_TERMS.has(t.toLowerCase()))
      continue;
    if (!hasProperNounSignal(t))
      continue;
    out.push({ term: t, score: 4, source: "link" });
  }
  return out;
}
const BOLD_NAME_RE = /\*\*([A-ZÀ-ſ][\p{L}'.-]+(?:\s+(?:de|von|van|del|la|le|der|den|di)\s+|\s+)[A-ZÀ-ſ][\p{L}'.-]+(?:\s+[A-ZÀ-ſ][\p{L}'.-]+)?)\*\*/gu;
const ACRONYM_RE = /\b([A-Z]{2,8}(?:-[A-Z0-9]{1,4})?)\b/g;
const NETWORK_TYPE = "network";
// People names from network/ are kept only if they're mentioned this often
// across the entire brain. Filters out one-off acquaintances, keeps recurring
// day-job contacts.
const NETWORK_NAME_MIN_MENTIONS = 3;
interface ContentRow {
  title: string;
  content: string;
  type: string;
}
function extractFromContent(db: Database): Keyterm[] {
  const rows = db
    .query("SELECT title, content, type FROM documents WHERE asset_type = 'markdown'")
    .all() as ContentRow[];
  // Collect bold matches separately by source role
  const networkNameCandidates = new Set<string>();
  const otherBoldCounts = new Map<string, number>();
  const acronymCounts = new Map<string, number>();
  for (const { content, type } of rows) {
    if (!content)
      continue;
    for (const m of content.matchAll(BOLD_NAME_RE)) {
      const name = normalize(m[1]);
      if (!name)
        continue;
      const tokens = name.split(/\s+/);
      if (tokens.some((t) => STOPLIST.has(t.toLowerCase())))
        continue;
      if (type === NETWORK_TYPE) {
        networkNameCandidates.add(name);
      }
      else {
        otherBoldCounts.set(name, (otherBoldCounts.get(name) || 0) + 1);
      }
    }
    for (const m of content.matchAll(ACRONYM_RE)) {
      const ac = m[1];
      if (STOPLIST.has(ac) && !ALL_CAPS_KEEP.has(ac))
        continue;
      acronymCounts.set(ac, (acronymCounts.get(ac) || 0) + 1);
    }
  }
  // For each network name candidate, count brain-wide mentions (substring,
  // word-bounded). Names that don't recur enough are dropped.
  const networkNameCounts = new Map<string, number>();
  if (networkNameCandidates.size > 0) {
    const candidates = [...networkNameCandidates];
    for (const { content } of rows) {
      if (!content)
        continue;
      for (const name of candidates) {
        const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const re = new RegExp(`\\b${escaped}\\b`, "g");
        const matches = content.match(re);
        if (matches) {
          networkNameCounts.set(name, (networkNameCounts.get(name) || 0) + matches.length);
        }
      }
    }
  }
  const out: Keyterm[] = [];
  for (const [term, count] of networkNameCounts) {
    if (count < NETWORK_NAME_MIN_MENTIONS)
      continue;
    if (!isStrongProperNounPhrase(term))
      continue;
    out.push({ term, score: 9 + Math.log2(1 + count), source: "bold" });
    const tokens = term.split(/\s+/);
    if (tokens.length >= 2) {
      const last = tokens[tokens.length - 1];
      if (last.length >= 4 &&
        !STOPLIST.has(last.toLowerCase()) &&
        !GENERIC_TERMS.has(last.toLowerCase()) &&
        looksLikeProperNoun(last)) {
        out.push({
          term: last,
          score: 4 + Math.log2(1 + count),
          source: "bold",
        });
      }
    }
  }
  for (const [term, count] of otherBoldCounts) {
    if (count < 1)
      continue;
    if (!isStrongProperNounPhrase(term))
      continue;
    out.push({ term, score: 8 + Math.log2(1 + count), source: "bold" });
  }
  for (const [term, count] of acronymCounts) {
    if (count < 2)
      continue;
    out.push({ term, score: 4 + Math.log2(1 + count), source: "acronym" });
  }
  return out;
}
function dedupeAndRank(terms: Keyterm[], limit: number): string[] {
  const byTerm = new Map<string, Keyterm>();
  for (const k of terms) {
    const key = k.term.toLowerCase();
    const prev = byTerm.get(key);
    if (!prev || k.score > prev.score) {
      byTerm.set(key, k);
    }
    else {
      // accumulate score for repeated finds across sources
      prev.score += k.score * 0.25;
    }
  }
  const sorted = [...byTerm.values()].sort((a, b) => b.score - a.score);
  return sorted.slice(0, limit).map((k) => k.term);
}
export function vocabulary(db: Database, limit: number): string[] {
  return dedupeAndRank([
    ...extractTags(db), ...extractTitles(db), ...extractPaths(db),
    ...extractLinks(db), ...extractFromContent(db),
  ], limit);
}
