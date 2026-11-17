import { rerankSetup } from "../../lib/registry.js";
import { assembleContext, coverageNote, emptyContextCoverage } from "../../lib/context-assembler.js";
import { parseContextScope } from "../../lib/context-scope.js";
import { loadVecSupport } from "../../lib/db.js";
import type { CoreCommand } from "../types.js";
import { positiveIntegerFlag, repeatedFlag } from "../flags.js";
import { openReadonlyDb, parseArgs, UsageError } from "../io.js";

const HELP = `brain context <query> — assemble a token-limited context block

  --max-tokens <n>        Token budget (default: 4000)
  --include <path>        Only draw on this path; repeatable. An exact file
                          path, or a folder ending in "/" for everything under it
  --exclude <path>        Never draw on this path; repeatable. Wins over --include

Output: assembled markdown context (plain text, never JSON). With --include or
--exclude, a "### Coverage" note follows it, outside the budget.`;

export const contextCommand: CoreCommand = {
  summary: "Assemble a context block for agent consumption",
  helpBlock: HELP,
  async run(args, cli) {
    const { args: pos, flags } = parseArgs(args);
    const query = pos.join(" ");
    if (!query) {
      throw new UsageError("Usage: brain context <query> [--max-tokens N] [--include PATH]... [--exclude PATH]...");
    }

    // Read before the database is opened: a malformed budget or scope runs no query.
    const maxTokens = positiveIntegerFlag(flags, "max-tokens");
    const scope = { include: repeatedFlag(args, "include"), exclude: repeatedFlag(args, "exclude") };
    let scoped: boolean;
    try {
      scoped = parseContextScope(scope) !== null;
    } catch (e) {
      throw new UsageError((e as Error).message);
    }
    const coverage = scoped ? emptyContextCoverage() : undefined;

    const db = openReadonlyDb(cli.brain);
    try {
      await loadVecSupport(db);
      const context = await assembleContext(db, cli.brain, {
        query,
        maxTokens,
        embeddings: cli.embeddings,
        rerank: rerankSetup(cli.brain.config?.reranker),
        ...(scoped ? { scope, coverage } : {}),
      });
      // Context is always plain-text output (contract: markdown, not an envelope).
      console.log(coverage ? `${context}${context ? "\n\n" : ""}${coverageNote(coverage)}` : context);
    } finally {
      db.close();
    }
  },
};
