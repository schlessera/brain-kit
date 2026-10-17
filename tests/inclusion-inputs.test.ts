import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { inclusionInputs } from "../scripts/inclusion-inputs";
import { git, type Spec } from "../scripts/proof-inputs";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const spec = "packages/ui-kit/tests/visual/one.visual.tsx", second = "packages/ui-kit/tests/visual/two.visual.tsx";
const inventory: Spec[] = [spec, second].map(file => ({ project: "ui-react-layout", file }));
function write(root: string, file: string, text: string) { mkdirSync(dirname(join(root, file)), { recursive: true }); writeFileSync(join(root, file), text); }
function commit(root: string) { git(root, "add", "."); git(root, "-c", "user.name=Odysseus", "-c", "user.email=odysseus@example.invalid", "commit", "-qm", "fixture"); return git(root, "rev-parse", "HEAD").trim(); }
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "inclusion-inputs-")); roots.push(root); git(root, "init", "-q"); git(root, "config", "commit.gpgsign", "false");
  write(root, ".gitignore", "node_modules\n"); symlinkSync(resolve(import.meta.dir, "../node_modules"), join(root, "node_modules"), "dir");
  for (const path of ["package.json", "bun.lock", "tsconfig.json"]) write(root, path, "{}\n");
  for (const path of ["bunfig.toml", ".github/workflows/ci.yml", "packages/ui-kit/vitest.config.ts", "packages/ui-kit/vite.config.ts", "packages/ui-kit/.storybook/main.ts", "packages/ui-kit/.storybook/preview.ts", "scripts/visual.mjs", "scripts/build.ts", "scripts/workspace-lease.mjs", "packages/ui-kit/src/styles.css", "packages/ui-react/src/styles.css"]) write(root, path, "");
  write(root, "packages/ui-kit/tests/proof-inputs.json", "[]"); write(root, "scripts/css-proof-inputs.json", "[]"); write(root, "scripts/browser-shard-costs.json", JSON.stringify({ seconds: { [`ui-react-layout::${spec}`]: 1 } }));
  write(root, spec, `import "../../../src/fixture.ts";\n`); write(root, "packages/src/fixture.ts", "export const value = 1;\n"); write(root, second, "export {};\n"); commit(root); return root;
}
test("inclusion hashes transitive immutable blobs and modes while unrelated prose can change", () => {
  const root = fixture(), initial = inclusionInputs(root, "layout", inventory, "fixed-runner");
  write(root, "docs/unrelated.md", "unrelated\n"); commit(root);
  expect(inclusionInputs(root, "layout", inventory, "fixed-runner").fingerprint).toBe(initial.fingerprint);
  write(root, "packages/src/fixture.ts", "export const value = 2;\n"); commit(root);
  expect(inclusionInputs(root, "layout", inventory, "fixed-runner").fingerprint).not.toBe(initial.fingerprint);
  const beforeMode = inclusionInputs(root, "layout", inventory, "fixed-runner"); chmodSync(join(root, spec), 0o755); commit(root);
  expect(inclusionInputs(root, "layout", inventory, "fixed-runner").fingerprint).not.toBe(beforeMode.fingerprint);
});
test("immutable source closure never reads current files, and changed resolution policy fails fresh", () => {
  const root = fixture(), source = commitIfNeeded(root), original = inclusionInputs(root, "layout", inventory, "fixed-runner");
  write(root, "packages/src/fixture.ts", "export const value = 3;\n"); commit(root);
  expect(inclusionInputs(root, "layout", inventory, "fixed-runner", source).fingerprint).toBe(original.fingerprint);
  write(root, "bun.lock", "changed resolution\n"); commit(root);
  expect(() => inclusionInputs(root, "layout", inventory, "fixed-runner", source)).toThrow("algorithm or dependency");
});
function commitIfNeeded(root: string) { return git(root, "rev-parse", "HEAD").trim(); }
test("browser capability cannot become eligible merely by hiding a Worker constructor from syntax discovery",()=>{
  const root=fixture(),browserInventory=inventory.map(spec=>({...spec,project:"visual"}));
  expect(()=>inclusionInputs(root,"browser",browserInventory,"fixed-runner")).toThrow("unvalidated selected Worker capability audit");
  write(root,spec,'const realm=globalThis; const Constructor=realm.Worker; export const make=()=>new Constructor("unowned.js");');commit(root);
  expect(()=>inclusionInputs(root,"browser",browserInventory,"fixed-runner")).toThrow("unvalidated selected Worker capability audit");
});
test("undeclared computed runtime inputs and missing or symbolic source cannot authorize reuse", () => {
  const root = fixture(); write(root, spec, "const value = await import(modulePath);\n"); commit(root);
  expect(() => inclusionInputs(root, "layout", inventory, "fixed-runner")).toThrow("Unresolved immutable");
  write(root, spec, `import "../../../src/fixture.ts";\n`); rmSync(join(root, "packages/src/fixture.ts")); commit(root);
  expect(() => inclusionInputs(root, "layout", inventory, "fixed-runner")).toThrow("Unresolved immutable");
  symlinkSync("/tmp/unknown-proof-input", join(root, "packages/src/fixture.ts")); commit(root);
  expect(() => inclusionInputs(root, "layout", inventory, "fixed-runner")).toThrow();
});


