/**
 * The Markdown link destinations of a text, found the one way both sides of a
 * promotion agree on (#1655, #1698): the backend rewrites the stored answer
 * with it, and a client watching the turn applies the host's `message_links`
 * to the streamed answer with it, so the two texts come out identical.
 * Browser-safe: it imports only types.
 */
import type { MessageBlock } from "./protocol.js";

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

/** One replaced destination: `[start, end)` of the original text now reads `length` characters. */
export interface LinkEdit {
  start: number;
  end: number;
  length: number;
}

/** Move classified spans with rewritten destinations; discard ambiguous overlaps. */
export function rebaseMessageBlocks(blocks: readonly MessageBlock[], edits: ReadonlyArray<LinkEdit[] | null>): MessageBlock[] {
  return blocks.flatMap((block) => {
    const part = edits[block.partIndex];
    if (part === undefined) return [block];
    if (part === null) return [];
    let start = block.start, end = block.end;
    for (const edit of part) {
      const delta = edit.length - (edit.end - edit.start);
      if (edit.end <= block.start) { start += delta; end += delta; }
      else if (edit.start >= block.end) break;
      else if (edit.start >= block.start && edit.end <= block.end) end += delta;
      else return [];
    }
    return [{ ...block, start, end }];
  });
}

/**
 * `text` with each link or image destination and reference definition
 * outside code replaced by what `replace` returns for it, as written
 * (angle brackets included). Returning the destination unchanged keeps it.
 */
export function rewriteLinkDestinations(text: string, replace: (destination: string) => string): string {
  return rewriteLinkDestinationsWithEdits(text, replace).text;
}

/**
 * {@link rewriteLinkDestinations}, also saying where the text changed, in
 * the original text's offsets and in order, so spans anchored to it can
 * follow. `edits` is null when two changes overlap and no offset can be
 * trusted.
 */
export function rewriteLinkDestinationsWithEdits(text: string, replace: (destination: string) => string):
  { text: string; edits: LinkEdit[] | null } {
  // Code ranges are recomputed for the second pattern, because the first
  // may have changed the length of the text before them.
  const pass = (current: string, pattern: RegExp) => {
    const code = codeRanges(current);
    const edits: LinkEdit[] = [];
    const next = current.replace(pattern, (whole, lead: string, destination: string, offset: number) => {
      if (code.some(([start, end]) => offset >= start && offset < end)) return whole;
      const replaced = replace(destination);
      const at = offset + lead.length;
      if (replaced !== destination) edits.push({ start: at, end: at + destination.length, length: replaced.length });
      return `${lead}${replaced}`;
    });
    return { text: next, edits };
  };
  const first = pass(text, INLINE_LINK);
  const second = pass(first.text, REFERENCE_DEFINITION);
  // The second pass's offsets are in the first pass's output: take them back.
  const edits = [...first.edits];
  for (const edit of second.edits) {
    let shift = 0;
    for (const before of first.edits) {
      const outStart = before.start + shift, outEnd = outStart + before.length;
      if (edit.end <= outStart) break;
      if (edit.start < outEnd) return { text: second.text, edits: null };
      shift += before.length - (before.end - before.start);
    }
    edits.push({ start: edit.start - shift, end: edit.end - shift, length: edit.length });
  }
  edits.sort((a, b) => a.start - b.start);
  return { text: second.text, edits };
}
