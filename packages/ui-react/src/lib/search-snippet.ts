import { stripMarkdown } from "./strip-markdown.js";

/**
 * `brain search` returns FTS snippets with the matched terms wrapped in
 * `>>>` / `<<<` markers (sqlite's snippet() delimiters, chosen by the CLI so
 * they survive JSON without colliding with markdown). Vector hits come back
 * unmarked, as a raw slice of chunk text — headings, emphasis, blank lines and
 * all. Split a snippet into plain and matched segments, with the markdown
 * syntax stripped and the whitespace collapsed, so a result row is one legible
 * line with its hits highlighted.
 */
export interface SnippetSegment {
  text: string;
  hit: boolean;
}

const OPEN = ">>>";
const CLOSE = "<<<";
// Control characters stand in for the markers while stripMarkdown runs: a
// snippet starting with ">>>" would otherwise lose a ">" to the blockquote
// rule, and emphasis spanning a highlight (`**a >>>b<<<**`) has to be
// unwrapped as one string, not per segment.
const OPEN_MARK = "\u0001";
const CLOSE_MARK = "\u0002";

export function parseSnippet(snippet: string): SnippetSegment[] {
  const cleaned = stripMarkdown(
    snippet.split(OPEN).join(OPEN_MARK).split(CLOSE).join(CLOSE_MARK)
  )
    .replace(/\s+/g, " ")
    .trim();

  const segments: SnippetSegment[] = [];
  let rest = cleaned;

  while (rest.length > 0) {
    const start = rest.indexOf(OPEN_MARK);
    if (start === -1) break;

    const end = rest.indexOf(CLOSE_MARK, start + 1);
    // An unclosed marker means the snippet was clipped mid-highlight; keep the
    // remainder as plain text rather than dropping it.
    if (end === -1) break;

    if (start > 0) push(segments, rest.slice(0, start), false);
    push(segments, rest.slice(start + 1, end), true);
    rest = rest.slice(end + 1);
  }

  push(segments, rest, false);
  return segments;
}

function push(segments: SnippetSegment[], text: string, hit: boolean): void {
  // Any stray marker left by a clipped snippet is noise, not content —
  // squeeze the gap it leaves behind so the row reads as one sentence.
  const clean = text
    .split(OPEN_MARK)
    .join("")
    .split(CLOSE_MARK)
    .join("")
    .replace(/ {2,}/g, " ");
  if (clean) segments.push({ text: clean, hit });
}
