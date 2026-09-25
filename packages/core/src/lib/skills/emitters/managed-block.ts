/**
 * Marker-fenced, machine-managed regions in a markdown file the user also
 * edits (AGENTS.md, GEMINI.md).
 *
 * Only the region between a start and an end marker is ever touched;
 * everything before the start marker and after the end marker is preserved
 * byte-for-byte. Both helpers return whether the file changed, and write
 * nothing when it would not.
 */

import { existsSync, readFileSync, writeFileSync } from "fs";

export interface Markers {
  start: string;
  end: string;
}

/** `[start, endExclusive)` of the fenced region, markers included, or null. */
function locate(text: string, { start, end }: Markers): [number, number] | null {
  const from = text.indexOf(start);
  const to = text.indexOf(end);
  if (from === -1 || to === -1 || to < from) return null;
  return [from, to + end.length];
}

/**
 * Insert or replace `block` (markers included) in `filePath`. When the file has
 * no region for `markers`, a region for `replacing` is swapped out in place
 * instead, which is how an emitter moves a file from an old block to a new one.
 * Otherwise the block is appended; a missing file is created.
 */
export function upsertManagedBlock(
  filePath: string,
  markers: Markers,
  block: string,
  replacing?: Markers
): boolean {
  const existed = existsSync(filePath);
  const original = existed ? readFileSync(filePath, "utf8") : "";

  const at = locate(original, markers) ?? (replacing ? locate(original, replacing) : null);

  let next: string;
  if (at) {
    next = original.slice(0, at[0]) + block + original.slice(at[1]);
  } else if (!existed || original.trim() === "") {
    next = block + "\n";
  } else {
    const gap = original.endsWith("\n") ? "\n" : "\n\n";
    next = original + gap + block + "\n";
  }

  if (next === original) return false;
  writeFileSync(filePath, next);
  return true;
}

/**
 * Remove the region for `markers` from `filePath`, with the newline after its
 * end marker and one blank line before its start marker when there is one,
 * so the gap `upsertManagedBlock` added on append goes with it.
 */
export function removeManagedBlock(filePath: string, markers: Markers): boolean {
  if (!existsSync(filePath)) return false;
  const original = readFileSync(filePath, "utf8");
  const at = locate(original, markers);
  if (!at) return false;

  let [from, to] = at;
  if (original[to] === "\n") to += 1;
  if (original.slice(0, from).endsWith("\n\n")) from -= 1;

  writeFileSync(filePath, original.slice(0, from) + original.slice(to));
  return true;
}
