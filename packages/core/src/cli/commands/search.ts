import type { SearchOptions } from "../../lib/types";
import { hybridSearch } from "../../lib/search-engine";
import { initVecSupport } from "../../lib/db";
import type { CoreCommand } from "../types";
import { emit, embeddingDims, openReadonlyDb, parseArgs, UsageError } from "../io";

const HELP = `brain search <query> — hybrid FTS5 + vector search

  --type <type>           Filter by document type
  --tag <tag>             Filter by tag
  --relevance <level>     Filter by relevance (primary|secondary|historical)
  --status <status>       Filter by status (active|archived|draft)
  --mode <mode>           Search mode: fts|vector|hybrid (default: hybrid)
  --rerank <mode>         Rerank mode: none|heuristic (default: heuristic)
  --include-archived      Include archived documents
  --assets-only           Only return non-markdown assets (images, PDFs)
  --limit <n>             Max results (default: 20)

--json envelope: { "results": SearchResult[], "warnings": string[] }`;

export const searchCommand: CoreCommand = {
  summary: "Hybrid search across the knowledge base",
  helpBlock: HELP,
  async run(args, cli) {
    const { args: pos, flags } = parseArgs(args);
    const query = pos.join(" ") || undefined;

    const db = openReadonlyDb(cli.brain);
    try {
      if (flags.mode !== "fts") {
        await initVecSupport(db, embeddingDims(cli.embeddings));
      }

      const opts: SearchOptions = {
        query,
        mode: (flags.mode as SearchOptions["mode"]) || "hybrid",
        rerank: flags.rerank ? (flags.rerank as SearchOptions["rerank"]) : undefined,
        type: flags.type as string | undefined,
        tag: flags.tag as string | undefined,
        relevance: flags.relevance as string | undefined,
        status: flags.status as string | undefined,
        includeArchived: flags.status === "archived" || flags["include-archived"] === true,
        assetsOnly: flags["assets-only"] === true,
        limit: flags.limit ? parseInt(flags.limit as string, 10) : 20,
      };

      if (!query && !opts.type && !opts.tag && !opts.relevance && !opts.status) {
        throw new UsageError(
          "Provide a search query or at least one filter (--type, --tag, --relevance)."
        );
      }

      const { results, warnings } = await hybridSearch(db, opts, { embeddings: cli.embeddings });

      emit(cli.json, { results, warnings }, () => {
        for (const warning of warnings) console.log(`Warning: ${warning}`);
        if (warnings.length > 0) console.log();
        if (results.length === 0) {
          console.log("No results found.");
          return;
        }
        console.log(`Found ${results.length} result(s):\n`);
        for (const r of results) {
          console.log(`  ${r.path}`);
          console.log(`    Title: ${r.title}`);
          console.log(`    Type: ${r.type} | Relevance: ${r.relevance} | Status: ${r.status || "active"}`);
          if (r.tags) console.log(`    Tags: ${r.tags}`);
          if (r.summary) console.log(`    Summary: ${r.summary}`);
          if (r.snippet) console.log(`    Snippet: ${r.snippet}`);
          if (r.score) console.log(`    Score: ${r.score.toFixed(4)}`);
          console.log();
        }
      });
    } finally {
      db.close();
    }
  },
};
