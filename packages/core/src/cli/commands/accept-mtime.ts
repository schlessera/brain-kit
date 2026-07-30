import { openDatabase } from "../../lib/db.js";
import type { CoreCommand } from "../types.js";
import { emit, parseArgs, UsageError } from "../io.js";

const HELP = `brain accept-mtime [path] — baseline current file mtimes as non-suspicious

Stops silent-edit checks from flagging deliberate mechanical migrations
(all documents, or a single path).`;

export const acceptMtimeCommand: CoreCommand = {
  summary: "Baseline current file mtimes so silent-edit checks stop flagging them",
  helpBlock: HELP,
  async run(args, cli) {
    const { args: pos } = parseArgs(args);
    const db = openDatabase(cli.brain.dbPath);
    try {
      const relPath = pos[0];

      let changed: number;
      if (relPath) {
        const result = db
          .prepare(
            "UPDATE documents SET accepted_mtime = file_mtime WHERE path = ? AND file_mtime IS NOT NULL"
          )
          .run(relPath);
        changed = result.changes;
        if (changed === 0) {
          throw new UsageError(`No indexed document found at: ${relPath}`);
        }
      } else {
        const result = db
          .prepare("UPDATE documents SET accepted_mtime = file_mtime WHERE file_mtime IS NOT NULL")
          .run();
        changed = result.changes;
      }

      emit(cli.json, { accepted: changed, path: relPath ?? "(all)" }, () => {
        console.log(`Accepted current mtime for ${changed} document(s)${relPath ? ` (${relPath})` : ""}.`);
      });
    } finally {
      db.close();
    }
  },
};
