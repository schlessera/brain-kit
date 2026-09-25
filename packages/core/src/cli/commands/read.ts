import { existsSync, readFileSync } from "fs";

import { readDocumentPart, SectionNotFoundError } from "../../lib/document-parts.js";
import { safeResolve } from "../../lib/safe-path.js";
import type { CoreCommand } from "../types.js";
import { parseArgs, UsageError } from "../io.js";

const HELP = `brain read <path> — print a document (frontmatter included)

  --section <heading>     Print one section: its heading to the next heading
                          of the same or higher level
  --max-tokens <n>        When the output would be larger, print the
                          frontmatter and an outline of headings instead.
                          A threshold, not a cap: a large frontmatter or
                          very many headings make the outline larger

Headings are matched on their visible text, ignoring case; when two match,
the first is used. With neither flag the whole file is printed, however long
it is.`;

export const readCommand: CoreCommand = {
  summary: "Read and print a document from the brain",
  helpBlock: HELP,
  async run(args, cli) {
    const { args: pos, flags } = parseArgs(args);
    const relPath = pos[0];
    if (!relPath) {
      throw new UsageError("Usage: brain read <path>");
    }
    if (flags.section === true) {
      throw new UsageError("--section needs a heading");
    }
    let maxTokens: number | undefined;
    if (flags["max-tokens"] !== undefined) {
      maxTokens = typeof flags["max-tokens"] === "string" ? Number(flags["max-tokens"]) : NaN;
      // Number.isSafeInteger, like the MCP input's z.number().int().
      if (!Number.isSafeInteger(maxTokens) || maxTokens <= 0) {
        throw new UsageError("--max-tokens must be a positive safe integer");
      }
    }

    const fullPath = safeResolve(cli.brain.root, relPath);
    if (!fullPath || !existsSync(fullPath)) {
      throw new UsageError(`File not found: ${relPath}`);
    }

    try {
      console.log(
        readDocumentPart(readFileSync(fullPath, "utf-8"), {
          section: flags.section as string | undefined,
          maxTokens,
          sectionHint: '--section "<heading>"',
        })
      );
    } catch (e) {
      if (e instanceof SectionNotFoundError) throw new UsageError(e.message);
      throw e;
    }
  },
};
