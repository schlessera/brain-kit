/**
 * Which strategy merges a conflicted file, chosen from what the file is:
 * first match wins.
 *
 * 1. a derived cache → `cache-union` (pull already unions them);
 * 2. not markdown, or `CLAUDE.md` / `AGENTS.md` / `GEMINI.md` → `code-merge`;
 * 3. its taxonomy type sets `mergeStrategy` → that;
 * 4. an `_index.md` → `table-union`;
 * 5. any side has a `Timeline` heading → `timeline-append`;
 * 6. anything else → `synthesize`.
 */

import { parseFrontmatter } from "@schlessera/brain-common/internal/frontmatter";
import { basename } from "path";

import { SIDECAR_CACHES } from "../../cache-attributes.js";
import { frontmatterLength } from "../../document-parts.js";
import type { Taxonomy } from "../../taxonomy.js";
import type { MergeStrategy } from "../types.js";
import { headingTexts, isTimelineHeading, UnparseableError } from "./markdown.js";

export interface MergeSides {
  base: string | null;
  ours: string | null;
  theirs: string | null;
}

const CODE_MARKDOWN = new Set(["CLAUDE.md", "AGENTS.md", "GEMINI.md"]);

/**
 * The file's taxonomy type: the `type` its frontmatter declares (OURS, then
 * THEIRS, then BASE) when the taxonomy knows it, else the type whose
 * directory holds it. Not `typeForPath`: that falls back to the inbox type,
 * which would give every unmatched document the inbox's strategy.
 */
function typeOf(path: string, taxonomy: Taxonomy, sides: MergeSides): string | null {
  for (const text of [sides.ours, sides.theirs, sides.base]) {
    if (text === null || frontmatterLength(text) === 0) continue;
    let declared: unknown;
    try {
      declared = parseFrontmatter(text).data.type;
    } catch {
      continue;
    }
    if (typeof declared === "string" && taxonomy.isValidType(declared)) return declared;
  }
  let best: { type: string; length: number } | null = null;
  for (const [type, spec] of Object.entries(taxonomy.types)) {
    for (const prefix of spec.prefixes) {
      if (path.startsWith(prefix) && (!best || prefix.length > best.length)) best = { type, length: prefix.length };
    }
  }
  return best?.type ?? null;
}

export function strategyFor(path: string, taxonomy: Taxonomy, sides: MergeSides): MergeStrategy {
  const name = basename(path);
  if ((SIDECAR_CACHES as readonly string[]).includes(name)) return "cache-union";
  if (!name.toLowerCase().endsWith(".md") || CODE_MARKDOWN.has(name)) return "code-merge";
  const type = typeOf(path, taxonomy, sides);
  const configured = type ? taxonomy.types[type]?.mergeStrategy : undefined;
  if (configured) return configured;
  if (name === "_index.md") return "table-union";
  for (const text of [sides.base, sides.ours, sides.theirs]) {
    if (text !== null && !text.includes("\u0000") && timelineIn(text)) return "timeline-append";
  }
  return "synthesize";
}

/** Whether `text` has a Timeline heading; a body too deep to parse has none, and its merge reports why. */
function timelineIn(text: string): boolean {
  try {
    return headingTexts(text).some(isTimelineHeading);
  } catch (e) {
    if (e instanceof UnparseableError) return false;
    throw e;
  }
}
