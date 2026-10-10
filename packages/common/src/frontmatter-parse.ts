// Internal to brain-kit: reached through
// `@schlessera/brain-common/internal/frontmatter`, with no compatibility
// promise. Every package that parses frontmatter imports it from there; it
// replaced five byte-identical copies (#1396). See
// docs/decisions/frontmatter-parsing.md.
//
// The only door to gray-matter's parser. Called without options, gray-matter
// keeps every input string in a process-global cache (`matter.cache`) and
// hands back a shallow copy of the cached file for byte-identical input:
// two documents then share one nested `data`, a parse that threw once returns
// `{}` the second time, and the cache never evicts. Passing an options object
// skips the cache entirely, so every parse here does. scripts/check-frontmatter-parse.ts
// refuses any other import of gray-matter.

import matter from "gray-matter";

/** The options gray-matter accepts; all of them pass through unchanged. */
export interface FrontmatterParseOptions extends matter.GrayMatterOption<string, FrontmatterParseOptions> {}

/** A parsed document: `data`, `content`, `matter`, `isEmpty` and the rest. */
export type ParsedFrontmatter = matter.GrayMatterFile<string>;

/**
 * Parse a document's frontmatter, independently of every other parse in the
 * process. The caller's options are kept; an object is always passed, so the
 * global cache is neither read nor written.
 */
export function parseFrontmatter(input: string, options?: FrontmatterParseOptions): ParsedFrontmatter {
  return matter(input, { ...options });
}
