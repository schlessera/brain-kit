/**
 * The Markdown link destinations of a text, found the one way both sides of a
 * promotion agree on (#1655, #1698): the backend rewrites the stored answer
 * with it, and a client watching the turn applies the host's `message_links`
 * to the streamed answer with it, so the two texts come out identical.
 * Browser-safe: it imports nothing.
 */

/**
 * Ranges of `text` that are code, where a link is not a link: fenced blocks
 * and inline code spans.
 */
function codeRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const fence = /^ {0,3}(`{3,}|~{3,})[^\n]*$/gm;
  let open: { at: number; marker: string } | null = null;
  for (let m: RegExpExecArray | null; (m = fence.exec(text));) {
    const marker = m[1]!;
    if (!open) open = { at: m.index, marker };
    else if (marker[0] === open.marker[0] && marker.length >= open.marker.length && m[0].trim() === marker) {
      ranges.push([open.at, m.index + m[0].length]);
      open = null;
    }
  }
  if (open) ranges.push([open.at, text.length]);
  const span = /(`+)(?!`)[\s\S]*?[^`]\1(?!`)/g;
  for (let m: RegExpExecArray | null; (m = span.exec(text));) {
    if (!ranges.some(([start, end]) => m!.index >= start && m!.index < end)) ranges.push([m.index, m.index + m[0].length]);
  }
  return ranges;
}

/** Inline link and image destinations, and reference definitions. */
const INLINE_LINK = /(\]\(\s*)(<[^<>\n]+>|(?:[^\s()<>]|\((?:[^\s()<>]|\([^\s()<>]*\))*\))+)(?=\s*\)|\s+["'(])/g;
const REFERENCE_DEFINITION = /^( {0,3}\[[^\]\n]+\]:[ \t]*)(<[^<>\n]+>|\S+)/gm;

/**
 * `text` with each link or image destination and reference definition
 * outside code replaced by what `replace` returns for it, as written
 * (angle brackets included). Returning the destination unchanged keeps it.
 */
export function rewriteLinkDestinations(text: string, replace: (destination: string) => string): string {
  // Code ranges are recomputed for the second pattern, because the first
  // may have changed the length of the text before them.
  const pass = (current: string, pattern: RegExp) => {
    const code = codeRanges(current);
    return current.replace(pattern, (whole, lead: string, destination: string, offset: number) =>
      code.some(([start, end]) => offset >= start && offset < end) ? whole : `${lead}${replace(destination)}`);
  };
  return pass(pass(text, INLINE_LINK), REFERENCE_DEFINITION);
}
