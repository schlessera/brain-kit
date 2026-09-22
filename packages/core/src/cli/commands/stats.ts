import { collectStats } from "../../lib/stats.js";
import { DEFAULT_STATS_THRESHOLDS } from "../../lib/config.js";
import type { CoreCommand } from "../types.js";
import { emit, openReadonlyDb } from "../io.js";

const HELP = `brain stats — corpus statistics and health figures

Counts: documents (by type/status/relevance), tags, links, chunks, embeddings.
Health: broken-link rate, embedding coverage, stale / orphan / untagged
documents. Stale and orphan mean what \`brain audit\` means — the per-type
staleDays and orphanExempt from the taxonomy; there is no second threshold.
Size: corpus bytes and files on disk (configured excludes apply), brain.db
bytes and row counts, free space on the volume.

Warn levels come from the \`stats\` config block, defaulting to
coverageFloor ${DEFAULT_STATS_THRESHOLDS.coverageFloor}, brokenLinkCeiling ${DEFAULT_STATS_THRESHOLDS.brokenLinkCeiling}.
A figure that cannot be measured is reported as null, never as 0.`;

function pct(ratio: number | null): string {
  return ratio === null ? "n/a" : `${(ratio * 100).toFixed(1)}%`;
}

function mb(bytes: number | null): string {
  return bytes === null ? "n/a" : `${(bytes / 1_048_576).toFixed(1)} MB`;
}

export const statsCommand: CoreCommand = {
  summary: "Show corpus statistics",
  helpBlock: HELP,
  async run(_args, cli) {
    const db = openReadonlyDb(cli.brain);
    try {
      const stats = await collectStats(db, {
        root: cli.brain.root,
        dbPath: cli.brain.dbPath,
        taxonomy: cli.brain.taxonomy,
        config: cli.brain.config,
        embeddingsConfigured: cli.embeddings !== undefined || cli.brain.config?.embeddings !== undefined,
      });

      emit(cli.json, stats, () => {
        const { health, size } = stats;
        console.log("Brain Statistics\n");
        console.log(`  Documents: ${stats.documents}`);
        console.log(`  By type:`);
        for (const [type, count] of Object.entries(stats.byType)) console.log(`    ${type}: ${count}`);
        console.log(`  By status:`);
        for (const [status, count] of Object.entries(stats.byStatus)) console.log(`    ${status}: ${count}`);
        console.log(`  By relevance:`);
        for (const [relevance, count] of Object.entries(stats.byRelevance)) console.log(`    ${relevance}: ${count}`);
        console.log(`  Tags: ${stats.tags}`);
        console.log(`  Links: ${stats.links} (${stats.brokenLinks} broken, ${pct(health.brokenLinkRate)})`);
        console.log(`  Chunks: ${stats.chunks}`);
        if (stats.embeddings > 0) console.log(`  Embeddings: ${stats.embeddings}`);
        console.log(`  Embedding coverage: ${pct(health.embeddingCoverage)}`);
        console.log(`  Stale: ${health.stale}`);
        console.log(`  Orphans: ${health.orphans}`);
        console.log(`  Untagged: ${health.untagged}`);
        console.log(
          `  Corpus: ${size.corpus ? `${size.corpus.files} files, ${mb(size.corpus.bytes)}` : "n/a"}`
        );
        console.log(`  Index: ${mb(size.db.bytes)}`);
        console.log(`  Free space: ${mb(size.freeBytes)}`);
      });
    } finally {
      db.close();
    }
  },
};
