import { indexAll } from "../../lib/indexer";
import { openDatabase, initVecSupport } from "../../lib/db";
import type { CoreCommand } from "../types";
import { emit, embeddingDims, parseArgs } from "../io";

const HELP = `brain index — update the search index (incremental by default)

  --force                 Full rebuild instead of incremental update
  --embeddings            Generate vector embeddings (requires an API key)
  --incremental           Accepted as a no-op (backward compat)

--json: IndexStats object.`;

export const indexCommand: CoreCommand = {
  summary: "Update the search index (incremental by default)",
  helpBlock: HELP,
  async run(args, cli) {
    const { flags } = parseArgs(args);
    const dims = embeddingDims(cli.embeddings);

    const db = openDatabase(cli.brain.dbPath, { embeddingDimensions: dims });
    try {
      await initVecSupport(db, dims);

      // Incremental is the default; --force does a full rebuild. --incremental
      // is accepted as a no-op for backward compatibility (hooks pass it).
      const force = flags.force === true;
      const embeddings = flags.embeddings === true;

      if (!cli.json) {
        console.log(force ? "Rebuilding full index..." : "Running incremental index...");
        if (force && embeddings) {
          console.warn(
            "Warning: --force with --embeddings re-embeds every chunk — this re-runs paid embedding calls."
          );
        } else if (force) {
          console.warn(
            "Note: --force clears markdown vectors — run `brain index --embeddings` to restore vector search."
          );
        }
      }

      const stats = await indexAll(db, {
        root: cli.brain.root,
        taxonomy: cli.brain.taxonomy,
        force,
        quiet: cli.json,
        embeddings,
        provider: embeddings ? cli.embeddings : undefined,
        enrichment: embeddings ? cli.enrichment : undefined,
      });

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
