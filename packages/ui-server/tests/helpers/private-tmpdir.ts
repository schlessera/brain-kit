/**
 * Point `TMPDIR` at a directory of this process's own while a test runs.
 * Other test processes create directories with the same prefixes in the
 * shared temp directory at the same time, so a test that lists it to prove
 * what it created or removed must list one nobody else writes to (#4252).
 */
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function usePrivateTmpdir(prefix: string): { path: string; restore(): void } {
  const shared = process.env.TMPDIR;
  const path = mkdtempSync(join(tmpdir(), prefix));
  chmodSync(path, 0o755);
  process.env.TMPDIR = path;
  return {
    path,
    restore() {
      if (shared === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = shared;
      rmSync(path, { recursive: true, force: true });
    },
  };
}
