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
 * - never in a text holding an HTML block that may contain blank lines
 *   (`<pre>`, `<script>`, `<style>`, `<textarea>`, a comment, a processing
 *   instruction, a declaration or CDATA), at the top level or inside a
 *   blockquote or list item;
 * - never in a text holding a fence that is indented or inside a blockquote
 *   or list item. Only top-level fences are tracked, and a container fence
 *   can be closed or reopened at column 0 in ways only a full parse knows
 *   (a column-0 closer ends the list item and opens a new top-level fence);
 * - never in a text where a fence marker stands in a run of lines that began
 *   with an HTML tag (`<details>`, `<div>`): such a line may belong to an
 *   HTML block, which no fence opens or closes, until a blank line.
 */

/**
 * A link reference or footnote definition, `[label]: …` or `[^note]: …`,
 * anywhere a definition can stand: after any indentation and any blockquote
 * (`>`) or list-item (`-`, `*`, `+`, `1.`, `1)`) prefixes, with escaped
 * brackets in the label and a label that wraps across lines. Deliberately broad: a false match only means the
 * text parses whole.
 */
const DEFINITION = /^(?:[ \t]|>|[-*+][ \t]|\d{1,9}[.)][ \t])*\[(?:[^\]\\]|\\[\s\S])+\]:/m;
/** CommonMark HTML blocks of types 1 to 5, whose end is not a blank line. */
const LONG_HTML = /^(?:[ \t]|>|[-*+][ \t]|\d{1,9}[.)][ \t])*<(?:script|pre|style|textarea|!--|\?|![A-Za-z]|!\[CDATA\[)/im;
/** A fence marker that is indented or follows a blockquote or list-item prefix. */
const NESTED_FENCE = /^(?:[ \t]|>|[-*+][ \t]|\d{1,9}[.)][ \t])+(?:`{3,}|~{3,})/m;
/** A top-level fence opener or closer: three or more backticks or tildes at column 0. */
const FENCE = /^(`{3,}|~{3,})/;
/** A line that may start an HTML block (types 6 and 7): a tag, open or closing, up to three spaces in. */
const HTML_START = /^ {0,3}<\/?[A-Za-z]/;
/** A blank line as CommonMark counts one: spaces and tabs only (not NBSP or other Unicode space). */
const BLANK = /^[ \t]*$/;
/** A line that would continue the block above a blank line instead of starting a new one. */
const CONTINUES = /^(?:[-*+](?:\s|$)|\d{1,9}[.)](?:\s|$)|>|\||\s)/;

/** The text's top-level blocks, in order; `[text]` when it cannot be split safely. */
export function splitMarkdownBlocks(text: string): string[] {
  if (DEFINITION.test(text) || LONG_HTML.test(text) || NESTED_FENCE.test(text)) return [text];
  const lines = text.split("\n");
  const blocks: string[] = [];
  let start = 0;
  let fence: { char: string; length: number } | null = null;
  let blank = false;
  let content = false;
  // In a run of lines that began with an HTML tag, until the next blank line.
  let html = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const marker = FENCE.exec(line);
    if (fence) {
      // A closing fence: the same character, at least as long, nothing after it.
      if (marker && marker[1]![0] === fence.char && marker[1]!.length >= fence.length && BLANK.test(line.slice(marker[0].length))) fence = null;
      blank = false;
      continue;
    }
    if (BLANK.test(line)) { blank = true; html = false; continue; }
    // A fence marker that may sit inside an HTML block: only a full parse knows.
    if (marker && html) return [text];
    if ((blank || !content) && HTML_START.test(line)) html = true;
    if (blank && content && !CONTINUES.test(line)) {
      // The blank lines between two blocks belong to neither: the block
      // before ends at its last non-blank line.
      let end = i;
      while (end > start && BLANK.test(lines[end - 1]!)) end--;
      blocks.push(lines.slice(start, end).join("\n"));
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
