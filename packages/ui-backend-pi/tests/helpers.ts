/**
 * Test helpers: build a small, keyless (FTS-only) indexed brain in a temp dir.
 * No API keys, no LLM calls — deterministic.
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { initContext, openDatabase, indexAll } from "@endoxa/core";

export interface TempBrain {
  root: string;
  cleanup(): void;
}

const NOTE = (title: string, tags: string[], body: string) =>
  `---\n` +
  `type: note\n` +
  `title: ${title}\n` +
  `created: 2026-01-01\n` +
  `updated: 2026-01-02\n` +
  `tags: [${tags.join(", ")}]\n` +
  `status: active\n` +
  `relevance: primary\n` +
  `---\n\n` +
  body +
  `\n`;

const DEFAULT_DOCS: Record<string, string> = {
  "notes/agentic-retrieval.md": NOTE(
    "Agentic retrieval patterns",
    ["retrieval", "agents"],
    "Hybrid search fuses full-text and vector retrieval. Agentic retrieval lets " +
      "an agent iterate: search, read, refine. This note covers reciprocal rank fusion."
  ),
  "notes/sqlite-vec.md": NOTE(
    "sqlite-vec notes",
    ["sqlite", "vectors"],
    "sqlite-vec adds KNN vector search to SQLite. Distances convert to scores."
  ),
  "notes/cooking.md": NOTE(
    "Sourdough starter",
    ["cooking"],
    "Feed the sourdough starter daily with flour and water. Unrelated to search."
  ),
};

/**
 * Create a temp brain from a set of markdown docs (repo-relative path → content)
 * and index it keyless (FTS-only). Returns the root and a cleanup fn.
 */
export async function makeIndexedBrain(
  docs: Record<string, string> = DEFAULT_DOCS
): Promise<TempBrain> {
  // Force keyless: no embedding provider is resolved, so search is FTS-only.
  delete process.env.GEMINI_API_KEY;
  delete process.env.GOOGLE_API_KEY;

  const root = mkdtempSync(join(tmpdir(), "pi-backend-brain-"));
  for (const [rel, content] of Object.entries(docs)) {
    const abs = join(root, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content, "utf-8");
  }

  const ctx = await initContext({ root });
  const db = openDatabase(ctx.dbPath);
  try {
    await indexAll(db, { root, taxonomy: ctx.taxonomy, force: true, quiet: true });
  } finally {
    db.close();
  }

  return {
    root,
    cleanup() {
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    },
  };
}

/** Concatenate the text parts of a pi tool result (ignores image parts). */
export function resultText(res: {
  content: Array<{ type: string; text?: string }>;
}): string {
  return res.content
    .filter((p) => p.type === "text" && typeof p.text === "string")
    .map((p) => p.text as string)
    .join("");
}

/** An empty temp dir (no index) for path-containment / file-tool tests. */
export function makeEmptyBrain(): TempBrain {
  const root = mkdtempSync(join(tmpdir(), "pi-backend-empty-"));
  return {
    root,
    cleanup() {
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    },
  };
}
