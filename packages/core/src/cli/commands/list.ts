import type { SearchOptions } from "../../lib/types.js";
import { filterSearch } from "../../lib/search-engine.js";
import { DEFAULT_LIST_LIMIT, listLimitSchema, MAX_LIST_LIMIT, pageDocuments } from "../../lib/ops/read.js";
import { indexStaleness } from "../../lib/ops/staleness.js";
import type { CoreCommand } from "../types.js";
import { stringFlag } from "../flags.js";
import { emit, type Flags, openReadonlyDb, parseArgs, UsageError } from "../io.js";
import { DocumentPageError, normalizePathPrefix } from "../../lib/document-page.js";

const HELP = `brain list — list/browse documents

  --type <type>           Filter by document type
  --tag <tag>             Filter by tag
  --status <status>       Filter by status (active|archived|draft)
  --relevance <level>     Filter by relevance
  --limit <n>             Max results, 1-100 (default: 20)
  --path-prefix <path>    Only documents at or below this folder or file (whole segments)
  --overview              Add summary, updated, deadline, indexed_at, indexed_body_bytes
  --cursor <cursor>       Continue a paged listing from its next_cursor

--json: SearchResult[]; with --path-prefix, --overview or --cursor,
        { documents, next_cursor, total, truncated?, warnings } (one bounded page)`;

/**
 * `--limit` as a whole number from 1 to MAX_LIST_LIMIT, or the default when it
 * is absent. The whole argument must be an integer literal: `10abc` and `1.5`
 * are refused rather than read as 10 and 1, and a missing value or an
 * out-of-range one is refused rather than clamped (#1351).
 */
export function parseListLimit(raw: Flags[string] | undefined): number {
  if (raw === undefined) return DEFAULT_LIST_LIMIT;
  const parsed = typeof raw === "string" && /^-?\d+$/.test(raw) ? listLimitSchema.safeParse(Number(raw)) : undefined;
  if (!parsed?.success) {
    throw new UsageError(`--limit must be a whole number from 1 to ${MAX_LIST_LIMIT}`);
  }
  return parsed.data;
}

export const listCommand: CoreCommand = {
  summary: "List/browse documents",
  helpBlock: HELP,
  async run(args, cli) {
    const { flags } = parseArgs(args);
    // Validated before the database is opened: a bad limit or a filter flag
    // without a value runs no query.
    const limit = parseListLimit(flags.limit);
    const status = stringFlag(flags, "status");
    const opts: SearchOptions = {
      type: stringFlag(flags, "type"),
      tag: stringFlag(flags, "tag"),
      status,
      relevance: stringFlag(flags, "relevance"),
      includeArchived: status === "archived" || flags["include-archived"] === true,
      limit,
    };
    const pathPrefix = stringFlag(flags, "path-prefix");
    const cursor = stringFlag(flags, "cursor");
    const paged = pathPrefix !== undefined || cursor !== undefined || flags.overview === true;
    if (pathPrefix !== undefined) {
      try {
        normalizePathPrefix(pathPrefix);
      } catch (e) {
        throw new UsageError(`--path-prefix: ${(e as Error).message}`);
      }
    }
    const db = openReadonlyDb(cli.brain);
    try {
      if (paged) {
        // The shared paged operation (#3643): the same page brain_list and
        // pi's brain_list return for the same index.
        const { stale } = indexStaleness(db, cli.brain.root, cli.brain.taxonomy);
        const warnings = stale > 0 ? [`index is stale (${stale} file(s) newer than index); run \`brain index\``] : [];
        let page;
        try {
          page = pageDocuments(
            { db, root: cli.brain.root },
            {
              type: opts.type,
              tag: opts.tag,
              status: opts.status,
              relevance: opts.relevance,
              // As a filter of its own, so a cursor reads the same on every surface.
              includeArchived: flags["include-archived"] === true,
              limit,
              pathPrefix,
              cursor,
              overview: flags.overview === true,
            },
            warnings
          );
        } catch (e) {
          if (e instanceof DocumentPageError) throw new UsageError(`${e.code === "invalid_prefix" ? "--path-prefix" : "--cursor"}: ${e.message}`);
          throw e;
        }
        emit(cli.json, page, () => {
          for (const w of page.warnings) console.error(`warning: ${w}`);
          if (page.documents.length === 0) {
            console.log("No documents found.");
            return;
          }
          console.log(`${page.documents.length} of ${page.total} document(s):\n`);
          for (const r of page.documents) {
            const meta = [r.type, r.relevance, r.status || "active", ...(r.updated ? [`updated ${r.updated}`] : []), ...(r.deadline ? [`due ${r.deadline}`] : [])].join(" | ");
            console.log(`  ${r.path}`);
            console.log(`    ${r.title} (${meta})`);
            if (r.summary) console.log(`    ${r.summary}`);
            if (r.tags) console.log(`    Tags: ${r.tags}`);
            console.log();
          }
          if (page.next_cursor) console.log(`More: --cursor ${page.next_cursor}`);
        });
        return;
      }

      const results = filterSearch(db, opts);

      emit(cli.json, results, () => {
        if (results.length === 0) {
          console.log("No documents found.");
          return;
        }
        console.log(`${results.length} document(s):\n`);
        for (const r of results) {
          const meta = [r.type, r.relevance, r.status || "active"].join(" | ");
          console.log(`  ${r.path}`);
          console.log(`    ${r.title} (${meta})`);
          if (r.tags) console.log(`    Tags: ${r.tags}`);
          console.log();
        }
      });
    } finally {
      db.close();
    }
  },
};
