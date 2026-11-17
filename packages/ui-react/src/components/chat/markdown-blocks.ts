/**
 * Top-level markdown blocks of one text part, for rendering each through its
 * own memoized parse (#2588). A streaming answer grows only at its end, so
 * a finished block whose text has not changed is skipped by `memo` instead
 * of re-parsed on every frame.
 *
 * Splitting must never change what renders: each block parsed alone, joined
 * in order, must give the same HTML as the whole text parsed once. So the
 * split points are conservative, and when in doubt the text is not split:
 *
 * - only at a blank line outside every fenced code block (backtick or tilde,
 *   any fence length, an unclosed fence running to the end);
 * - only where the next line starts at column 0 and does not continue a
 *   list (`-`, `*`, `+`, `1.`, `1)`), a blockquote (`>`) or a table (`|`);
 * - never in a text holding a link reference or footnote definition, which
 *   resolves across the whole document;
 * - never in a text holding a line that starts with HTML (a tag, a comment,
 *   a processing instruction, a declaration or CDATA), at the top level or
 *   after a blockquote or list-item prefix: an HTML block can hold blank
 *   lines and fence markers, and how it ends depends on what follows;
 * - never in a text holding a fence that is indented or inside a blockquote
 *   or list item. Only top-level fences are tracked, and a container fence
 *   can be closed or reopened at column 0 in ways only a full parse knows
 *   (a column-0 closer ends the list item and opens a new top-level fence).
 */

/**
 * A link reference or footnote definition, `[label]: …` or `[^note]: …`,
 * anywhere a definition can stand: after any indentation and any blockquote
 * (`>`) or list-item (`-`, `*`, `+`, `1.`, `1)`) prefixes, with escaped
 * brackets in the label and a label that wraps across lines. Deliberately broad: a false match only means the
 * text parses whole.
 */
const DEFINITION = /^(?:[ \t]|>|[-*+][ \t]|\d{1,9}[.)][ \t])*\[(?:[^\]\\]|\\[\s\S])+\]:/m;
/** A line that starts with HTML, after any indentation and blockquote or list-item prefixes. */
const HTML_LINE = /^(?:[ \t]|>|[-*+][ \t]|\d{1,9}[.)][ \t])*<[A-Za-z/!?]/m;
/** A fence marker that is indented or follows a blockquote or list-item prefix. */
const NESTED_FENCE = /^(?:[ \t]|>|[-*+][ \t]|\d{1,9}[.)][ \t])+(?:`{3,}|~{3,})/m;
/** A top-level fence opener or closer: three or more backticks or tildes at column 0. */
const FENCE = /^(`{3,}|~{3,})/;
/** A blank line as CommonMark counts one: spaces and tabs only (not NBSP or other Unicode space). */
const BLANK = /^[ \t]*$/;
/** A line that would continue the block above a blank line instead of starting a new one. */
const CONTINUES = /^(?:[-*+](?:\s|$)|\d{1,9}[.)](?:\s|$)|>|\||\s)/;

/** The text's top-level blocks, in order; `[text]` when it cannot be split safely. */
export function splitMarkdownBlocks(text: string): string[] {
  if (DEFINITION.test(text) || HTML_LINE.test(text) || NESTED_FENCE.test(text)) return [text];
  const lines = text.split("\n");
  const blocks: string[] = [];
  let start = 0;
  let fence: { char: string; length: number } | null = null;
  let blank = false;
  let content = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const marker = FENCE.exec(line);
    if (fence) {
      // A closing fence: the same character, at least as long, nothing after it.
      if (marker && marker[1]![0] === fence.char && marker[1]!.length >= fence.length && BLANK.test(line.slice(marker[0].length))) fence = null;
      blank = false;
      continue;
    }
    if (BLANK.test(line)) { blank = true; continue; }
    if (blank && content && !CONTINUES.test(line)) {
      // The blank lines stay with the block before, exactly as the whole
      // text has them: how a block ends (an indented code block's trailing
      // whitespace lines) can depend on them.
      blocks.push(lines.slice(start, i).join("\n"));
      start = i;
    }
    blank = false;
    content = true;
    if (marker) {
      // A backtick fence's info string cannot hold a backtick; then it is no fence.
      const info = line.slice(marker[0].length);
      if (marker[1]![0] !== "`" || !info.includes("`")) fence = { char: marker[1]![0]!, length: marker[1]!.length };
    }
  }
  blocks.push(lines.slice(start).join("\n"));
  return blocks;
}
