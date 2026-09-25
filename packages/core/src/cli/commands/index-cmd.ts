import { compactVectors, EmbeddingRunActiveError, forgetCachedEnrichment, indexAll, readVectorSlots } from "../../lib/indexer.js";
import { loadVecSupport, openDatabase, vecTableExists, migrateVecSchema, storedVectorWidth } from "../../lib/db.js";
import type { CoreCommand } from "../types.js";
import { emit, embeddingDims, parseArgs, UsageError } from "../io.js";

const HELP = `brain index — update the search index (incremental by default)

  --force                 Full rebuild instead of incremental update
  --embeddings            Generate vector embeddings (requires an API key)
  --incremental           Accepted as a no-op (backward compat)
  --on-commit             Run as the post-commit hook does: adds the
                          embeddings pass only when the config sets
                          hooks.embedOnCommit and a provider is configured
  --forget-cache <path>   Discard the cached contexts or description of one
                          document or asset, so the next --embeddings run
                          generates them again. Runs no index pass.
  --compact               Rebuild the vector table from its live rows and
                          VACUUM, reclaiming the slots deleted vectors leave.
                          No provider call. Runs no index pass.

--json: IndexStats object; with --forget-cache, { path, forgotten }; with
--compact, { compacted, before, after }.`;

export const indexCommand: CoreCommand = {
  summary: "Update the search index (incremental by default)",
  helpBlock: HELP,
  async run(args, cli) {
    const { flags } = parseArgs(args);
    const dims = embeddingDims(cli.embeddings);

    const forget = flags["forget-cache"];
    if (forget !== undefined) {
      if (typeof forget !== "string") throw new UsageError("--forget-cache needs a path");
      if (flags.force === true || flags.embeddings === true) {
        throw new UsageError("--forget-cache runs alone; run --embeddings afterwards");
      }
    }
    if (flags.compact === true && (flags.force === true || flags.embeddings === true || forget !== undefined)) {
      throw new UsageError("--compact runs alone; run the index separately");
    }

    const db = openDatabase(cli.brain.dbPath, { embeddingDimensions: dims });
    try {
      if (typeof forget === "string") {
        const forgotten = await forgetCachedEnrichment(db, cli.brain.root, forget);
        if (forgotten === null) throw new UsageError(`No indexed document found at: ${forget}`);
        emit(cli.json, { path: forget, forgotten }, () => {
          console.log(
            `Forgot ${forgotten} cache entr${forgotten === 1 ? "y" : "ies"} for ${forget}. ` +
              "Run `brain index --embeddings` to generate them again."
          );
        });
        return;
      }

      if (flags.compact === true) {
        // The read path: loads the extension and migrates nothing, so the
        // rebuild recreates the table exactly as it is.
        if (vecTableExists(db)) await loadVecSupport(db);
        const before = readVectorSlots(db);
        const compacted = compactVectors(db);
        const after = readVectorSlots(db);
        emit(cli.json, { compacted, before, after }, () => {
          if (!compacted) console.log("No vector table: nothing to compact.");
          else console.log(`Vector slots: ${before.allocated} allocated for ${before.live} live, now ${after.allocated}.`);
        });
        return;
      }

      await migrateVecSchema(db, storedVectorWidth(db, dims));

      // Incremental is the default; --force does a full rebuild. --incremental
      // is accepted as a no-op for backward compatibility (hooks pass it).
      const force = flags.force === true;
      // The post-commit hook passes --on-commit and nothing else: whether a
      // commit pays for embeddings is the brain's decision, made here, not in
      // the shell hook. Without a provider it stays the free keyword pass.
      const embedOnCommit =
        flags["on-commit"] === true && cli.brain.config?.hooks?.embedOnCommit === true && !!cli.embeddings;
      const embeddings = flags.embeddings === true || embedOnCommit;

      if (!cli.json) {
        console.log(force ? "Rebuilding full index..." : "Running incremental index...");
        if (force && embeddings) {
          console.warn(
            "Warning: --force with --embeddings re-chunks every document. A chunk whose embedding text is " +
              "unchanged keeps its vector when the provider is the one that produced it; every other chunk, " +
              "and every chunk after a provider change, is a paid embedding call."
          );
        } else if (force) {
          console.warn(
            "Note: --force clears markdown vectors — run `brain index --embeddings` to restore vector search."
          );
        }
      }

      const run = (withEmbeddings: boolean) =>
        indexAll(db, {
          root: cli.brain.root,
          taxonomy: cli.brain.taxonomy,
          force,
          quiet: cli.json,
          embeddings: withEmbeddings,
          provider: withEmbeddings ? cli.embeddings : undefined,
          enrichment: withEmbeddings ? cli.enrichment : undefined,
        });
      let stats: Awaited<ReturnType<typeof run>>;
      try {
        stats = await run(embeddings);
      } catch (error) {
        // Two quick commits: the first commit's hook is still embedding. This
        // one must still make its changes findable by keyword; the embeddings
        // it skips are picked up by the next run, which embeds every chunk
        // without a vector. An explicit --embeddings still reports the clash.
        if (!(error instanceof EmbeddingRunActiveError) || flags.embeddings === true) throw error;
        stats = await run(false);
      }

      emit(cli.json, stats, () => {
        console.log(`\nIndexing complete:`);
        console.log(`  Documents: ${stats.total}`);
        console.log(`  Added: ${stats.added}, Updated: ${stats.updated}, Deleted: ${stats.deleted}, Unchanged: ${stats.unchanged}`);
        console.log(`  Chunks: ${stats.chunks}`);
        if (stats.assets > 0) console.log(`  Assets: ${stats.assets}`);
        if (stats.embeddings > 0) console.log(`  Embeddings: ${stats.embeddings}`);
      });
    } finally {
      db.close();
    }
  },
};
