import { openDatabase } from "../../lib/db.js";
import { acceptMtimes } from "../../lib/hygiene.js";
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

      // An empty path, like none, baselines every document.
      const changed = acceptMtimes(db, relPath || undefined);
      if (relPath && changed === 0) {
        throw new UsageError(`No indexed document found at: ${relPath}`);
      }

      emit(cli.json, { accepted: changed, path: relPath ?? "(all)" }, () => {
        console.log(`Accepted current mtime for ${changed} document(s)${relPath ? ` (${relPath})` : ""}.`);
      });
    } finally {
      db.close();
    }
  },
};
