import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
  const root = fixture({ "spec.ts": 'import * as fs from "node:fs"; fs[method](target); import "./style.css";', "style.css": '@source inline("unknown");' });
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
  const root = fixture({ "scripts/capture.ts": 'import "./captures/client.js";', "scripts/captures/client.ts": 'import "./asset.svg";', "scripts/captures/asset.svg": "<svg/>", "scripts/captures/proof-inputs.json": "[]", "scripts/css-proof-inputs.json": "[]", "packages/ui-kit/src/styles.css": "", "packages/ui-react/src/styles.css": "", "docs/process/feature-captures.md": "# Capture" });
  const closures = discoverBrowserClosures(root);
  expect(closures.browser.unresolved.length).toBeGreaterThan(0);
  expect(closures.captures.unresolved).toEqual([]);
  expect(closureSelects(["scripts/captures/asset.svg"], closures.captures, true)).toBe(true);
  expect(closureSelects(["packages/ui-server/src/unrelated.ts"], closures.captures, true)).toBe(false);
  writeFileSync(join(root, "scripts/css-proof-inputs.json"), "malformed");
  expect(discoverBrowserClosures(root).captures.unresolved).toContain("Cannot establish capture input ownership");
});

test("one declaration cannot silently cover two identical calls with different runtime bindings", () => {
  const root = fixture({ "spec.ts": 'import {readFileSync} from "node:fs"; function a(target:string){readFileSync(target)} function b(target:string){readFileSync(target)}', "data.md": "# Ithaca" });
  const closure = discoverInputClosure(root, ["spec.ts"], [{ owner: "spec.ts", inputs: [{ expression: "readFileSync(target)", targets: ["data.md"] }] }]);
  expect(closure.unresolved).toContain("Ambiguous declaration site spec.ts: readFileSync(target)");
  expect(closureSelects(["unrelated.ts"], closure, true)).toBe(true);
});


test("CSS discovery follows local imports, raw scan roots and assets without executing scanned source", () => {
  const root = fixture({ "entry.ts": 'import "./styles/main.css";', "styles/main.css": '@import "./theme.css"; @source "./scan"; .boat { background: url("./boat.svg"); }', "styles/theme.css": '@import "./tokens.css";', "styles/tokens.css": ':root { --ink: black; }', "styles/boat.svg": "<svg/>", "styles/scan/note.tsx": 'require(unknown);', "styles/scan/nested/note.md": "# Ithaca" });
  const closure = discoverInputClosure(root, ["entry.ts"]);
  expect(closure.unresolved).toEqual([]);
  for (const file of ["styles/theme.css", "styles/tokens.css", "styles/boat.svg", "styles/scan/note.tsx", "styles/scan/nested/note.md", "styles/scan/new.tsx", "styles/scan/nested/renamed.md"]) expect(closureSelects([file], closure, true)).toBe(true);
  expect(closureSelects(["other.ts"], closure, true)).toBe(false);
  rmSync(join(root, "styles/boat.svg"));
  expect(discoverInputClosure(root, ["entry.ts"]).unresolved).toContain("Missing input: styles/boat.svg");
});

test("CSS exact declarations resolve owned package imports and reject stale or ambiguous ownership", () => {
  const expression = '@import "tailwindcss" source(none);';
  const root = fixture({ "entry.ts": 'import "./styles.css";', "styles.css": expression + '\n@source "./scan";', "scan/boat.tsx": "export {};", "bun.lock": "locked", "package.json": "{}" });
  const declaration = { owner: "styles.css", inputs: [{ expression, targets: ["bun.lock", "package.json"] }] };
  expect(discoverInputClosure(root, ["entry.ts"], [declaration]).unresolved).toEqual([]);
  writeFileSync(join(root, "styles.css"), '@import "tailwindcss";');
  const implicitScan = discoverInputClosure(root, ["entry.ts"], [declaration]);
  expect(implicitScan.unresolved).toContain('Stale declaration styles.css: ' + expression);
  expect(implicitScan.unresolved).toContain('Undeclared CSS input styles.css: @import "tailwindcss";');
  expect(closureSelects(["unrelated.ts"], implicitScan, true)).toBe(true);
  writeFileSync(join(root, "styles.css"), '@import "other" source(none);');
  const stale = discoverInputClosure(root, ["entry.ts"], [declaration]);
  expect(stale.unresolved).toContain('Stale declaration styles.css: ' + expression);
  expect(closureSelects(["unrelated.ts"], stale, true)).toBe(true);
  writeFileSync(join(root, "styles.css"), expression + expression);
  expect(discoverInputClosure(root, ["entry.ts"], [declaration]).unresolved).toContain('Ambiguous declaration site styles.css: ' + expression);
});

