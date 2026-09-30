import { Database } from "bun:sqlite";
import { parseFrontmatter } from "./frontmatter-parse.js";
import { readFileSync, writeFileSync, existsSync, mkdirSync, realpathSync } from "fs";
import { dirname, relative } from "path";

import type { DocumentType, IngestInput } from "./types.js";
import type { Taxonomy } from "./taxonomy.js";
import { stringifyDocument } from "./frontmatter.js";
import { updateDocument } from "./frontmatter-edit.js";
import { safeResolve } from "./safe-path.js";

export interface IngestOutcome {
  action: "created" | "appended";
  path: string;
  title: string;
  type: DocumentType;
  /** False when the file was written but reindexing failed — see indexError. */
  indexed: boolean;
  indexError?: string;
}

/** What ingest() needs about the brain beyond the database. */
export interface IngestContext {
  root: string;
  taxonomy: Taxonomy;
}

// Stop words excluded from tag extraction
const STOP_WORDS = new Set([
  "the", "and", "for", "are", "but", "not", "you", "all", "can", "had",
  "her", "was", "one", "our", "out", "has", "have", "been", "some", "them",
  "than", "its", "over", "also", "that", "with", "this", "from", "they",
  "will", "each", "make", "like", "into", "many", "then", "more", "very",
  "when", "what", "your", "how", "about", "which", "their", "would", "there",
  "could", "other", "just", "these", "should", "being", "does", "through",
  "where", "most", "much", "while", "after", "before", "between", "still",
  "here", "both", "such", "only", "any", "well", "those", "same",
]);

export interface Classification {
  type: DocumentType;
  path?: string;
  title?: string;
  tags: string[];
}

/**
 * Extract tags from content by finding frequently occurring lowercase words.
 * Returns top 5 words (3+ chars, excluding stop words).
 */
function extractTags(content: string): string[] {
  const words = content.toLowerCase().match(/[a-z][a-z-]{2,}/g) || [];
  const freq = new Map<string, number>();

  for (const word of words) {
    if (STOP_WORDS.has(word)) continue;
    freq.set(word, (freq.get(word) || 0) + 1);
  }

  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([word]) => word);
}

/**
 * Classify content by examining it against known documents and the taxonomy's
 * heuristic classifier hints.
 *
 * Priority order:
 * 1. Titled exactly after an existing document of an append-match type
 *    (project/network in the reference brain) -> that document (append target)
 * 2. A taxonomy classifier hint matches -> that hint's type. The taxonomy owns
 *    the hint set and its precedence (module -> user -> core); the reference
 *    brain's conference/travel/opinion/date-sensitive marker regexes are now
 *    config-supplied hints (core ships the date-sensitive "context" hints).
 * 3. Default -> the capture inbox type (note by default).
 */
export function classifyContent(
  content: string,
  db: Database,
  taxonomy: Taxonomy
): Classification {
  const tags = extractTags(content);
  const derivedTitle = titleFromContent(content).toLowerCase();

  // 1. Check against existing documents of the append-match types. Returning a
  // path here makes ingest() APPEND into that document, so the match must be
  // strong: the content's own title line must equal the document title. A mere
  // substring mention routes updates into the wrong file.
  for (const type of taxonomy.appendMatchTypes()) {
    try {
      const docs = db
        .prepare("SELECT path, title FROM documents WHERE type = ?")
        .all(type) as { path: string; title: string }[];

      for (const doc of docs) {
        if (derivedTitle === doc.title.toLowerCase()) {
          return { type, path: doc.path, title: doc.title, tags };
        }
      }
    } catch {
      // DB may not have data yet; continue
    }
  }

  // 2. Heuristic classifier hints (conference/travel/opinion/context/…).
  const classified = taxonomy.classify(content);
  if (classified) {
    return { type: classified, tags };
  }

  // 3. Default: the capture inbox type.
  return { type: taxonomy.inboxType(), tags };
}

/**
 * Generate a URL-safe slug from a title.
 * Keep Unicode letters/numbers, normalize equivalent spellings, and bound the filename.
 */
function slugify(title: string): string {
  const normalized = title.normalize("NFC").toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}]+/gu, "-").replace(/^-+|-+$/g, "");
  // 60 code points also stays below common filename byte limits for CJK.
  return Array.from(normalized).slice(0, 60).join("").replace(/-+$/, "") || "untitled";
}

