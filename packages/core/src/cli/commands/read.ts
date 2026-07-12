import { existsSync, readFileSync } from "fs";

import { safeResolve } from "../../lib/safe-path";
import type { CoreCommand } from "../types";
import { parseArgs, UsageError } from "../io";

export const readCommand: CoreCommand = {
  summary: "Read and print a document from the brain",
  helpBlock: "brain read <path> — print a document (frontmatter included).",
  async run(args, cli) {
    const { args: pos } = parseArgs(args);
    const relPath = pos[0];
    if (!relPath) {
      throw new UsageError("Usage: brain read <path>");
    }

    const fullPath = safeResolve(cli.brain.root, relPath);
    if (!fullPath || !existsSync(fullPath)) {
      throw new UsageError(`File not found: ${relPath}`);
    }

    console.log(readFileSync(fullPath, "utf-8"));
  },
};
