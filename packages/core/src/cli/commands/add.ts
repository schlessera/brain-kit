import type { DocumentType } from "../../lib/types";
import { ingest } from "../../lib/ingestion";
import { openDatabase } from "../../lib/db";
import type { CoreCommand } from "../types";
import { emit, parseArgs, UsageError } from "../io";
import { runAgent } from "../agent";

const HELP = `brain add "<content>" — quick-capture content into the brain

  --type <type>           Explicit document type
  --title <title>         Explicit title
  --tags <a,b,c>          Comma-separated tags
  --smart                 Delegate to the coding agent (search, classify, route)`;

export const addCommand: CoreCommand = {
  summary: "Quick-add content to the brain",
  helpBlock: HELP,
  async run(args, cli) {
    const { args: pos, flags } = parseArgs(args);
    const content = pos.join(" ");
    if (!content) {
      throw new UsageError('Usage: brain add "<content>" [--type X] [--title X] [--tags a,b] [--smart]');
    }

    if (flags.smart === true) {
      // Delegate to the coding-agent CLI with the /add skill: it searches,
      // classifies, writes, and reindexes. Output streams to the terminal.
      if (!cli.agentRunner) {
        throw new UsageError("`--smart` requires an agent runner (none configured/available).");
      }
      await runAgent(cli.agentRunner, `/add ${content}`, cli.brain.root);
      return;
    }

    const db = openDatabase(cli.brain.dbPath);
    try {
      const tags = flags.tags
        ? (flags.tags as string).split(",").map((t) => t.trim())
        : undefined;
      // ingest() reindexes internally (incremental, no embeddings) via its
      // injected reindex → indexAll hook.
      const result = await ingest(
        {
          content,
          type: flags.type as DocumentType | undefined,
          title: flags.title as string | undefined,
          tags,
        },
        db,
        { root: cli.brain.root, taxonomy: cli.brain.taxonomy }
      );

      emit(cli.json, result, () => {
        console.log(`${result.action}: ${result.path}`);
        console.log(`  Title: ${result.title}`);
        console.log(`  Type: ${result.type}`);
        if (!result.indexed) {
          console.log(`  Warning: file written but indexing failed (${result.indexError}) — run \`brain index\``);
        }
      });
    } finally {
      db.close();
    }
  },
};
