import type { SearchOptions } from "../../lib/types.js";
import { filterSearch } from "../../lib/search-engine.js";
import type { CoreCommand } from "../types.js";
import { emit, openReadonlyDb, parseArgs } from "../io.js";

const HELP = `brain list — list/browse documents

  --type <type>           Filter by document type
  --tag <tag>             Filter by tag
  --status <status>       Filter by status (active|archived|draft)
  --relevance <level>     Filter by relevance
  --limit <n>             Max results (default: 20)

--json: SearchResult[]`;

export const listCommand: CoreCommand = {
  summary: "List/browse documents",
  helpBlock: HELP,
  async run(args, cli) {
    const { flags } = parseArgs(args);
    const db = openReadonlyDb(cli.brain);
    try {
      const opts: SearchOptions = {
        type: flags.type as string | undefined,
        tag: flags.tag as string | undefined,
        status: flags.status as string | undefined,
        relevance: flags.relevance as string | undefined,
        includeArchived: flags.status === "archived" || flags["include-archived"] === true,
        limit: flags.limit ? parseInt(flags.limit as string, 10) : 20,
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