test("CSS unsupported syntax, escapes, absent scans and symlinks remain unresolved", () => {
  const root = fixture({ "entry.ts": 'import "./styles/main.css";', "styles/main.css": "", "styles/asset.svg": "<svg/>" });
  for (const text of ['@source inline("boat");', '@source "./missing";', '@import "https://example.invalid/theme.css";', '@import "./asset.svg" screen;', '.x {background: url(var(--asset));}', '@source "../../outside";', '@plugin "./plugin.js";', '@use "./other.scss";', '.x { background: u/**/rl("./missing.svg"); }', '@source "./sc\\61n";']) {
    writeFileSync(join(root, "styles/main.css"), text);
    const closure = discoverInputClosure(root, ["entry.ts"]);
    expect(closure.unresolved.length).toBeGreaterThan(0);
    expect(closureSelects(["unrelated.ts"], closure, true)).toBe(true);
  }
  symlinkSync(join(root, "styles/asset.svg"), join(root, "styles/link.svg"));
  writeFileSync(join(root, "styles/main.css"), '.x {background: url("./link.svg");}');
  expect(discoverInputClosure(root, ["entry.ts"]).unresolved).toContain("Unsupported symbolic input: styles/link.svg");
});


test("CSS scan directory ownership survives additions, deletion, renames and source import ordering", () => {
  const root = fixture({ "entry.ts": 'import "./styles.css"; import "./scan/app.js";', "styles.css": '@source "./scan";', "scan/app.ts": 'import "../owned.js";', "owned.ts": "export {};", "scan/old.md": "Ithaca" });
  const before = discoverInputClosure(root, ["entry.ts"]);
  expect(before.unresolved).toEqual([]);
  expect(before.files).toContain("owned.ts");
  writeFileSync(join(root, "scan/new.md"), "Boat");
  renameSync(join(root, "scan/old.md"), join(root, "scan/renamed.md"));
  const after = discoverInputClosure(root, ["entry.ts"]);
  expect(after.files).toContain("scan/new.md");
  expect(after.files).toContain("scan/renamed.md");
  expect(after.files).not.toContain("scan/old.md");
  for (const closure of [before, after]) for (const path of ["scan/old.md", "scan/new.md", "scan/renamed.md"]) expect(closureSelects([path], closure, false)).toBe(true);
  rmSync(join(root, "scan"), { recursive: true });
  expect(discoverInputClosure(root, ["styles.css"]).unresolved).toContain("Missing CSS scan directory styles.css: ./scan");
});

test("CSS lexical discovery ignores strings/comments and handles case without hiding unsupported directives", () => {
  const root = fixture({ "entry.css": `/* @import "missing.css"; */ .x { content: '@source "missing";'; } @IMPORT "./theme.css";`, "theme.css": ":root{}" });
  expect(discoverInputClosure(root, ["entry.css"]).unresolved).toEqual([]);
  expect(discoverInputClosure(root, ["entry.css"]).files).toContain("theme.css");
  for (const text of ['@PLUGIN "./missing.js";', '@import "./theme.css"', '/* unfinished', '.x { background: url("./missing.svg"); }']) {
    writeFileSync(join(root, "entry.css"), text);
    expect(discoverInputClosure(root, ["entry.css"]).unresolved.length).toBeGreaterThan(0);
  }
});


test("CSS root scan reproduction resolves and declarations cannot waive unsupported or local missing inputs", () => {
  const root = fixture({ "entry.ts": 'import "./styles.css";', "styles.css": '@source "./";', "note.md": "Ithaca" });
  const closure = discoverInputClosure(root, ["entry.ts"]);
  expect(closure.unresolved).toEqual([]);
  expect(closure.files).toContain("note.md");
  expect(closureSelects(["new-note.md"], closure, false)).toBe(true);
  for (const expression of ['@import "https://example.invalid/style.css";', '@source inline("boat");', '@source "./missing";', '@import "./missing.css";']) {
    writeFileSync(join(root, "styles.css"), expression);
    const invalid = discoverInputClosure(root, ["entry.ts"], [{ owner: "styles.css", inputs: [{ expression, targets: ["note.md"] }] }]);
    expect(invalid.unresolved.length).toBeGreaterThan(0);
    expect(closureSelects(["unrelated.ts"], invalid, true)).toBe(true);
  }
});


test("a declared file read can retain exact result transformation calls without stale ownership", () => {
  const inner = `readFileSync(target, "utf8")`, outer = inner + `.replace("boat", "raft")`;
  const root = fixture({ "spec.ts": `import {readFileSync} from "node:fs"; ${outer};`, "data.md": "boat" });
  const closure = discoverInputClosure(root, ["spec.ts"], [{ owner: "spec.ts", inputs: [{ expression: inner, targets: ["data.md"] }, { expression: outer, targets: ["data.md"] }] }]);
  expect(closure.unresolved).toEqual([]);
  expect(closure.files).toContain("data.md");
});

