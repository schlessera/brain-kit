import type { CoreCommand } from "../types.js";
import { emit, openReadonlyDb } from "../io.js";

export const statsCommand: CoreCommand = {
  summary: "Show corpus statistics",
  helpBlock: "brain stats — document/type/status/relevance/tag/link/chunk counts.",
  async run(_args, cli) {
    const db = openReadonlyDb(cli.brain);
    try {
      const docCount = (db.prepare("SELECT COUNT(*) as count FROM documents").get() as { count: number }).count;
      const typeBreakdown = db.prepare("SELECT type, COUNT(*) as count FROM documents GROUP BY type ORDER BY count DESC").all() as { type: string; count: number }[];
      const statusBreakdown = db.prepare("SELECT status, COUNT(*) as count FROM documents GROUP BY status ORDER BY count DESC").all() as { status: string; count: number }[];
      const relevanceBreakdown = db.prepare("SELECT relevance, COUNT(*) as count FROM documents GROUP BY relevance ORDER BY count DESC").all() as { relevance: string; count: number }[];
      const tagCount = (db.prepare("SELECT COUNT(*) as count FROM tags").get() as { count: number }).count;
      const linkCount = (db.prepare("SELECT COUNT(*) as count FROM links").get() as { count: number }).count;
      const brokenLinks = (db.prepare("SELECT COUNT(*) as count FROM links WHERE target_id IS NULL").get() as { count: number }).count;
      const chunkCount = (db.prepare("SELECT COUNT(*) as count FROM chunks").get() as { count: number }).count;

      let embeddingCount = 0;
      try {
        embeddingCount = (db.prepare("SELECT COUNT(*) as count FROM vec_chunks").get() as { count: number }).count;
      } catch {
        // vec_chunks may not exist
      }

      const stats = {
        documents: docCount,
        byType: Object.fromEntries(typeBreakdown.map((r) => [r.type, r.count])),
        byStatus: Object.fromEntries(statusBreakdown.map((r) => [r.status, r.count])),
        byRelevance: Object.fromEntries(relevanceBreakdown.map((r) => [r.relevance, r.count])),
        tags: tagCount,
        links: linkCount,
        brokenLinks,
        chunks: chunkCount,
        embeddings: embeddingCount,
      };

      emit(cli.json, stats, () => {
        console.log("Brain Statistics\n");
        console.log(`  Documents: ${docCount}`);
        console.log(`  By type:`);
        for (const { type, count } of typeBreakdown) console.log(`    ${type}: ${count}`);
        console.log(`  By status:`);
        for (const { status, count } of statusBreakdown) console.log(`    ${status}: ${count}`);
        console.log(`  By relevance:`);
        for (const { relevance, count } of relevanceBreakdown) console.log(`    ${relevance}: ${count}`);
        console.log(`  Tags: ${tagCount}`);
        console.log(`  Links: ${linkCount} (${brokenLinks} broken)`);
        console.log(`  Chunks: ${chunkCount}`);
        if (embeddingCount > 0) console.log(`  Embeddings: ${embeddingCount}`);
      });
    } finally {
      db.close();
    }
  },
};
