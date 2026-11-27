import { openDatabase } from "../../lib/db.js";
import { addDocument, splitTags } from "../../lib/ops/write.js";
import type { CoreCommand } from "../types.js";
import { stringFlag } from "../flags.js";
import { emit, parseArgs, UsageError } from "../io.js";
import { runAgent } from "../agent.js";

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

    // Read before the database is opened: a flag without a value writes nothing.
    const type = stringFlag(flags, "type");
    const title = stringFlag(flags, "title");
    const tagList = stringFlag(flags, "tags");
    // As for brain_add: trimmed, empties dropped, and no tags left means none given.
    const split = tagList ? splitTags(tagList) : [];
    const tags = split.length > 0 ? split : undefined;

    const db = openDatabase(cli.brain.dbPath);
    try {
      // The operation behind brain_add: classify, write, and reindex
      // (incremental, no embeddings).
      const result = await addDocument({ db, root: cli.brain.root, taxonomy: cli.brain.taxonomy }, { content, type, title, tags });

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
