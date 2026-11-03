/** Publishing and reading files that a test polls for (#3401, #3432, #3435).
 *
 * `writeFileSync` and `Bun.write` create a file before they write it, so a
 * reader that polls with `existsSync` can see the file empty or partial. A PID
 * read that way is `Number("") === 0`, and PID 0 is never a real process:
 * `/proc/0` never exists, and `process.kill(0)` or `process.kill(-0)` signals
 * the caller's own process group. A writer publishes with `publishFile`; a
 * reader that takes a PID from such a file uses `readPositivePid` or
 * `positivePid`, so a bad value fails on a named error instead of being used.
 *
 * A child that runs from inline source and cannot import this module uses the
 * same shape inline: write `<path>.tmp`, then rename it onto `<path>`. */
import { readFileSync, renameSync, writeFileSync } from "node:fs";

/** Write `text` to a temporary sibling and rename it onto `path`, so `path`
 * appears only with its complete content. */
export function publishFile(path: string, text: string): void {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, text);
  renameSync(temporary, path);
}

/** The PID `text` names, or `undefined` unless it is a positive decimal integer.
 * Zero, negatives, empty and partial text are all refused. */
export function positivePid(text: string): number | undefined {
  const trimmed = text.trim();
  return /^[1-9][0-9]*$/.test(trimmed) ? Number(trimmed) : undefined;
}

/** Read a published PID, throwing an error that starts with `label` unless the
 * file holds a positive integer. */
export function readPositivePid(path: string, label: string): number {
  const text = readFileSync(path, "utf8");
  const pid = positivePid(text);
  if (pid === undefined) throw new Error(`${label}: expected a positive integer PID, read ${JSON.stringify(text)}`);
  return pid;
}
