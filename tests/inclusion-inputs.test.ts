import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { inclusionInputs } from "../scripts/inclusion-inputs";
import { git, type Spec } from "../scripts/proof-inputs";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const spec = "packages/ui-kit/tests/visual/one.visual.tsx", second = "packages/ui-kit/tests/visual/two.visual.tsx";
const inventory: Spec[] = [spec, second].map(file => ({ project: "visual", file }));
function write(root: string, file: string, text: string) { mkdirSync(dirname(join(root, file)), { recursive: true }); writeFileSync(join(root, file), text); }
function commit(root: string) { git(root, "add", "."); git(root, "-c", "user.name=Odysseus", "-c", "user.email=odysseus@example.invalid", "commit", "-qm", "fixture"); return git(root, "rev-parse", "HEAD").trim(); }
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "inclusion-inputs-")); roots.push(root); git(root, "init", "-q"); git(root, "config", "commit.gpgsign", "false");
  write(root, ".gitignore", "node_modules\n"); symlinkSync(resolve(import.meta.dir, "../node_modules"), join(root, "node_modules"), "dir");
  for (const path of ["package.json", "bun.lock", "tsconfig.json"]) write(root, path, "{}\n");
  for (const path of ["bunfig.toml", ".github/workflows/ci.yml", "packages/ui-kit/vitest.config.ts", "packages/ui-kit/vite.config.ts", "packages/ui-kit/.storybook/main.ts", "packages/ui-kit/.storybook/preview.ts", "scripts/visual.mjs", "scripts/build.ts", "scripts/workspace-lease.mjs"]) write(root, path, "");
  write(root, "packages/ui-kit/tests/proof-inputs.json", "[]"); write(root, "scripts/browser-shard-costs.json", JSON.stringify({ seconds: { [`visual::${spec}`]: 1 } }));
  write(root, spec, `import "../../../src/fixture.ts";\n`); write(root, "packages/src/fixture.ts", "export const value = 1;\n"); write(root, second, "export {};\n"); commit(root); return root;
}
test("inclusion hashes transitive immutable blobs and modes while unrelated prose can change", () => {
  const root = fixture(), initial = inclusionInputs(root, "browser", inventory, "fixed-runner");
  write(root, "docs/unrelated.md", "unrelated\n"); commit(root);
  expect(inclusionInputs(root, "browser", inventory, "fixed-runner").fingerprint).toBe(initial.fingerprint);
  write(root, "packages/src/fixture.ts", "export const value = 2;\n"); commit(root);
  expect(inclusionInputs(root, "browser", inventory, "fixed-runner").fingerprint).not.toBe(initial.fingerprint);
  const beforeMode = inclusionInputs(root, "browser", inventory, "fixed-runner"); chmodSync(join(root, spec), 0o755); commit(root);
  expect(inclusionInputs(root, "browser", inventory, "fixed-runner").fingerprint).not.toBe(beforeMode.fingerprint);
});
test("immutable source closure never reads current files, and changed resolution policy fails fresh", () => {
  const root = fixture(), source = commitIfNeeded(root), original = inclusionInputs(root, "browser", inventory, "fixed-runner");
  write(root, "packages/src/fixture.ts", "export const value = 3;\n"); commit(root);
  expect(inclusionInputs(root, "browser", inventory, "fixed-runner", source).fingerprint).toBe(original.fingerprint);
  write(root, "bun.lock", "changed resolution\n"); commit(root);
  expect(() => inclusionInputs(root, "browser", inventory, "fixed-runner", source)).toThrow("algorithm or dependency");
});
function commitIfNeeded(root: string) { return git(root, "rev-parse", "HEAD").trim(); }
test("undeclared computed runtime inputs and missing or symbolic source cannot authorize reuse", () => {
  const root = fixture(); write(root, spec, "const value = await import(modulePath);\n"); commit(root);
  expect(() => inclusionInputs(root, "browser", inventory, "fixed-runner")).toThrow("Unresolved immutable");
  write(root, spec, `import "../../../src/fixture.ts";\n`); rmSync(join(root, "packages/src/fixture.ts")); commit(root);
  expect(() => inclusionInputs(root, "browser", inventory, "fixed-runner")).toThrow("Unresolved immutable");
  symlinkSync("/tmp/unknown-proof-input", join(root, "packages/src/fixture.ts")); commit(root);
  expect(() => inclusionInputs(root, "browser", inventory, "fixed-runner")).toThrow();
});
