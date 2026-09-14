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
}

/**
 * Fill in `context` for every chunk that lacks one, and return the ids of the
 * chunks whose generation failed — the caller must not embed those.
 */
export async function generateChunkContexts(
  run: IndexRun,
  chunks: EmbeddableChunk[],
  cache: Map<string, string> = loadContextCache(run.root)
): Promise<Set<number>> {
  const failed = new Set<number>();
  let needsContext = chunks.filter((c) => c.context === null || c.context === undefined);
  if (needsContext.length === 0) return failed;

  const updateContext = run.db.prepare("UPDATE chunks SET context = ? WHERE id = ?");

  // Tier 1: the committed cache. Identical chunk text reuses its context with
  // no call at all — this is what makes a fresh clone cheap.
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

  const enrichment = run.enrichment;
  // A page shares each parent body rather than joining (and copying) the whole
  // document onto every chunk. Cached contexts need no parent body at all.
  const documents = new Map<number, { content: string; n: number }>();
  const getDocument = run.db.prepare(`SELECT content,
    (SELECT COUNT(*) FROM chunks WHERE document_id = documents.id) AS n
    FROM documents WHERE id = ?`);
  let generated = 0;

  for (let i = 0; i < needsContext.length; i += CONTEXT_CONCURRENCY) {
    const batch = needsContext.slice(i, i + CONTEXT_CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map((c) => {
        // Tier 2: single-chunk documents, and any run without enrichment,
        // fall back to the frontmatter summary. Never blocks, never billed.
        if (!enrichment) {
          return Promise.resolve(c.summary ?? "");
        }
        let doc = documents.get(c.document_id);
        if (!doc) {
          const row = getDocument.get(c.document_id) as { content: string; n: number } | null;
          if (!row) return Promise.reject(new Error("Document changed during context generation"));
          doc = row;
          documents.set(c.document_id, doc);
        }
        if (doc.n <= 1) return Promise.resolve(c.summary ?? "");
        // Tier 3: generate.
        return enrichment.generateChunkContext(c.title, doc.content, c.heading, c.content);
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
