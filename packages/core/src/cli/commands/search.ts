import { SEARCH_SORTS, type SearchOptions } from "../../lib/types.js";
import { hybridSearch, isIsoDate } from "../../lib/search-engine.js";
import { loadVecSupport } from "../../lib/db.js";
import { rerankSetup } from "../../lib/registry.js";
import type { CoreCommand } from "../types.js";
import { enumFlag, positiveIntegerFlag, stringFlag } from "../flags.js";
import { emit, openReadonlyDb, parseArgs, today, UsageError } from "../io.js";

const SEARCH_MODES = ["fts", "vector", "hybrid"] as const satisfies ReadonlyArray<SearchOptions["mode"]>;

const DATE_FLAGS = ["updated-since", "updated-before", "deadline-from", "deadline-to"] as const;

const HELP = `brain search <query> — hybrid FTS5 + vector search

  --type <type>           Filter by document type
  --tag <tag>             Filter by tag
  --relevance <level>     Filter by relevance (primary|secondary|historical)
  --status <status>       Filter by status (active|archived|draft)
  --mode <mode>           Search mode: fts|vector|hybrid (default: hybrid)
  --rerank <mode>         none|heuristic|jev (default: heuristic; configured
                          provider when reranker.enabled is true and available).
                          jev requires opt-in and orders by relevance judgment;
                          heuristic applies lifecycle factors locally
  --rerank-dry-run        Print the exact rerank request to stderr, send
                          nothing, and return the retrieval ordering
  --include-archived      Include archived documents
  --assets-only           Only return non-markdown assets (images, PDFs)
  --chunks                Add each result's chunks that match the query, best
                          first ({ path, chunk_index, heading, content, score })
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
    // Every flag is read here, before the database is opened: a malformed
    // value is a usage error that runs no query (#1352).
    const sort = enumFlag(flags, "sort", SEARCH_SORTS);
    const mode = enumFlag(flags, "mode", SEARCH_MODES) ?? "hybrid";
    const limit = positiveIntegerFlag(flags, "limit") ?? 20;
    const type = stringFlag(flags, "type");
    const tag = stringFlag(flags, "tag");
    const relevance = stringFlag(flags, "relevance");
    const status = stringFlag(flags, "status");

    let setup;
    try {
      setup = rerankSetup(cli.brain.config?.reranker, typeof flags.rerank === "string" ? flags.rerank : undefined, {
        preview: flags["rerank-dry-run"] === true,
      });
    } catch (e) {
      throw new UsageError((e as Error).message);
    }
    const opts: SearchOptions = {
      query,
      mode,
      rerank: setup.rerank,
      type,
      tag,
      relevance,
      status,
      includeArchived: status === "archived" || flags["include-archived"] === true,
      assetsOnly: flags["assets-only"] === true,
      chunks: flags.chunks === true,
      limit,
      // The date flags are checked above; these reads only narrow the type.
      updatedSince: stringFlag(flags, "updated-since"),
      updatedBefore: stringFlag(flags, "updated-before"),
      // --upcoming is sugar; an explicit --deadline-from or --sort wins.
      deadlineFrom: stringFlag(flags, "deadline-from") ?? (flags.upcoming ? today() : undefined),
      deadlineTo: stringFlag(flags, "deadline-to"),
      sort: sort ?? (flags.upcoming ? "deadline" : undefined),
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

      const response = await hybridSearch(db, opts, {
        embeddings: cli.embeddings,
        ...(cli.withheld?.embeddings ? { withheldEmbeddings: cli.withheld.embeddings } : {}),
        taxonomy: cli.brain.taxonomy,
        ...setup.deps,
        ...(flags["rerank-dry-run"] === true
          ? { rerankPreview: (request: unknown) => console.error(JSON.stringify(request, null, 2)) }
          : {}),
      });
      const results = response.results;
      const warnings = setup.warning ? [setup.warning, ...response.warnings] : response.warnings;

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
