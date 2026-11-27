import { archiveWithReindex } from "../../lib/ops/write.js";
import { brainRelativeArgument } from "../../lib/safe-path.js";
import type { CoreCommand } from "../types.js";
import { emit, embeddingDims, parseArgs, UsageError } from "../io.js";

const HELP = `brain archive <path> — set status: archived and a primary or unset relevance to historical, move projects/active → projects/archive, reindex

  --dry-run               Show what would happen without changing anything`;

export const archiveCommand: CoreCommand = {
  summary: "Archive a document (set status: archived)",
  flags: { boolean: ["dry-run"], value: [] },
  helpBlock: HELP,
  async run(args, cli) {
    const { args: pos, flags } = parseArgs(args);
    const relPath = pos[0] && brainRelativeArgument(cli.brain.root, pos[0]);
    if (!relPath) {
      throw new UsageError("Usage: brain archive <path> [--dry-run]");
    }

    // No db: the archiver opens its own handle with the configured width and
    // migrates the vector schema before it reindexes.
    const result = await archiveWithReindex(
      { root: cli.brain.root, taxonomy: cli.brain.taxonomy, embeddingDimensions: embeddingDims(cli.embeddings) },
      { path: relPath, dryRun: flags["dry-run"] === true }
    );

    emit(cli.json, result, () => {
      const prefix = result.dryRun ? "Would archive" : "Archived";
      console.log(`${prefix}: ${result.path}`);
      if (result.moved) {
        console.log(`  ${result.dryRun ? "Would move" : "Moved"}: ${relPath} -> ${result.path}`);
      }
    });
  },
};
