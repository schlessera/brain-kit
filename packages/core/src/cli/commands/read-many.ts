import { readFileSync } from "fs";

import {
  READ_MANY_DEFAULT_ITEM_CHARS,
  READ_MANY_DEFAULT_TOTAL_CHARS,
  READ_MANY_MAX_REQUESTS,
  readMany,
  ReadManyRequestError,
  type ReadManyItem,
} from "../../lib/ops/read-many.js";
import { brainRelativeArgument } from "../../lib/safe-path.js";
import type { CoreCommand } from "../types.js";
import { parseArgs, UsageError, type Flags } from "../io.js";

const HELP = `brain read-many <path>... — read several documents under one size cap

  --input <file.json>     Read the whole request from a JSON file instead:
                          { "requests": [{ "path", "section"?, "offset"?,
                          "column"?, "expected_sha256"? }], "max_total_chars"?,
                          "max_item_chars"? } — the brain_read_many input
  --stdin                 The same JSON, from standard input
  --max-total-chars <n>   Cap on the whole JSON result, 2000-40000
                          (default ${READ_MANY_DEFAULT_TOTAL_CHARS})
  --max-item-chars <n>    Cap on one item's JSON, 512 to the total cap
                          (default ${READ_MANY_DEFAULT_ITEM_CHARS})

Up to ${READ_MANY_MAX_REQUESTS} requests. Each item is full, outline, partial (with next
offset/column to continue), duplicate or error; see brain_read_many.

--json: { items, truncated, max_total_chars, max_item_chars, warnings }`;

/** A cap flag as an integer literal; the range is checked by the operation, which refuses rather than clamps. */
function capFlag(flags: Flags, name: string): number | undefined {
  const raw = flags[name];
  if (raw === undefined) return undefined;
  if (typeof raw !== "string" || !/^-?\d+$/.test(raw)) throw new UsageError(`--${name} must be a whole number`);
  return Number(raw);
}

function parseJsonInput(text: string, from: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new UsageError(`${from} is not valid JSON`);
  }
}

function human(items: ReadManyItem[]): void {
  for (const item of items) {
    const label = `${item.path}${item.section !== undefined ? ` § ${item.section}` : ""}`;
    switch (item.kind) {
      case "full":
        console.log(`=== [${item.index}] ${label} (full, sha256 ${item.sha256})\n${item.content}`);
        break;
      case "outline":
        console.log(`=== [${item.index}] ${label} (outline: ~${item.est_tokens} tokens, sha256 ${item.sha256})`);
        if (item.frontmatter !== undefined) console.log(item.frontmatter.replace(/\r?\n$/, ""));
        for (const h of item.headings) console.log(`${"  ".repeat(h.level - 1)}- ${"#".repeat(h.level)} ${h.text} (~${h.est_tokens} tokens)`);
        if (item.omitted_headings) console.log(`… ${item.omitted_headings} more heading(s)`);
        break;
      case "partial":
        console.log(
          `=== [${item.index}] ${label} (page from line ${item.offset}${item.column ? `:${item.column}` : ""}, ` +
            `${item.next ? `continue at offset ${item.next.offset}${item.next.column !== undefined ? ` column ${item.next.column}` : ""}` : "last page"}, sha256 ${item.sha256})\n${item.text}`
        );
        break;
      case "duplicate":
        console.log(`=== [${item.index}] ${label} (same as [${item.of}])`);
        break;
      case "error":
        console.log(`=== [${item.index}] ${label} (${item.code}) ${item.message}`);
        break;
    }
  }
}

export const readManyCommand: CoreCommand = {
  summary: "Read several documents or sections under one size cap",
  helpBlock: HELP,
  async run(args, cli) {
    const { args: pos, flags } = parseArgs(args);
    const fromFile = typeof flags.input === "string" ? flags.input : undefined;
    if (flags.input === true) throw new UsageError("--input needs a file");
    const fromStdin = flags.stdin === true;
    const sources = [pos.length > 0, fromFile !== undefined, fromStdin].filter(Boolean).length;
    if (sources !== 1) throw new UsageError("Usage: brain read-many <path>... | --input <file.json> | --stdin");

    let input: unknown;
    if (pos.length > 0) {
      const totalCap = capFlag(flags, "max-total-chars");
      const itemCap = capFlag(flags, "max-item-chars");
      input = {
        requests: pos.map((p) => ({ path: brainRelativeArgument(cli.brain.root, p) })),
        ...(totalCap !== undefined ? { max_total_chars: totalCap } : {}),
        ...(itemCap !== undefined ? { max_item_chars: itemCap } : {}),
      };
    } else {
      if (flags["max-total-chars"] !== undefined || flags["max-item-chars"] !== undefined)
        throw new UsageError("--max-total-chars and --max-item-chars go in the JSON input with --input or --stdin");
      let text: string;
      if (fromFile !== undefined) {
        try {
          text = readFileSync(fromFile, "utf8");
        } catch {
          throw new UsageError(`cannot read --input ${fromFile}`);
        }
      } else {
        text = await Bun.stdin.text();
      }
      input = parseJsonInput(text, fromFile !== undefined ? "--input" : "standard input");
    }

    try {
      const result = await readMany(cli.brain.root, input);
      // Compact, so the printed JSON is exactly the text the caps count.
      if (cli.json) console.log(JSON.stringify(result));
      else human(result.items);
    } catch (e) {
      if (e instanceof ReadManyRequestError) throw new UsageError(e.message);
      throw e;
    }
  },
};
