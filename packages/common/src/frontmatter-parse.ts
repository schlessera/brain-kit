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

/** gray-matter options plus the first-party YAML/data-only boundary. */
export interface FrontmatterParseOptions extends matter.GrayMatterOption<string, FrontmatterParseOptions> {
  /** Refuse executable/unsupported selection before dispatch; only explicit legacy callers also permit JSON. */
  dataOnly?: boolean | "yaml-json";
  /** Aliases accepted by gray-matter defaults but absent from its published types. */
  delims?: string | string[];
  lang?: string;
}

/** A parsed document: `data`, `content`, `matter`, `isEmpty` and the rest. */
export type ParsedFrontmatter = matter.GrayMatterFile<string>;

/**
 * Parse a document's frontmatter, independently of every other parse in the
 * process. The caller's options are kept; an object is always passed, so the
 * global cache is neither read nor written.
 */
export function parseFrontmatter(input: string, options?: FrontmatterParseOptions): ParsedFrontmatter {
  const { dataOnly, ...parserOptions } = options ?? {};
  if (dataOnly) assertDataLanguage(input, parserOptions, dataOnly === "yaml-json");
  return matter(input, { ...parserOptions });
}

/** Mirror gray-matter 4.0.3's selection, including BOM, delimiter aliases and no-newline input. */
function assertDataLanguage(input: string, options: FrontmatterParseOptions, allowJson: boolean): void {
  const delimiters = options.delims || options.delimiters || "---";
  const open = Array.isArray(delimiters) ? delimiters[0]! : delimiters;
  const text = input.replace(/^\uFEFF/, "");
  // Four dashes (or the corresponding repeated custom delimiter) are ordinary prose.
  if (!text.startsWith(open) || text.charAt(open.length) === open.slice(-1)) return;
  const rest = text.slice(open.length);
  // language() uses slice(0, -1) when there is no newline. Preserve that edge too.
  const declared = rest.slice(0, rest.search(/\r?\n/)).trim();
  const language = declared || (options.language || options.lang || "yaml").toLowerCase();
  if (!/^(yaml|yml)$/i.test(language) && !(allowJson && language === "json"))
    throw new Error(`Unsupported frontmatter language ${JSON.stringify(language)}; use ${allowJson ? "YAML or JSON" : "YAML"} data only`);
}
