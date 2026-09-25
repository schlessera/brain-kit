import { SEARCH_SORTS, type SearchOptions } from "../../lib/types.js";
import { hybridSearch, isIsoDate } from "../../lib/search-engine.js";
import { loadVecSupport } from "../../lib/db.js";
import type { CoreCommand } from "../types.js";
import { emit, openReadonlyDb, parseArgs, today, UsageError } from "../io.js";

const DATE_FLAGS = ["updated-since", "updated-before", "deadline-from", "deadline-to"] as const;

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
  --updated-since <date>  Only documents updated on or after this date (YYYY-MM-DD)
  --updated-before <date> Only documents updated on or before this date
  --deadline-from <date>  Only documents with a deadline on or after this date
  --deadline-to <date>    Only documents with a deadline on or before this date
  --sort <order>          score|updated|deadline (default: score); updated is
                          newest first, deadline is earliest first, undated last
  --upcoming              Same as --deadline-from <today> --sort deadline

--json envelope: { "results": SearchResult[], "warnings": string[] }`;

export const searchCommand: CoreCommand = {
  summary: "Hybrid search across the knowledge base",
  helpBlock: HELP,
  async run(args, cli) {
    const { args: pos, flags } = parseArgs(args);
    const query = pos.join(" ") || undefined;

    for (const flag of DATE_FLAGS) {
      const value = flags[flag];
      if (value !== undefined && (typeof value !== "string" || !isIsoDate(value))) {
        throw new UsageError(`--${flag} needs a date written YYYY-MM-DD, got ${JSON.stringify(value)}`);
      }
    }
    if (flags.sort !== undefined && !(SEARCH_SORTS as readonly unknown[]).includes(flags.sort)) {
      throw new UsageError(`--sort must be one of ${SEARCH_SORTS.join(", ")}, got ${JSON.stringify(flags.sort)}`);
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
      updatedSince: flags["updated-since"] as string | undefined,
      updatedBefore: flags["updated-before"] as string | undefined,
      // --upcoming is sugar; an explicit --deadline-from or --sort wins.
      deadlineFrom: (flags["deadline-from"] as string | undefined) ?? (flags.upcoming ? today() : undefined),
      deadlineTo: flags["deadline-to"] as string | undefined,
      sort: (flags.sort as SearchOptions["sort"]) ?? (flags.upcoming ? "deadline" : undefined),
    };

    const dated = opts.updatedSince || opts.updatedBefore || opts.deadlineFrom || opts.deadlineTo;
    if (!query && !opts.type && !opts.tag && !opts.relevance && !opts.status && !dated) {
      throw new UsageError(
        "Provide a search query or at least one filter (--type, --tag, --relevance, a date filter)."
      );
    }

    const db = openReadonlyDb(cli.brain);
    try {
      if (opts.mode !== "fts") {
        // Read path: load the extension only. hybridSearch reports why vector
        // search is unavailable in `warnings`, so the result is not re-warned.
        await loadVecSupport(db);
      }

      const { results, warnings } = await hybridSearch(db, opts, { embeddings: cli.embeddings, taxonomy: cli.brain.taxonomy });

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
