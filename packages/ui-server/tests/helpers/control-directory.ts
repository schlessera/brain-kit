import { mkdirSync, mkdtempSync } from "node:fs";
import { resolve, join } from "node:path";

/** Live fixture channels inside the server's explicit read-only runtime bind, outside configuration snapshots. Caller owns cleanup. */
export function controlDirectory(prefix: string): string {
  const root = resolve(import.meta.dir, "../../tmp");
  mkdirSync(root, { recursive: true });
  return mkdtempSync(join(root, prefix));
}
