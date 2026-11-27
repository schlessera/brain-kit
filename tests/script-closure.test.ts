/** The closure-copy helper the script fixtures share (#4847). */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { BUILD_INPUTS, copyScriptClosure, scriptClosure, TEST_RUNNER_INPUTS } from "./helpers/script-closure";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "script-closure-")); dirs.push(root);
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  }
  return root;
}

describe("script closure", () => {
  test("static and dynamic imports are copied without being named, and so is a declared input", () => {
    const root = tree({
      "scripts/entry.ts": 'import { oar } from "./oar.ts";\nexport const sail = async () => (await import("./wind")).wind + oar;\n',
      "scripts/oar.ts": 'import data from "./crew.json";\nexport const oar = data.length;\n',
      "scripts/crew.json": "[]\n",
      "scripts/wind.ts": "export const wind = 1;\n",
      "scripts/launcher.py": "print('Ithaca')\n",
      "scripts/unrelated.ts": "export {};\n",
    });
    const destination = mkdtempSync(join(tmpdir(), "script-closure-copy-")); dirs.push(destination);
    const copied = copyScriptClosure(destination, ["scripts/entry.ts"], [{ file: "scripts/launcher.py", reason: "run by path" }], root);
    expect(copied).toEqual(["scripts/crew.json", "scripts/entry.ts", "scripts/launcher.py", "scripts/oar.ts", "scripts/wind.ts"]);
    for (const file of copied) expect(existsSync(join(destination, file))).toBe(true);
    expect(existsSync(join(destination, "scripts/wind.ts")), "the dynamically imported file is copied").toBe(true);
    expect(existsSync(join(destination, "scripts/unrelated.ts"))).toBe(false);
  });

  test("an unresolvable relative import fails naming the importer and the specifier", () => {
    const root = tree({ "scripts/entry.ts": 'import "./oar.ts";\n', "scripts/oar.ts": 'export * from "./missing-sail";\n' });
    expect(() => scriptClosure(["scripts/entry.ts"], [], root)).toThrow('scripts/oar.ts: cannot resolve the relative import "./missing-sail"');
  });

  test("a dynamic import with a computed specifier fails instead of being skipped", () => {
    const root = tree({ "scripts/entry.ts": 'const name = "wind";\nawait import(`./${name}.ts`);\n' });
    expect(() => scriptClosure(["scripts/entry.ts"], [], root)).toThrow("scripts/entry.ts: cannot follow the dynamic import");
  });

  test("the declared inputs exist and the real entry points resolve", () => {
    for (const input of [...TEST_RUNNER_INPUTS, ...BUILD_INPUTS]) expect(input.reason.length).toBeGreaterThan(10);
    const runner = scriptClosure(["scripts/test.ts"], TEST_RUNNER_INPUTS);
    expect(runner).toContain("scripts/test-invocation-child.ts");
    expect(runner).toContain("scripts/test-network-guard.ts");
    const build = scriptClosure(["scripts/build.ts"], BUILD_INPUTS);
    expect(build).toContain("scripts/build-execution.ts");
    expect(build).toContain("scripts/ci-build-consumers.ts");
  });
});
