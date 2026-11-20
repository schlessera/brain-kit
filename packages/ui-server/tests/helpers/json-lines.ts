/**
 * Read the records another process appends to a JSON-lines file, one
 * `appendFileSync` per record. The writer creates the file before it writes
 * the line, so a read in between sees an empty file, and a read during the
 * write sees a partial line. Only lines ended by a newline are complete: the
 * rest is dropped, and the next poll reads it whole (#4247).
 */
import { existsSync, readFileSync } from "node:fs";

export function completeJsonLines<T = unknown>(path: string): T[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").slice(0, -1).filter(line => line.trim() !== "").map(line => JSON.parse(line) as T);
}
