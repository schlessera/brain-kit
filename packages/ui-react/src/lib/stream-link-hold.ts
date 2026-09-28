/**
 * Hold back the tail of a streaming answer that is still becoming a link
 * (#551, design §7).
 *
 * react-markdown draws an unclosed `[your bank](https://acc` as literal text,
 * so without a hold the raw address is painted while it streams. A remark-gfm
 * autolink is worse: `https://account-check.ex` is already an anchor, and it
 * classifies as accepted, so a live link to the wrong host would exist for a
 * few frames. The hold stops the shown text just before the construct, and
 * releases it once the construct closes, when the anchor and its host
 * suffix appear together in one render.
 *
 * Only the last line is scanned: a newline ends the hold, a fenced code block
 * or a code span never holds, and a tail longer than `HOLD_MAX` is released
 * as literal text. Settled messages and non-streaming surfaces never call
 * this.
 */

/** The longest tail held back before it is released as literal text. */
export const HOLD_MAX = 2200;

/** What ends a bare address, so an address followed by one of these is done. */
const ADDRESS_END = /[\s)\]>,;!?]$/;

/** A bare address the autolinker would pick up, touching the end of the line. */
const BARE_ADDRESS = /(?:https?:\/\/|www\.|mailto:)\S*$|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]*$/i;

export interface LinkHold {
  /** The buffer up to the held tail: what is rendered. */
  shown: string;
  /** What is held back, `""` when nothing is. */
  held: string;
}

/** Inside an open fenced code block: an odd number of fence lines so far. */
function insideFence(buffer: string): boolean {
  let open: string | null = null;
  for (const line of buffer.split("\n")) {
    const fence = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (!fence) continue;
    if (open === null) open = fence[1]![0]!;
    else if (fence[1]![0] === open) open = null;
  }
  return open !== null;
}

/** Where the held tail starts within `line`, or -1. */
function holdStart(line: string): number {
  // Opening `[` positions not yet closed, and the start of an open `](`.
  const brackets: number[] = [];
  let destination = -1;
  let depth = 0;
  // Closed code spans, whose text is never an address.
  const code: [number, number][] = [];
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (destination !== -1) {
      if (ch === "(") depth++;
      else if (ch === ")" && --depth === 0) destination = -1;
      continue;
    }
    if (ch === "\\") {
      i++;
      continue;
    }
    if (ch === "`") {
      // A code span: skip to the matching run of backticks. An unclosed run
      // reads as a span still streaming, whose content never holds.
      let run = 1;
      while (line[i + run] === "`") run++;
      const close = line.indexOf("`".repeat(run), i + run);
      if (close === -1) return brackets.length ? brackets[0]! : -1;
      code.push([i, close + run]);
      i = close + run - 1;
      continue;
    }
    if (ch === "[") brackets.push(i);
    else if (ch === "]" && brackets.length) {
      const open = brackets.pop()!;
      if (line[i + 1] === "(") {
        destination = open;
        depth = 1;
        i++;
      } else if (i === line.length - 1) {
        // `[text]` at the very end: a `(` may be the next token.
        return withBang(line, brackets.length ? brackets[0]! : open);
      }
    }
  }
  const starts = [...brackets.slice(0, 1), destination].filter((n) => n !== -1);
  const bracket = starts.length ? withBang(line, Math.min(...starts)) : -1;
  if (ADDRESS_END.test(line)) return bracket;
  const bare = BARE_ADDRESS.exec(line);
  if (!bare || code.some(([from, to]) => bare.index < to && bare.index + bare[0].length > from)) return bracket;
  return bracket === -1 ? bare.index : Math.min(bracket, bare.index);
}

/** An image's `!` goes with its `[`. */
function withBang(line: string, at: number): number {
  return at > 0 && line[at - 1] === "!" ? at - 1 : at;
}

/** Split a streaming buffer into what may be drawn now and what is held. */
export function holdOpenLink(buffer: string): LinkHold {
  const lineStart = buffer.lastIndexOf("\n") + 1;
  if (insideFence(buffer)) return { shown: buffer, held: "" };
  const at = holdStart(buffer.slice(lineStart));
  if (at === -1) return { shown: buffer, held: "" };
  const cut = lineStart + at;
  if (buffer.length - cut > HOLD_MAX) return { shown: buffer, held: "" };
  return { shown: buffer.slice(0, cut), held: buffer.slice(cut) };
}
