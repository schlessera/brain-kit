import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { closureSelects, discoverInputClosure, discoverBrowserClosures, type InputDeclaration } from "../scripts/browser-input-closure";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "odysseus-proof-")); roots.push(root);
  for (const [file, text] of Object.entries(files)) { mkdirSync(dirname(join(root, file)), { recursive: true }); writeFileSync(join(root, file), text); }
  return root;
}
test("static imports, reexports and literal dynamic imports retain transitive fixture source", () => {
  const root = fixture({ "spec.ts": 'import "./config.js"; export * from "./scene.js";', "config.ts": 'await import("./command.js");', "command.ts": 'import "./fixture.js";', "fixture.ts": 'import "./route.js";', "route.ts": 'export const route = 1;', "scene.ts": "export {};", "unrelated.ts": "export {};" });
  const closure = discoverInputClosure(root, ["spec.ts"]);
  expect(closure.unresolved).toEqual([]);
  for (const file of ["config.ts", "command.ts", "fixture.ts", "route.ts", "scene.ts"]) expect(closureSelects([file], closure, true)).toBe(true);
  expect(closureSelects(["unrelated.ts"], closure, true)).toBe(false);
});
test("unknown computed imports fail closed until exact declared targets and their imports are resolved", () => {
  const root = fixture({ "spec.ts": 'const name = process.argv[2]; await import(name);', "child.ts": 'import "./route.js";', "route.ts": "export {};" });
  const unresolved = discoverInputClosure(root, ["spec.ts"]);
  expect(unresolved.unresolved).toContain("Computed import spec.ts: import(name)");
  expect(closureSelects(["unrelated.ts"], unresolved, true)).toBe(true);
  const closed = discoverInputClosure(root, ["spec.ts"], [{ owner: "spec.ts", inputs: [{ expression: "import(name)", targets: ["child.ts"] }] }]);
  expect(closed.unresolved).toEqual([]);
  expect(closureSelects(["route.ts"], closed, true)).toBe(true);
});
test("spawn, generated entrypoint and data declaration follows every target transitively", () => {
  const expression = 'spawn("bun", [generated])';
  const root = fixture({ "command.ts": `import {spawn} from "node:child_process"; const generated="shim"; ${expression};`, "shim.ts": 'import "./route.js";', "route.ts": "export {};", "corpus/note.md": "# Ithaca" });
  const declaration: InputDeclaration = { owner: "command.ts", inputs: [{ expression, targets: ["shim.ts", "corpus"] }] };
  expect(closureSelects(["unrelated.ts"], discoverInputClosure(root, ["command.ts"]), true)).toBe(true);
  const closed = discoverInputClosure(root, ["command.ts"], [declaration]);
  expect(closed.unresolved).toEqual([]);
  for (const file of ["route.ts", "corpus/note.md", "corpus/new-note.md"]) expect(closureSelects([file], closed, true)).toBe(true);
  expect(closureSelects(["unrelated.ts"], closed, true)).toBe(false);
});
test("missing, invalid, stale and unused declarations cannot silently narrow source ownership", () => {
  const root = fixture({ "command.ts": 'import {readFileSync as load} from "node:fs"; load(target);', "data.md": "# Ithaca", "unused.ts": "export {};" });
  const cases: InputDeclaration[][] = [[], [{ owner: "command.ts", inputs: [{ expression: "load(target)", targets: ["command.ts"] }] }], [{ owner: "command.ts", inputs: [{ expression: "load(target)", targets: [] }] }], [{ owner: "command.ts", inputs: [{ expression: "load(target)", targets: ["missing.md"] }] }], [{ owner: "command.ts", inputs: [{ expression: 'load("old")', targets: ["data.md"] }] }], [{ owner: "unused.ts", inputs: [] }]];
  for (const declarations of cases) {
    const closure = discoverInputClosure(root, ["command.ts"], declarations);
    expect(closure.unresolved.length).toBeGreaterThan(0);
    expect(closureSelects(["unrelated.ts"], closure, true)).toBe(true);
  }
});
test("capture ownership remains independent of browser inputs and rejects missing assets", () => {
  const root = fixture({ "capture.ts": 'import "./capture-source.js";', "capture-source.ts": 'import "./capture-asset.svg";', "capture-asset.svg": "<svg/>", "browser.ts": "export {};" });
  const closure = discoverInputClosure(root, ["capture.ts"]);
  expect(closure.unresolved).toEqual([]);
  for (const file of ["capture.ts", "capture-source.ts", "capture-asset.svg"]) expect(closureSelects([file], closure, true)).toBe(true);
  expect(closureSelects(["browser.ts"], closure, true)).toBe(false);
  rmSync(join(root, "capture-asset.svg"));
  expect(closureSelects(["unrelated.ts"], discoverInputClosure(root, ["capture.ts"]), true)).toBe(true);
});

