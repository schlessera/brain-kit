import { assembleContext } from "../../lib/context-assembler.js";
import { loadVecSupport } from "../../lib/db.js";
import type { CoreCommand } from "../types.js";
import { openReadonlyDb, parseArgs, UsageError } from "../io.js";

const HELP = `brain context <query> — assemble a token-limited context block

  --max-tokens <n>        Token budget (default: 4000)

Output: assembled markdown context (plain text, never JSON).`;

export const contextCommand: CoreCommand = {
  summary: "Assemble a context block for agent consumption",
  helpBlock: HELP,
  async run(args, cli) {
    const { args: pos, flags } = parseArgs(args);
    const query = pos.join(" ");
    if (!query) {
      throw new UsageError("Usage: brain context <query> [--max-tokens N]");
    }

    const db = openReadonlyDb(cli.brain);
    try {
      await loadVecSupport(db);
      const maxTokens = flags["max-tokens"]
        ? parseInt(flags["max-tokens"] as string, 10)
        : undefined;
      const context = await assembleContext(db, cli.brain, {
        query,
        maxTokens,
        embeddings: cli.embeddings,
      });
      // Context is always plain-text output (contract: markdown, not an envelope).
      console.log(context);
    } finally {
      db.close();
    }
  },
};