test("declared directory inputs hash tracked additions, deletion and rename identities", () => {
  const root = fixture();
  write(root, spec, `import {readdirSync} from "node:fs"; readdirSync(target);\n`);
  write(root, "data/one.md", "Ithaca\n");
  write(root, "packages/ui-kit/tests/proof-inputs.json", JSON.stringify([{ owner: spec, inputs: [{ expression: "readdirSync(target)", targets: ["data"] }] }])); commit(root);
  const before = inclusionInputs(root, "layout", inventory, "fixed-runner").fingerprint;
  write(root, "data/two.md", "Raft\n"); commit(root);
  const added = inclusionInputs(root, "layout", inventory, "fixed-runner").fingerprint; expect(added).not.toBe(before);
  renameSync(join(root, "data/two.md"), join(root, "data/renamed.md")); commit(root);
  const renamed = inclusionInputs(root, "layout", inventory, "fixed-runner").fingerprint; expect(renamed).not.toBe(added);
  rmSync(join(root, "data/renamed.md")); commit(root);
  expect(inclusionInputs(root, "layout", inventory, "fixed-runner").fingerprint).toBe(before);
});

test("workspace source resolution stays inside its immutable snapshot instead of current install links", () => {
  const root = fixture();
  write(root, "packages/lib/package.json", JSON.stringify({ name: "@schlessera/brain-ui-react", exports: { ".": { bun: "./src/index.ts", default: "./dist/index.js" } } }));
  write(root, "packages/lib/src/index.ts", "export const value = 1;\n");
  write(root, spec, `import "@schlessera/brain-ui-react";\n`); const source = commit(root);
  const original = inclusionInputs(root, "layout", inventory, "fixed-runner");
  write(root, "packages/lib/src/index.ts", "export const value = 2;\n"); commit(root);
  expect(inclusionInputs(root, "layout", inventory, "fixed-runner", source).fingerprint).toBe(original.fingerprint);
  expect(inclusionInputs(root, "layout", inventory, "fixed-runner").fingerprint).not.toBe(original.fingerprint);
});

test("validated installed asset bytes and mode join immutable source fingerprints",()=>{
  const root=fixture();rmSync(join(root,"node_modules"));mkdirSync(join(root,"node_modules"));
  const installed=resolve(import.meta.dir,"../node_modules");
  for(const entry of readdirSync(installed)) if(entry!=="axe-core") symlinkSync(join(installed,entry),join(root,"node_modules",entry),"dir");
  const owner="packages/ui-react/tests/browser/offline/cold-capture/commands.ts";
  for(const file of [owner,"scripts/build.ts","scripts/build-receipt.ts","scripts/bin-modes.ts","scripts/publishable-packages.ts","scripts/workspace-lease.mjs","scripts/ci-proof.ts","scripts/check-pr.ts","scripts/ci-runner.ts",".github/workflows/ci.yml","package.json","packages/ui-react/package.json","packages/ui-kit/package.json"])
    write(root,file,readFileSync(resolve(import.meta.dir,"..",file),"utf8"));
  write(root,spec,`import "../../../ui-react/tests/browser/offline/cold-capture/commands.ts";`);
  write(root,"node_modules/axe-core/package.json",JSON.stringify({name:"axe-core",version:"4.13.0"}));write(root,"node_modules/axe-core/axe.min.js","owned asset before");commit(root);
  const initial=inclusionInputs(root,"layout",inventory,"fixed-runner").fingerprint;
  write(root,"node_modules/axe-core/axe.min.js","owned asset after");
  expect(inclusionInputs(root,"layout",inventory,"fixed-runner").fingerprint).not.toBe(initial);
  const beforeMode=inclusionInputs(root,"layout",inventory,"fixed-runner").fingerprint;chmodSync(join(root,"node_modules/axe-core/axe.min.js"),0o755);
  expect(inclusionInputs(root,"layout",inventory,"fixed-runner").fingerprint).not.toBe(beforeMode);
  rmSync(join(root,"node_modules/axe-core/axe.min.js"));
  expect(()=>inclusionInputs(root,"layout",inventory,"fixed-runner")).toThrow("Unresolved immutable");
});

