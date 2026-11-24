import { isWithin } from "@schlessera/brain-common/internal/safe-path";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";

/** The read-only checkpoint mounted at the brain path for this strict worker. */
export interface GrepCheckpoint { root: string; masked: readonly string[] }

/** Qualify only an absolute single-file call: a relative path may resolve
 * against a runtime cwd the host did not observe. Never read a live brain here. */
export function grepNotePath(input: unknown, brainPath: string, checkpoint: GrepCheckpoint): string | undefined {
  if (!input || typeof input !== "object") return;
  const { path, output_mode, offset } = input as Record<string, unknown>;
  if (output_mode !== "content" || offset || typeof path !== "string" || !isWithin(brainPath, path)) return;
  const note = path.slice(brainPath.length + 1);
  if (!note.endsWith(".md") || note.length > 1024 || /[\\\u0000-\u001f\u007f]/u.test(note)
    || note.split("/").some(part => !part || part.startsWith(".")) || isWithin("workspaces", note)
    || checkpoint.masked.some(mask => isWithin(resolve(brainPath, mask), path, { trailingSeparator: "boundary" }))) return;
  return note;
}

/** Installed Claude Grep returns content with numbered match/context lines
 * and no filename for a single file. Verify the whole delivered envelope and
 * each line against the exact immutable note before attributing that result. */
export function checkpointGrepMatches(checkpoint: GrepCheckpoint, note: string, output: string): boolean {
  if (Buffer.byteLength(output) > 1_048_576) return false;
  try {
    const result = JSON.parse(output);
    if (!result || result.mode !== "content" || result.numFiles !== 0 || !Array.isArray(result.filenames) || result.filenames.length
      || typeof result.content !== "string" || !result.content || result.numLines !== result.totalLines
      || Object.keys(result).some(key => !["mode", "numFiles", "filenames", "content", "numLines", "totalLines"].includes(key))) return false;
    const path = join(checkpoint.root, note);
    if (realpathSync(path) !== path) return false;
    const file = lstatSync(path);
    if (!file.isFile() || file.nlink !== 1 || file.size > 1_048_576) return false;
    const lines = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(readFileSync(path)).split(/\r?\n/);
    const delivered = result.content.split("\n");
    let previous = 0, matched = false;
    if (delivered.length !== result.numLines) return false;
    for (const line of delivered) {
      const numbered = /^([1-9]\d{0,6})([:-])(.*)$/u.exec(line);
      if (!numbered) return false;
      const number = Number(numbered[1]);
      if (number <= previous || lines[number - 1] !== numbered[3]) return false;
      if (numbered[2] === ":") matched = true;
      previous = number;
    }
    return matched;
  } catch { return false; }
}
