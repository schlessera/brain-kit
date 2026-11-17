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
 *   instruction, a declaration or CDATA).
 */

/**
 * A link reference or footnote definition, `[label]: …` or `[^note]: …`,
 * anywhere a definition can stand: after any indentation and any blockquote
 * (`>`) or list-item (`-`, `*`, `+`, `1.`, `1)`) prefixes, with escaped
 * brackets in the label and a label that wraps across lines. Deliberately broad: a false match only means the
 * text parses whole.
 */
const DEFINITION = /^(?:[ \t]|>|[-*+][ \t]|\d{1,9}[.)][ \t])*\[(?:[^\]\\]|\\.)+\]:/m;
/** CommonMark HTML blocks of types 1 to 5, whose end is not a blank line. */
const LONG_HTML = /^ {0,3}<(?:script|pre|style|textarea|!--|\?|![A-Za-z]|!\[CDATA\[)/im;
/** A fence opener or closer: up to three spaces, then three or more backticks or tildes. */
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
/** A line that would continue the block above a blank line instead of starting a new one. */
const CONTINUES = /^(?:[-*+](?:\s|$)|\d{1,9}[.)](?:\s|$)|>|\||\s)/;

/** The text's top-level blocks, in order; `[text]` when it cannot be split safely. */
export function splitMarkdownBlocks(text: string): string[] {
  if (DEFINITION.test(text) || LONG_HTML.test(text)) return [text];
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
      if (marker && marker[1]![0] === fence.char && marker[1]!.length >= fence.length && line.slice(marker[0].length).trim() === "") fence = null;
      blank = false;
      continue;
    }
    if (line.trim() === "") { blank = true; continue; }
    if (blank && content && !CONTINUES.test(line)) {
      // The blank lines between two blocks belong to neither: the block
      // before ends at its last non-blank line.
      let end = i;
      while (end > start && lines[end - 1]!.trim() === "") end--;
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