test("type-only imported files are hashed without executing their unrelated runtime inputs", () => {
  const root = fixture({ "spec.ts": `import type { Shape } from "./types.js"; export type { Shape } from "./types.js";`, "types.ts": `import {readFileSync} from "node:fs"; export type Shape = string; readFileSync(unknown);` });
  const closure = discoverInputClosure(root, ["spec.ts"]);
  expect(closure.files).toContain("types.ts");
  expect(closure.unresolved).toEqual([]);
  writeFileSync(join(root, "spec.ts"), `import "./types.js";`);
  expect(discoverInputClosure(root, ["spec.ts"]).unresolved).toContain("Undeclared input types.ts: readFileSync(unknown)");
});


test("exact lexical scopes bind duplicate kernel identity observations without hiding another read", () => {
  const expression = `readFileSync("/proc/sys/kernel/random/boot_id", "utf8")`;
  const root = fixture({ "spec.ts": `import {readFileSync} from "node:fs"; function identity(){return ${expression}} function alive(){return ${expression}}` });
  const declaration: InputDeclaration = { owner: "spec.ts", inputs: ["identity", "alive"].map(scope => ({ expression, scope, observation: "linux-proc-self-identity", targets: [] })) };
  expect(discoverInputClosure(root, ["spec.ts"], [declaration]).unresolved).toEqual([]);
  expect(discoverInputClosure(root, ["spec.ts"], [{ ...declaration, inputs: declaration.inputs.slice(0, 1) }]).unresolved).toContain(`Undeclared input spec.ts: ${expression}`);
  writeFileSync(join(root, "spec.ts"), `import {readFileSync} from "node:fs"; function identity(){return readFileSync("/tmp/provider-data.json", "utf8")} function alive(){return ${expression}}`);
  expect(discoverInputClosure(root, ["spec.ts"], [declaration]).unresolved.length).toBeGreaterThan(0);
});

test("runner observation declarations cannot waive arbitrary files, dynamic imports, CSS or descriptor paths", () => {
  for (const expression of [`readFileSync("/tmp/provider-data.json", "utf8")`, `readFileSync(path, "utf8")`, `readFileSync("/proc/self/fd/5", "utf8")`, `import(target)`, `new Bun.Glob("**/*")`]) {
    const root = fixture({ "spec.ts": `import {readFileSync} from "node:fs"; ${expression};` });
    const closure = discoverInputClosure(root, ["spec.ts"], [{ owner: "spec.ts", inputs: [{ expression, observation: "linux-proc-self-identity", targets: [] }] }]);
    expect(closure.unresolved.some(item => item.startsWith("Invalid runner observation"))).toBe(true);
  }
  const css = fixture({ "entry.css": `@import "tailwindcss" source(none);` });
  expect(discoverInputClosure(css, ["entry.css"], [{ owner: "entry.css", inputs: [{ expression: `@import "tailwindcss" source(none);`, observation: "linux-proc-self-identity", targets: [] }] }]).unresolved.length).toBeGreaterThan(0);
});


test("declared Linux self identity paths read actual kernel metadata with no repository payload", () => {
  const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  expect(boot).toMatch(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
  expect(readlinkSync("/proc/self/ns/pid")).toMatch(/^pid:\[[0-9]+\]$/);
  expect(readFileSync("/proc/self/status", "utf8")).toContain(`Pid:\t${process.pid}`);
});


test("shadowed or non-filesystem reader aliases cannot claim a kernel observation", () => {
  const expression = `readFileSync("/proc/sys/kernel/random/boot_id", "utf8")`;
  for (const source of [`import {readFileSync} from "node:fs"; function local(readFileSync: any) { return ${expression}; }`, `import {readFileSync} from "node:child_process"; ${expression};`]) {
    const root = fixture({ "spec.ts": source });
    expect(discoverInputClosure(root, ["spec.ts"], [{ owner: "spec.ts", inputs: [{ expression, observation: "linux-proc-self-identity", targets: [] }] }]).unresolved.some(item => item.startsWith("Invalid runner observation"))).toBe(true);
  }
});

test("Git environment reads stay unknown while literal UI copy and local GitHub names are source bytes", () => {
  const root=fixture({"entry.ts":`const GITHUB_ITEM=/path/; const message="GITHUB_TOKEN"; console.log(GITHUB_ITEM,message);`});
  expect(discoverInputClosure(root,["entry.ts"]).unresolved).toEqual([]);
  writeFileSync(join(root,"entry.ts"),`console.log(process.env.GITHUB_SHA,process.env["GITHUB_RUN_ID"]);`);
  expect(discoverInputClosure(root,["entry.ts"]).unresolved).toContain("Git-dependent execution input: entry.ts");
});
