// Internal to brain-kit: reached through
// `@schlessera/brain-common/internal/frontmatter-block`, with no compatibility
// promise. Where a document's frontmatter block starts and ends, by the rule
// `parseFrontmatter` (gray-matter 4.0.3) reads it. It imports nothing, so a
// browser bundle can use it (ui-react reaches it through ui-sdk's
// `internal/client`). Every site that needs the fences, but not the YAML,
// asks this instead of writing its own regex (#2507);
// scripts/check-frontmatter-parse.ts refuses a hand-written one.

/**
 * Offsets of a frontmatter block in the original text:
 *
 * - `start`: where the opening `---` is (1 after a byte order mark, else 0).
 * - `innerStart`: after the opening fence's line ending (the end of the text
 *   when that line has none).
 * - `innerEnd`: up to the closing fence, its preceding line ending included,
 *   so `text.slice(innerStart, innerEnd)` is the block's YAML lines; the end
 *   of the text when the block is not closed.
 * - `end`: after the closing fence and one line ending following it, which is
 *   where `parseFrontmatter`'s `content` starts; the end of the text when the
 *   block is not closed.
 * - `closed`: whether a closing fence was found. gray-matter reads an
 *   unclosed block to the end of the file; a writer should refuse one.
 */
export interface FrontmatterBlock {
  start: number;
  innerStart: number;
  innerEnd: number;
  end: number;
  closed: boolean;
}

/**
 * The frontmatter block, or null when the text has none. gray-matter's rule:
 * after a byte order mark, which it strips, the text opens with `---` not
 * followed by a fourth `-` (anything else on that line is a language name);
 * the block runs to the first `\n---` after it, wherever on its line that
 * `---` is followed by more text, and one `\r` and one `\n` after the fence
 * belong to it. A leading blank line means no frontmatter; a `...` line does
 * not close it.
 */
export function frontmatterBlock(text: string): FrontmatterBlock | null {
  const start = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  if (!text.startsWith("---", start) || text.charAt(start + 3) === "-") return null;
  const newline = text.indexOf("\n", start);
  const close = text.indexOf("\n---", start + 3);
  if (close === -1) {
    return { start, innerStart: newline === -1 ? text.length : newline + 1, innerEnd: text.length, end: text.length, closed: false };
  }
  let end = close + 4;
  if (text[end] === "\r") end++;
  if (text[end] === "\n") end++;
  return { start, innerStart: newline + 1, innerEnd: close + 1, end, closed: true };
}

/**
 * Length of the frontmatter block, `frontmatterBlock(text).end`, or 0 when
 * there is none. The length counts a byte order mark, so it is an offset into
 * the original text.
 */
export function frontmatterLength(text: string): number {
  return frontmatterBlock(text)?.end ?? 0;
}
