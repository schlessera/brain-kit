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
 *   blockquote (`>`) or a table (`|`), and does not start a list item
 *   (`-`, `*`, `+`, `1.`, `1)`) when the block above holds one: a new item
 *   after a blank line joins that list and makes it loose. Below a block
 *   with no list item, a new list cannot change it, so the split stands, and
 *   a paragraph being typed that starts with a number (`3`, `3.`, `3.14`)
 *   does not collapse and split again as it grows. After an indented line
 *   no list item splits: below an indented code block the whole text can
 *   parse an empty item (`1.`) or one not starting at 1 (`10. ten`) as a
 *   paragraph instead;
 * - never in a text holding a link reference or footnote definition, which
 *   resolves across the whole document;
 * - never in a text holding a line that starts with HTML (a tag, a comment,
 *   a processing instruction, a declaration or CDATA), at the top level or
 *   after a blockquote or list-item prefix: an HTML block can hold blank
 *   lines and fence markers, and how it ends depends on what follows;
 * - never in a text holding a fence that is indented or inside a blockquote
 *   or list item. Only top-level fences are tracked, and a container fence
 *   can be closed or reopened at column 0 in ways only a full parse knows
 *   (a column-0 closer ends the list item and opens a new top-level fence);
 * - never in a text holding a carriage return, which CommonMark also takes
 *   as a line ending while this scan reads lines at `\n` alone.
 */

/**
 * A link reference or footnote definition, `[label]: …` or `[^note]: …`,
 * anywhere a definition can stand: after any indentation and any blockquote
 * (`>`) or list-item (`-`, `*`, `+`, `1.`, `1)`) prefixes, with escaped
 * brackets in the label and a label that wraps across lines. Deliberately broad: a false match only means the
 * text parses whole.
 */
const DEFINITION = /^(?:[ \t]|>|[-*+][ \t]|\d{1,9}[.)][ \t])*\[(?:[^\]\\]|\\[\s\S])+\]:/m;
/**
 * A line that starts with HTML (a tag, open or closing, a comment, a
 * declaration or a processing instruction), after any indentation and
 * blockquote or list-item prefixes. An autolink (`<https://…>`) is not HTML.
 * A tag name counts only once whitespace, `/` or `>` follows it, never at
 * the end of the text: while a tag or an autolink is still being typed
 * (`<h`, `<https`), it is not yet HTML, so the split does not collapse and
 * split again under a streaming answer.
 */
const HTML_LINE = /^(?:[ \t]|>|[-*+][ \t]|\d{1,9}[.)][ \t])*<(?:\/?[A-Za-z][A-Za-z0-9-]*(?=[\s/>])|[!?])/m;
/** A fence marker that is indented or follows a blockquote or list-item prefix. */
const NESTED_FENCE = /^(?:[ \t]|>|[-*+][ \t]|\d{1,9}[.)][ \t])+(?:`{3,}|~{3,})/m;
/** A top-level fence opener or closer: three or more backticks or tildes at column 0. */
const FENCE = /^(`{3,}|~{3,})/;
/** A blank line as CommonMark counts one: spaces and tabs only (not NBSP or other Unicode space). */
const BLANK = /^[ \t]*$/;
/** A line that would continue the block above a blank line instead of starting a new one. */
const CONTINUES = /^(?:>|\||\s)/;
/** A list item marker at the start of a line. */
const LIST_ITEM = /^(?:[-*+]|\d{1,9}[.)])(?:\s|$)/;
/**
 * A line that may belong to a list: a list item marker after any indentation
 * and blockquote prefixes, in or out of a fence. Deliberately broad (a
 * thematic break `* * *` counts too): a false match only means a following
 * list item does not split.
 */
const LIST_LINE = /^(?:[ \t]|>)*(?:[-*+]|\d{1,9}[.)])(?:\s|$)/;

/** The text's top-level blocks, in order; `[text]` when it cannot be split safely. */
export function splitMarkdownBlocks(text: string): string[] {
  if (text.includes("\r") || DEFINITION.test(text) || HTML_LINE.test(text) || NESTED_FENCE.test(text)) return [text];
  const lines = text.split("\n");
  const blocks: string[] = [];
  let start = 0;
  let fence: { char: string; length: number } | null = null;
  let blank = false;
  let content = false;
  let list = false;
  // Whether the last line with content outside a fence was indented.
  let indented = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const marker = FENCE.exec(line);
    const listLine = LIST_LINE.test(line);
    if (fence) {
      list ||= listLine;
      // A closing fence: the same character, at least as long, nothing after it.
      if (marker && marker[1]![0] === fence.char && marker[1]!.length >= fence.length && BLANK.test(line.slice(marker[0].length))) fence = null;
      indented = false;
      blank = false;
      continue;
    }
    if (BLANK.test(line)) { blank = true; continue; }
    if (blank && content && !CONTINUES.test(line) && !((list || indented) && LIST_ITEM.test(line))) {
      // The blank lines stay with the block before, exactly as the whole
      // text has them: how a block ends (an indented code block's trailing
      // whitespace lines) can depend on them.
      blocks.push(lines.slice(start, i).join("\n"));
      start = i;
      list = false;
    }
    list ||= listLine;
    indented = /^[ \t]/.test(line);
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

/** How long the growing tail may show deferred text before its current text renders urgently. */
export const MAX_TAIL_LAG_MS = 200;

/**
 * Which text the growing last block shows. Its deferred text, while that is
 * what the current text extends and the tail has not been behind for longer
 * than `MAX_TAIL_LAG_MS`: React restarts a deferred render on every new
 * delta, so when the tail's parse outlasts the gap between deltas it would
 * otherwise not update until the stream paused. Past the bound the current
 * text renders urgently.
 *
 * `behindSince` is when a commit first showed the tail behind its text, or
 * `null` while the last commit showed it caught up; `committed` is the text
 * the last commit showed. Both come from committed renders only, so a render
 * React discards cannot move them, and a pause in the stream (no commits,
 * but nothing behind either) does not count as lag. The tail never shows
 * less than it last committed: after the bound forced the current text, the
 * deferred value can still be older, and the tail must not step back to it.
 */
export function tailText(text: string, deferred: string | null, committed: string | null, behindSince: number | null, now: number): string {
  if (deferred === null || deferred === text || !text.startsWith(deferred)) return text;
  if (behindSince !== null && now - behindSince > MAX_TAIL_LAG_MS) return text;
  return committed !== null && committed.length > deferred.length && text.startsWith(committed) ? committed : deferred;
}
