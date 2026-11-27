/**
 * Temporary directories a Bun test file owns (#4840, test-authoring D4).
 *
 *   import { tempDirs } from "../../../tests/helpers/temp";
 *   const tempDir = tempDirs();                 // removed after each test
 *   const fileDir = tempDirs({ scope: "file" }); // removed after the file
 *   const root = tempDir("ithaca-");
 *
 * Call it once at the top level of a test file: it registers the teardown
 * hook there, which a call at import time of a shared module could not do
 * (Bun evaluates a module once per process). Each directory comes from
 * `mkdtemp` under `os.tmpdir()`, so its name is never predictable, and is
 * removed recursively and forcibly by the hook, also when the test throws.
 */
import { afterAll, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function tempDirs(options: { scope?: "test" | "file" } = {}): (prefix: string) => string {
  const made: string[] = [];
  (options.scope === "file" ? afterAll : afterEach)(() => {
    for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  return (prefix) => {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    made.push(dir);
    return dir;
  };
}