/**
 * Extract a title from the first line of content.
 * Strips markdown heading prefix if present.
 */
function titleFromContent(content: string): string {
  const firstLine = content.trim().split("\n")[0] || "Untitled";
  return firstLine.replace(/^#+\s*/, "").trim() || "Untitled";
}

/**
 * Get today's date as YYYY-MM-DD.
 */
function today(): string {
  return new Date().toISOString().split("T")[0];
}

/**
 * Re-index after a write. Failures are surfaced, not swallowed — the file
 * exists on disk but is invisible to search until the next successful index.
 * The indexer is imported dynamically (as in the reference brain) so ingestion
 * does not statically depend on the whole embedding pipeline.
 */
async function reindex(
  db: Database,
  ctx: IngestContext
): Promise<{ indexed: boolean; indexError?: string }> {
  try {
    const { indexAll } = await import("./indexer.js");
    await indexAll(db, { root: ctx.root, taxonomy: ctx.taxonomy, force: false, quiet: true });
    return { indexed: true };
  } catch (e) {
    return { indexed: false, indexError: (e as Error).message };
  }
}

/**
 * Ingest content into the brain knowledge base.
 *
 * Handles classification, frontmatter generation, and file creation/append.
 */
export async function ingest(
  input: IngestInput,
  db: Database,
  ctx: IngestContext
): Promise<IngestOutcome> {
  const { content } = input;
  const { root, taxonomy } = ctx;

  if (input.type && !taxonomy.isValidType(input.type)) {
    throw new Error(
      `Invalid type "${input.type}". Valid types: ${taxonomy.validTypes().join(", ")}`
    );
  }

  // 1. Determine type: explicit > classified
  const classification = classifyContent(content, db, taxonomy);
  const type: DocumentType = input.type || classification.type;

  // 2. Determine title
  const title = input.title || classification.title || titleFromContent(content);

  // 3. Determine tags
  const tags = input.tags && input.tags.length > 0 ? input.tags : classification.tags;

  // 4. Generate slug
  const slug = slugify(title);

  const canonicalRoot = realpathSync(root);
  const resolvePath = (path: string): string => {
    const full = safeResolve(root, path);
    if (full === null) throw new Error(`Path escapes the brain root: ${path}`);
    return full;
  };

  // A filename collision is never evidence of an append match. Revalidate
  // the classified document on disk, since the index may be stale or the
  // caller may have overridden its title/type.
  if (classification.path && !input.path && !input.type && title.toLowerCase() === classification.title?.toLowerCase()) {
    const fullPath = resolvePath(classification.path);
    if (existsSync(fullPath)) {
      const raw = readFileSync(fullPath, "utf-8");
      const parsed = parseFrontmatter(raw);
      if (String(parsed.data.title).toLowerCase() === title.toLowerCase() && parsed.data.type === type) {
        // Only `updated` changes in the frontmatter; its other bytes stay as written.
        const section = `## ${today()} Update\n\n${content.trim()}`;
        writeFileSync(fullPath, updateDocument(raw, { updated: today() }, section), "utf-8");
        return {
          action: "appended",
          path: relative(canonicalRoot, fullPath),
          title: String(parsed.data.title),
          type,
          ...(await reindex(db, ctx)),
        };
      }
    }
  }

  const frontmatter: Record<string, any> = {
    type,
    title,
    created: today(),
    updated: today(),
    tags,
    status: "active",
    relevance: "primary",
  };

  const body = "\n" + content.trim() + "\n";
  const output = stringifyDocument(body, frontmatter);
  const dir = taxonomy.dirForType(type) ?? ".";
  let relativePath: string;
  for (let suffix = 1; ; suffix++) {
    const candidate = input.path || `${dir}/${slug}${suffix === 1 ? "" : `-${suffix}`}.md`;
    const fullPath = resolvePath(candidate);
    mkdirSync(dirname(fullPath), { recursive: true });
    try {
      // Exclusive creation also handles concurrent captures of the same title.
      writeFileSync(fullPath, output, { encoding: "utf-8", flag: "wx" });
      relativePath = relative(canonicalRoot, fullPath);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (input.path) throw new Error(`Capture destination already exists: ${input.path}`);
    }
  }

  // Re-index
  return {
    action: "created",
    path: relativePath,
    title,
    type,
    ...(await reindex(db, ctx)),
  };
}
