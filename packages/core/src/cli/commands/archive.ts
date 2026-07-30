import type { Database } from "bun:sqlite";

import { archiveDocument } from "../../lib/archiver.js";
import { indexAll } from "../../lib/indexer.js";
import type { CoreCommand } from "../types.js";
import { emit, embeddingDims, parseArgs, UsageError } from "../io.js";

const HELP = `brain archive <path> — set status: archived, move projects/active → projects/archive, reindex

  --dry-run               Show what would happen without changing anything`;

export const archiveCommand: CoreCommand = {
  summary: "Archive a document (set status: archived)",
  helpBlock: HELP,
  async run(args, cli) {
    const { args: pos, flags } = parseArgs(args);
    const relPath = pos[0];
    if (!relPath) {
      throw new UsageError("Usage: brain archive <path> [--dry-run]");
    }

    const dryRun = flags["dry-run"] === true;
    // Reindex hook: archiveDocument opens its own db (fallback path) and calls
    // this with it, so the archiver stays decoupled from the indexer.
    const reindex = dryRun
      ? undefined
      : (db: Database) =>
          indexAll(db, {
            root: cli.brain.root,
            taxonomy: cli.brain.taxonomy,
            force: false,
            quiet: true,
          });

    const result = await archiveDocument(cli.brain.root, relPath, {
      dryRun,
      reindex,
      embeddingDimensions: embeddingDims(cli.embeddings),
    });

    emit(cli.json, result, () => {
      const prefix = result.dryRun ? "Would archive" : "Archived";
      console.log(`${prefix}: ${result.path}`);
      if (result.moved) {
        console.log(`  ${result.dryRun ? "Would move" : "Moved"}: ${relPath} -> ${result.path}`);
      }
    });
  },
};
