/**
 * Marker-fenced, machine-managed regions in a markdown file the user also
 * edits (AGENTS.md).
 *
 * A region is trusted only when its markers are unambiguous: exactly one start
 * marker, exactly one end marker, in that order. Anything else is reported as
 * malformed, and the caller changes nothing, because guessing which markers
 * belong together is how hand-written text gets deleted. Edits touch only the
 * marker-inclusive span; every byte outside it is kept.
 */

export interface Markers {
  start: string;
  end: string;
}

export type BlockScan =
  | { kind: "absent" }
  | { kind: "present"; from: number; to: number }
  | { kind: "malformed"; reason: string };

function occurrences(text: string, needle: string): number {
  let count = 0;
  for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + needle.length)) count++;
  return count;
}

/** Where the region for `markers` is in `text`: absent, one clean span, or malformed. */
export function scanBlock(text: string, { start, end }: Markers): BlockScan {
  const starts = occurrences(text, start);
  const ends = occurrences(text, end);
  if (starts === 0 && ends === 0) return { kind: "absent" };
  if (starts !== 1 || ends !== 1) {
    return { kind: "malformed", reason: `${starts} start and ${ends} end marker(s), expected one of each` };
  }
  const from = text.indexOf(start);
  const endAt = text.indexOf(end);
  if (endAt < from + start.length) return { kind: "malformed", reason: "the end marker comes before the start marker" };
  return { kind: "present", from, to: endAt + end.length };
}

export interface Edit {
  from: number;
  to: number;
  insert: string;
}

/** Apply non-overlapping span edits to `text`; bytes outside every span are kept. */
export function applyEdits(text: string, edits: Edit[]): string {
  let out = text;
  for (const { from, to, insert } of [...edits].sort((a, b) => b.from - a.from)) {
    out = out.slice(0, from) + insert + out.slice(to);
  }
  return out;
}

/** `text` with `block` appended after a blank line, keeping every existing byte. */
export function appendBlock(text: string, block: string): string {
  if (text === "") return block + "\n";
  return text + (text.endsWith("\n") ? "\n" : "\n\n") + block + "\n";
}