test("unsupported computed call and CSS/build input forms retain broad selection", () => {
  const root = fixture({ "spec.ts": 'import * as fs from "node:fs"; fs[method](target); import "./style.css";', "style.css": '@source "./";' });
  const closure = discoverInputClosure(root, ["spec.ts"]);
  expect(closure.unresolved).toContain("Undeclared input spec.ts: fs[method](target)");
  expect(closure.unresolved).toContain("Unsupported CSS/build inputs: style.css");
  expect(closureSelects(["unrelated.ts"], closure, true)).toBe(true);
});
test("the real config command declarations include every app route and corpus inputs", () => {
  const root = resolve(import.meta.dir, "..");
  const declarations = require("../packages/ui-kit/tests/proof-inputs.json") as InputDeclaration[];
  const closure = discoverInputClosure(root, ["packages/ui-kit/vitest.config.ts"], declarations);
  // Checks discovery itself; broad fallback cannot make an omitted route pass.
  for (const route of new Bun.Glob("packages/ui-server/src/routes/*.ts").scanSync({ cwd: root })) expect(closure.files).toContain(route);
  expect(closure.files).toContain("packages/core/fixtures/corpus/notes/quick-note-water.md");
  expect(closure.files).toContain("packages/ui-react/tests/fixtures/hygiene-loop-cli.ts");
  expect(closure.files).toContain("packages/ui-react/tests/browser/hygiene-reload-scene.tsx");
  expect(closure.unresolved.some(edge => edge.startsWith("Computed import packages/core/src/lib/config.ts:"))).toBe(true);
});

test("workspace conditional exports use the installed TypeScript Bun resolution", () => {
  const root = fixture({ "spec.ts": 'import "@schlessera/brain-fixture";', "packages/lib/package.json": JSON.stringify({ name: "@schlessera/brain-fixture", exports: { ".": { bun: "./src/index.ts", default: "./dist/index.js" } } }), "packages/lib/src/index.ts": 'import "./source.js";', "packages/lib/src/source.ts": "export {};", "packages/lib/dist/index.js": "export {};" });
  mkdirSync(join(root, "node_modules/@schlessera"), { recursive: true });
  symlinkSync(join(root, "packages/lib"), join(root, "node_modules/@schlessera/brain-fixture"));
  const closure = discoverInputClosure(root, ["spec.ts"]);
  expect(closure.unresolved).toEqual([]);
  expect(closure.files).toContain("packages/lib/src/source.ts");
  expect(closure.files).not.toContain("packages/lib/dist/index.js");
});
test("otherwise valid declarations reject extra stale and unused ownership", () => {
  const root = fixture({ "spec.ts": 'import {readFileSync} from "node:fs"; readFileSync(target);', "data.md": "# Ithaca", "unused.ts": "export {};" });
  const valid: InputDeclaration = { owner: "spec.ts", inputs: [{ expression: "readFileSync(target)", targets: ["data.md"] }] };
  expect(discoverInputClosure(root, ["spec.ts"], [valid]).unresolved).toEqual([]);
  const stale = discoverInputClosure(root, ["spec.ts"], [{ ...valid, inputs: [...valid.inputs, { expression: 'readFileSync("old")', targets: ["data.md"] }] }]);
  expect(stale.unresolved).toEqual(['Stale declaration spec.ts: readFileSync("old")']);
  expect(closureSelects(["unrelated.ts"], stale, true)).toBe(true);
  const unused = discoverInputClosure(root, ["spec.ts"], [valid, { owner: "unused.ts", inputs: [] }]);
  expect(unused.unresolved).toEqual(["Unused declaration owner: unused.ts"]);
});

test("a file-reader alias passed through an unsupported binding cannot disappear", () => {
  const root = fixture({ "spec.ts": 'import {readFileSync} from "node:fs"; const load = readFileSync; load(target);' });
  const closure = discoverInputClosure(root, ["spec.ts"]);
  expect(closure.unresolved).toContain("Unsupported input alias spec.ts: readFileSync");
  expect(closureSelects(["unrelated.ts"], closure, true)).toBe(true);
});

test("actual category discovery preserves closed capture inputs when Vitest is unavailable", () => {
  const root = fixture({ "scripts/capture.ts": 'import "./captures/client.js";', "scripts/captures/client.ts": 'import "./asset.svg";', "scripts/captures/asset.svg": "<svg/>", "scripts/captures/proof-inputs.json": "[]", "docs/process/feature-captures.md": "# Capture" });
  const closures = discoverBrowserClosures(root);
  expect(closures.browser.unresolved.length).toBeGreaterThan(0);
  expect(closures.captures.unresolved).toEqual([]);
  expect(closureSelects(["scripts/captures/asset.svg"], closures.captures, true)).toBe(true);
  expect(closureSelects(["packages/ui-server/src/unrelated.ts"], closures.captures, true)).toBe(false);
});

test("one declaration cannot silently cover two identical calls with different runtime bindings", () => {
  const root = fixture({ "spec.ts": 'import {readFileSync} from "node:fs"; function a(target:string){readFileSync(target)} function b(target:string){readFileSync(target)}', "data.md": "# Ithaca" });
  const closure = discoverInputClosure(root, ["spec.ts"], [{ owner: "spec.ts", inputs: [{ expression: "readFileSync(target)", targets: ["data.md"] }] }]);
  expect(closure.unresolved).toContain("Ambiguous declaration site spec.ts: readFileSync(target)");
  expect(closureSelects(["unrelated.ts"], closure, true)).toBe(true);
});
