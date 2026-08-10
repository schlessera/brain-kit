/**
 * The `modules` key is the one brain.config value that leads to import().
 * The schema check is lexical, so the loader must also refuse a key whose
 * REAL path leaves the root — otherwise a symlink inside the repo becomes
 * arbitrary code execution from outside it.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { brainConfigSchema } from "../src/lib/config";
import { loadModules } from "../src/lib/module-loader";

const temps: string[] = [];
function makeDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

function writeModule(dir: string, name: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "module.ts"),
    `export default { name: ${JSON.stringify(name)}, setup: () => ({}) };`
  );
}

describe("module key containment", () => {
  test("refuses a ./key that resolves outside the root through a symlink", async () => {
    const root = makeDir("mod-root-");
    const outside = makeDir("mod-out-");
    writeModule(join(outside, "evil"), "evil");
    symlinkSync(join(outside, "evil"), join(root, "link"));

    // The schema accepts it — the key looks repo-relative.
    const parsed = brainConfigSchema.parse({ modules: { "./link": {} } });
    // The loader must not execute it.
    await expect(loadModules(parsed, root)).rejects.toThrow(/outside the brain root/);
  });

  test("still loads a local module that genuinely lives inside the root", async () => {
    const root = makeDir("mod-root-");
    writeModule(join(root, "local", "mine"), "mine");
    const parsed = brainConfigSchema.parse({ modules: { "./local/mine": {} } });
    const loaded = await loadModules(parsed, root);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.manifest.name).toBe("mine");
  });
});
