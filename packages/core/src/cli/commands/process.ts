import { rerankSetup } from "../../lib/registry.js";
import { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import { Glob } from "bun";
import { parseFrontmatter } from "../../lib/frontmatter-parse.js";

import type { CompletionProvider } from "../../lib/seams.js";
import { hybridSearch, type SearchDeps } from "../../lib/search-engine.js";
import { safeResolve } from "../../lib/safe-path.js";
import { openDatabase } from "../../lib/db.js";
import type { CliContext, CoreCommand } from "../types.js";
import type { SearchOptions } from "../../lib/types.js";
import { emit, parseArgs, UsageError } from "../io.js";

const HELP = `brain process <path> — assimilate a note into proper brain content

  --keep-note             Keep the original note after processing
  --all                   Batch-process all unprocessed inbox notes

Determines merge/promote/split/keep via a completion provider (Tier-2: needs an
API key). The CLI reports the decision; a skill applies the operations.`;

interface ProcessResult {
  action: "merge" | "promote" | "split" | "keep";
  reasoning: string;
  operations: Array<{ op: "create" | "update" | "archive"; path: string; content: string }>;
}

/** Extract the first balanced JSON object from an LLM response. */
function extractJSON<T>(text: string): T | null {
  const fence = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fence) {
    try {
      return JSON.parse(fence[1].trim()) as T;
    } catch {
      /* fall through */
    }
  }
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") depth--;
    if (depth === 0) {
      try {
        return JSON.parse(text.slice(start, i + 1)) as T;
      } catch {
        return null;
      }
    }
  }
  return null;
}

/** The search a note's related documents come from: the brain's own reranking, as `brain search` does it. */
interface RelatedSearch {
  rerank: SearchOptions["rerank"];
  deps: SearchDeps;
}

function relatedSearch(cli: CliContext): RelatedSearch {
  const setup = rerankSetup(cli.brain.config?.reranker);
  return { rerank: setup.rerank, deps: { embeddings: cli.embeddings, taxonomy: cli.brain.taxonomy, ...setup.deps } };
}

async function searchRelated(query: string, db: Database, search: RelatedSearch): Promise<string> {
  try {
    const { results } = await hybridSearch(db, { query, limit: 5, rerank: search.rerank }, search.deps);
    return results
      .map((r) => `- [${r.type}] ${r.title} (${r.path}): ${r.snippet || r.summary || ""}`)
      .join("\n");
  } catch {
    return "(no search results available)";
  }
}

async function processNote(
  root: string,
  notePath: string,
  db: Database,
  completions: CompletionProvider,
  search: RelatedSearch,
  keepNote: boolean
): Promise<ProcessResult> {
  // notePath is caller/scan-supplied — canonicalize + contain before reading
  // (and before the keepNote=false delete at the end).
  const fullPath = safeResolve(root, notePath);
  if (!fullPath) throw new UsageError(`Path escapes the brain root: ${notePath}`);
  const raw = readFileSync(fullPath, "utf-8");
  const { data, content } = parseFrontmatter(raw);

  const searchQuery = (data.title || "") + " " + content.slice(0, 200).replace(/\n/g, " ");
  const relatedContent = await searchRelated(searchQuery.trim(), db, search);

  const prompt = `I have a note in a file-first knowledge base that needs to be processed. Determine the best action.

Note file: ${notePath}
Note title: ${data.title || "(untitled)"}
Note tags: ${(data.tags || []).join(", ")}
Note content:
---
${content}
---

Related existing documents:
${relatedContent}

Respond with a JSON object:
{
  "action": "<merge | promote | split | keep>",
  "reasoning": "<1-2 sentence explanation>",
  "operations": [ { "op": "<create | update | archive>", "path": "<relative path>", "content": "<markdown body without frontmatter>" } ]
}

- "merge": belongs in an existing document → an "update" op for that file with combined content.
- "promote": should become a proper typed document → a "create" op with the correct path and content.
- "split": multiple distinct topics → multiple "create" ops.
- "keep": fine as-is → empty operations array.
${keepNote ? "Keep the original note file (do not archive it)." : "Include an archive operation for the original note if merging or promoting."}`;

  const responseText = await completions.complete({ prompt, maxTokens: 4000 });
  const result = extractJSON<ProcessResult>(responseText);
  if (!result) {
    return { action: "keep", reasoning: "Could not parse the response; keeping note as-is.", operations: [] };
  }
  return {
    action: result.action || "keep",
    reasoning: result.reasoning || "No reasoning provided.",
    operations: Array.isArray(result.operations) ? result.operations : [],
  };
}

export const processCommand: CoreCommand = {
  summary: "Assimilate a note into proper brain content",
  helpBlock: HELP,
  async run(args, cli) {
    const { args: pos, flags } = parseArgs(args);
    if (!cli.completions) {
      throw new UsageError("`brain process` requires a completion provider (set an API key).");
    }
    const keepNote = flags["keep-note"] === true;
    const inboxDir = cli.brain.taxonomy.dirForType(cli.brain.taxonomy.inboxType()) ?? "notes";

    const db = openDatabase(cli.brain.dbPath);
    try {
      if (flags.all === true) {
        const dir = resolve(cli.brain.root, inboxDir);
        if (!existsSync(dir)) {
          emit(cli.json, [], () => console.log(`No ${inboxDir}/ directory found.`));
          return;
        }
        const glob = new Glob("*.md");
        const noteFiles: string[] = [];
        for (const file of glob.scanSync({ cwd: dir })) {
          const raw = readFileSync(resolve(dir, file), "utf-8");
          try {
            const { data } = parseFrontmatter(raw);
            if (!data.processed && data.status !== "archived") noteFiles.push(`${inboxDir}/${file}`);
          } catch {
            noteFiles.push(`${inboxDir}/${file}`);
          }
        }

        if (noteFiles.length === 0) {
          emit(cli.json, [], () => console.log("No unprocessed notes found."));
          return;
        }

        const results: Array<{ path: string; result: ProcessResult }> = [];
        for (const notePath of noteFiles) {
          if (!cli.json) console.log(`Processing: ${notePath}...`);
          const result = await processNote(cli.brain.root, notePath, db, cli.completions, relatedSearch(cli), keepNote);
          results.push({ path: notePath, result });
          if (!cli.json) {
            console.log(`  Action: ${result.action} — ${result.reasoning}`);
            for (const op of result.operations) console.log(`    ${op.op}: ${op.path}`);
            console.log();
          }
        }
        emit(cli.json, results);
        return;
      }

      const notePath = pos[0];
      if (!notePath) {
        throw new UsageError("Usage: brain process <path> [--keep-note] [--all]");
      }
      const full = safeResolve(cli.brain.root, notePath);
      if (!full || !existsSync(full)) {
        throw new UsageError(`File not found: ${notePath}`);
      }

      const result = await processNote(cli.brain.root, notePath, db, cli.completions, relatedSearch(cli), keepNote);
      emit(cli.json, result, () => {
        console.log(`Action: ${result.action}`);
        console.log(`Reasoning: ${result.reasoning}`);
        if (result.operations.length > 0) {
          console.log(`\nOperations:`);
          for (const op of result.operations) {
            console.log(`  ${op.op}: ${op.path}`);
            if (op.content) {
              console.log(`    Preview: ${op.content.slice(0, 200).replace(/\n/g, " ")}...`);
            }
          }
        }
      });
    } finally {
      db.close();
    }
  },
};