test("selected Vitest screenshot baselines are immutable proof inputs",()=>{
 const root=fixture(),baseline="packages/ui-kit/tests/visual/__screenshots__/one.visual.tsx/owned-chromium-linux.png";
 write(root,spec,'expect(subject).toMatchScreenshot("owned");');write(root,baseline,"first pinned image bytes");commit(root);
 const original=inclusionInputs(root,"layout",inventory,"fixed-runner").fingerprint;
 write(root,baseline,"changed pinned image bytes");commit(root);
 expect(inclusionInputs(root,"layout",inventory,"fixed-runner").fingerprint,"SCREENSHOT_BASELINE_CONTENT_INVALIDATES_RETAINED_PROOF").not.toBe(original);
});

test("baseline additions, renames, deletion, mode and immutable source use actual tracked image identity",()=>{
 const root=fixture(),directory="packages/ui-kit/tests/visual/__screenshots__/one.visual.tsx",baseline=directory+"/owned-chromium-linux.png";
 write(root,spec,'expect(subject).toMatchScreenshot("owned");');write(root,baseline,"original image");const source=commit(root),original=inclusionInputs(root,"layout",inventory,"fixed-runner").fingerprint;
 write(root,directory+"/added.png","added image");commit(root);const added=inclusionInputs(root,"layout",inventory,"fixed-runner").fingerprint;expect(added).not.toBe(original);
 renameSync(join(root,directory+"/added.png"),join(root,directory+"/renamed.png"));commit(root);expect(inclusionInputs(root,"layout",inventory,"fixed-runner").fingerprint).not.toBe(added);
 rmSync(join(root,directory+"/renamed.png"));commit(root);expect(inclusionInputs(root,"layout",inventory,"fixed-runner").fingerprint).toBe(original);
 chmodSync(join(root,baseline),0o755);commit(root);expect(inclusionInputs(root,"layout",inventory,"fixed-runner").fingerprint).not.toBe(original);
 expect(inclusionInputs(root,"layout",inventory,"fixed-runner",source).fingerprint).toBe(original);
});
test("custom screenshot directories, resolvers and computed options stay fresh",()=>{
 for(const body of ['expect(subject).toMatchScreenshot("owned",{resolveScreenshotPath:()=>"/unowned.png"});','const options=externalOptions;expect(subject).toMatchScreenshot("owned",options);','const options={comparatorOptions:{threshold:0}};Object.assign(options,external);expect(subject).toMatchScreenshot("owned",options);']){const root=fixture();write(root,spec,body);commit(root);expect(()=>inclusionInputs(root,"layout",inventory,"fixed-runner")).toThrow("Unsupported screenshot");}
 const root=fixture();write(root,spec,'expect(subject).toMatchScreenshot("owned");');write(root,"packages/ui-kit/vitest.config.ts",'export default {test:{browser:{screenshotDirectory:"/unowned"}}};');commit(root);expect(()=>inclusionInputs(root,"layout",inventory,"fixed-runner")).toThrow("Unsupported screenshot");
});
test("a screenshot-directory symlink cannot hide an external baseline behind absent tracked children",()=>{
 for(const suffix of ["", "/one.visual.tsx"]){const root=fixture(),directory="packages/ui-kit/tests/visual/__screenshots__"+suffix;write(root,spec,'expect(subject).toMatchScreenshot("owned");');mkdirSync(dirname(join(root,directory)),{recursive:true});symlinkSync("/tmp/unowned-baselines",join(root,directory));commit(root);expect(()=>inclusionInputs(root,"layout",inventory,"fixed-runner")).toThrow("Screenshot directory");}
});
