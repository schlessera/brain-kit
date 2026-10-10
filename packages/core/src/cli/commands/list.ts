import type { SearchOptions } from "../../lib/types.js";
import { filterSearch } from "../../lib/search-engine.js";
import { DEFAULT_LIST_LIMIT, listLimitSchema, MAX_LIST_LIMIT } from "../../lib/ops/read.js";
import type { CoreCommand } from "../types.js";
import { emit, type Flags, openReadonlyDb, parseArgs, UsageError } from "../io.js";

const HELP = `brain list — list/browse documents

  --type <type>           Filter by document type
  --tag <tag>             Filter by tag
  --status <status>       Filter by status (active|archived|draft)
  --relevance <level>     Filter by relevance
  --limit <n>             Max results, 1-100 (default: 20)

--json: SearchResult[]`;

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
    // Validated before the database is opened: a bad limit runs no query.
    const limit = parseListLimit(flags.limit);
    const db = openReadonlyDb(cli.brain);
    try {
      const opts: SearchOptions = {
        type: flags.type as string | undefined,
        tag: flags.tag as string | undefined,
        status: flags.status as string | undefined,
        relevance: flags.relevance as string | undefined,
        includeArchived: flags.status === "archived" || flags["include-archived"] === true,
        limit,
      };

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
