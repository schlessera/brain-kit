/**
 * Contextual retrieval: situate a chunk inside its document before embedding
 * it, so a vector carries what the chunk is ABOUT and not just what it says.
 *
 * Three tiers, cheapest first. A chunk whose text has been seen before reuses
 * its context from the committed sidecar cache. A single-chunk document reuses
 * the frontmatter summary, because the chunk IS the document and an LLM call
 * would only paraphrase it. Everything else gets a short generated blurb.
 *
 * A generation failure DEFERS the chunk rather than falling back: context
 * stays NULL and the chunk is not embedded this run, so the missing vector
 * makes the next `--embeddings` run retry both. Persisting a fallback here
 * would look identical to a real context and never be revisited.
 */
import type { Database } from "bun:sqlite";

import { chunkContextKey, loadContextCache } from "./caches.js";
import type { IndexRun } from "./types.js";

/** How many context generations are in flight at once. */
const CONTEXT_CONCURRENCY = 5;

/** A chunk row joined with the document fields context generation needs. */
export interface EmbeddableChunk {
  id: number;
  document_id: number;
  heading: string;
  content: string;
  context: string | null;
  title: string;
  summary: string | null;
  doc_content: string;
  doc_status: string;
  doc_type: string;
}

/** How many chunks each document has — the single-chunk shortcut needs this. */
function chunkCountsByDocument(db: Database): Map<number, number> {
  const rows = db
    .prepare("SELECT document_id, COUNT(*) AS n FROM chunks GROUP BY document_id")
    .all() as { document_id: number; n: number }[];
  return new Map(rows.map((r) => [r.document_id, r.n]));
}

/**
 * Fill in `context` for every chunk that lacks one, and return the ids of the
 * chunks whose generation failed — the caller must not embed those.
 */
export async function generateChunkContexts(
  run: IndexRun,
  chunks: EmbeddableChunk[]
): Promise<Set<number>> {
  const failed = new Set<number>();
  let needsContext = chunks.filter((c) => c.context === null || c.context === undefined);
  if (needsContext.length === 0) return failed;

  const updateContext = run.db.prepare("UPDATE chunks SET context = ? WHERE id = ?");

  // Tier 1: the committed cache. Identical chunk text reuses its context with
  // no call at all — this is what makes a fresh clone cheap.
  const cache = loadContextCache(run.root);
  let cacheHits = 0;
  needsContext = needsContext.filter((c) => {
    const cached = cache.get(chunkContextKey(c.title, c.heading, c.content));
    if (cached === undefined) return true;
    c.context = cached;
    updateContext.run(cached, c.id);
    cacheHits++;
    return false;
  });
  if (cacheHits > 0) run.report(`  Reused ${cacheHits} chunk contexts from cache`);

  const counts = chunkCountsByDocument(run.db);
  const enrichment = run.enrichment;
  let generated = 0;

  for (let i = 0; i < needsContext.length; i += CONTEXT_CONCURRENCY) {
    const batch = needsContext.slice(i, i + CONTEXT_CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map((c) => {
        // Tier 2: single-chunk documents, and any run without enrichment,
        // fall back to the frontmatter summary. Never blocks, never billed.
        if ((counts.get(c.document_id) ?? 1) <= 1 || !enrichment) {
          return Promise.resolve(c.summary ?? "");
        }
        // Tier 3: generate.
        return enrichment.generateChunkContext(c.title, c.doc_content, c.heading, c.content);
      })
    );

    for (let j = 0; j < results.length; j++) {
      const chunk = batch[j];
      const result = results[j];
      if (result.status === "rejected") {
        failed.add(chunk.id);
        run.warn(
          `  SKIP context: chunk ${chunk.id} — ${(result.reason as Error)?.message ?? result.reason}`
        );
        continue;
      }
      chunk.context = result.value;
      updateContext.run(result.value, chunk.id);
      if (result.value) generated++;
    }
  }

  if (generated > 0) run.report(`  Generated ${generated} chunk contexts`);
  if (failed.size > 0) {
    run.warn(
      `  ${failed.size} chunk context(s) failed — deferred to the next --embeddings run`
    );
  }
  return failed;
}
