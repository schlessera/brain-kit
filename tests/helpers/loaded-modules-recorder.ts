/**
 * The recorder preload of `loaded-modules.ts`. The helper generates a one-line
 * preload per run that imports this file and calls `recordLoadedModules` with
 * that run's output path, so no environment variable carries the path and
 * nothing is written to stdout or stderr, which the programs under test own.
 *
 * Nothing here opens a descriptor before the process exits: an entry point that
 * audits its inherited descriptors at startup sees only what its parent gave it.
 * At exit, `require.cache` lists every module whose evaluation completed,
 * reached by a static import or by `import()`.
 */
import { writeFileSync } from "node:fs";

export function recordLoadedModules(output: string): void {
  process.on("exit", () => {
    writeFileSync(output, JSON.stringify(Object.keys(require.cache)));
  });
}
