import { spyOn } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

/**
 * `Bun.which("mkfifo")` answered by a shell shim in front of the real one.
 * Bun reads PATH once at startup, so a changed `process.env.PATH` would not
 * reach the worker pipes' lookup.
 */
export function mkfifoShim(script: (real: string) => string) {
  const real = Bun.which("mkfifo");
  if (!real) throw new Error("mkfifo is required for this test");
  const dir = mkdtempSync(join(tmpdir(), "mkfifo-shim-"));
  const shim = join(dir, "mkfifo");
  writeFileSync(shim, `#!/bin/sh\n${script(real)}\n`, { mode: 0o755 });
  const which = Bun.which;
  const spy = spyOn(Bun, "which").mockImplementation(((command: string, options?: Parameters<typeof Bun.which>[1]) =>
    command === "mkfifo" ? shim : which.call(Bun, command, options)) as typeof Bun.which);
  return { shim, restore: () => { spy.mockRestore(); rmSync(dir, { recursive: true, force: true }); } };
}

/** How many `mkfifo` runs each spawn form started while it was installed. */
export function mkfifoSpawns() {
  const sync = spyOn(Bun, "spawnSync"), spawn = spyOn(Bun, "spawn");
  const runs = (calls: unknown[][]) => calls.filter(([command]) => Array.isArray(command) && basename(String(command[0])) === "mkfifo").length;
  return {
    counts: () => ({ sync: runs(sync.mock.calls), async: runs(spawn.mock.calls) }),
    restore: () => { sync.mockRestore(); spawn.mockRestore(); },
  };
}
