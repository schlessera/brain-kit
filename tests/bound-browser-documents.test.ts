import {afterEach,expect,test} from "bun:test";
import {mkdirSync,mkdtempSync,readFileSync,rmSync,symlinkSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {dirname,join,resolve} from "node:path";
import {browserImporters} from "../scripts/bound-browser-runtime-inputs";
import {boundBrowserDocuments} from "../scripts/bound-browser-documents";
const repo=resolve(import.meta.dir,".."),roots:string[]=[],owner="packages/ui-kit/tests/visual/form-browser.ts",caller="packages/ui-react/tests/browser/destination-press.pointer.tsx",config="packages/ui-kit/vitest.config.ts",files=[owner,caller,config];
afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
function fixture(extra:readonly string[]=[]){const root=mkdtempSync(join(tmpdir(),"bound-browser-documents-"));roots.push(root);const write=(file:string,text:string)=>{mkdirSync(dirname(join(root,file)),{recursive:true});writeFileSync(join(root,file),text);};symlinkSync(join(repo,"node_modules"),join(root,"node_modules"),"dir");for(const file of [...files,...extra])write(file,readFileSync(join(repo,file),"utf8"));return{root,write};}
test("the exact HTML fixture has only source-owned reporting document and cleanup calls",()=>{
  const {root}=fixture(),bound=boundBrowserDocuments(root,files,browserImporters(root,files));
  expect([...bound.get(owner)!.values()]).toEqual([{runtime:[caller],bytes:[]}]);
});
test("additional direct, renamed and dynamic command callers cannot supply unchecked HTML",()=>{
  for(const source of [
    'import {commands} from "vitest/browser"; commands.htmlPreviewFixture("x", external);',
    'import {commands as api} from "vitest/browser"; api.htmlPreviewFixture("x", external);',
    "const {commands: api}=await import('vitest/browser'); api.htmlPreviewFixture('x',external);",
  ]){const {root,write}=fixture();write("extra.ts",source);const selected=[...files,"extra.ts"];expect(boundBrowserDocuments(root,selected,browserImporters(root,selected)).has(owner)).toBe(false);}
});
test("producer/caller/config edits or direct command-owner imports require fresh input proof",()=>{
  for(const file of files){const {root,write}=fixture();write(file,readFileSync(join(root,file),"utf8")+"\n// origin drift\n");expect(boundBrowserDocuments(root,files,browserImporters(root,files)).has(owner)).toBe(false);}
  const {root,write}=fixture();write("extra.ts",`import {htmlPreviewFixture} from "./${owner}";`);const selected=[...files,"extra.ts"];expect(boundBrowserDocuments(root,selected,browserImporters(root,selected)).has(owner)).toBe(false);
});
const ghost="packages/ui-kit/tests/visual/ghost-browser.ts",ghostCaller="packages/ui-kit/tests/visual/ghost-sweep.visual.tsx",guard="packages/ui-kit/tests/visual/zero-request-replay.ts";
const ghostFiles=[ghost,ghostCaller,guard,"packages/ui-kit/stories/states/GhostSweep.stories.tsx","packages/ui-kit/.storybook/preview.ts","packages/ui-kit/.storybook/preview.css","packages/ui-kit/tests/visual/design-font-setup.ts","packages/ui-kit/tests/visual/design-font-checks.ts","packages/ui-kit/tests/visual/rank-footer-browser.ts","scripts/captures/fonts.ts","scripts/captures/font-lock.json","scripts/captures/fonts.css","packages/ui-kit/.storybook/preview-head.html"];
test("argument-free replay binds its Performance producer, zero-request guard and verified inline fonts",()=>{
  const {root}=fixture(ghostFiles),selected=[...files,...ghostFiles],bound=boundBrowserDocuments(root,selected,browserImporters(root,selected));
  const inputs=[...bound.get(ghost)!.values()][0]!;expect(inputs.runtime).toContain(guard);expect(inputs.runtime).toContain(ghostCaller);expect(inputs.bytes).toContain("scripts/captures/fonts.css");
});
test("replay caller, guard, CSS and font-origin drift or an additional caller stays unknown",()=>{
  for(const file of [ghostCaller,guard,"packages/ui-kit/.storybook/preview.css","scripts/captures/fonts.css"]){const {root,write}=fixture(ghostFiles),selected=[...files,...ghostFiles];write(file,readFileSync(join(root,file),"utf8")+"\n/* drift */\n");expect(boundBrowserDocuments(root,selected,browserImporters(root,selected)).has(ghost)).toBe(false);}
  const {root,write}=fixture(ghostFiles);write("extra.ts",'import {commands} from "vitest/browser"; commands.ghostTrace();');const selected=[...files,...ghostFiles,"extra.ts"];expect(boundBrowserDocuments(root,selected,browserImporters(root,selected)).has(ghost)).toBe(false);
});

const diagram="packages/ui-react/tests/browser/diagram-proof-command.ts",diagramCaller="packages/ui-react/tests/browser/diagrams-renderer.layout.tsx";
const diagramFiles=[diagram,diagramCaller,"packages/ui-react/tests/browser/diagrams-axis.layout.tsx","packages/module-diagrams/tests/fixtures/axis-examples.ts",guard,"packages/ui-kit/tests/visual/form-browser.ts","packages/ui-kit/tests/visual/design-font-setup.ts","packages/ui-kit/tests/visual/design-font-checks.ts","packages/ui-kit/tests/visual/rank-footer-browser.ts","scripts/captures/fonts.ts","scripts/captures/font-lock.json","scripts/captures/fonts.css","packages/ui-kit/.storybook/preview-head.html","packages/module-diagrams/tests/fixtures/renderer-fixture.ts","packages/module-diagrams/tests/fixtures/adopted-homecoming-relay.diagram.yaml",...new Bun.Glob("packages/module-diagrams/src/*.{ts,tsx}").scanSync({cwd:repo})];
test("diagram replay binds both exact callers and every SVG, fixture, CSS and inline-font producer",()=>{
 const {root}=fixture(diagramFiles),selected=[...files,...diagramFiles],bound=boundBrowserDocuments(root,selected,browserImporters(root,selected));
 const input=[...bound.get(diagram)!.values()][0]!;expect(input.runtime).toContain(diagramCaller);expect(input.runtime).toContain("packages/module-diagrams/src/svg-model.ts");expect(input.runtime).toContain(guard);expect(input.bytes).toContain("packages/module-diagrams/tests/fixtures/adopted-homecoming-relay.diagram.yaml");
});
test("diagram caller, renderer, fixture, guard and font drift or extra caller refuse document binding",()=>{
 for(const file of [diagram,diagramCaller,"packages/ui-react/tests/browser/diagrams-axis.layout.tsx","packages/module-diagrams/src/svg-model.ts","packages/module-diagrams/tests/fixtures/adopted-homecoming-relay.diagram.yaml",guard,"scripts/captures/fonts.css"]){const {root,write}=fixture(diagramFiles),selected=[...files,...diagramFiles];write(file,readFileSync(join(root,file),"utf8")+"\n/* drift */\n");expect(boundBrowserDocuments(root,selected,browserImporters(root,selected)).has(diagram)).toBe(false);}
 const {root,write}=fixture(diagramFiles);write("extra.ts",'import {commands as api} from "vitest/browser"; api.diagramCapture("figure","new");');const selected=[...files,...diagramFiles,"extra.ts"];expect(boundBrowserDocuments(root,selected,browserImporters(root,selected)).has(diagram)).toBe(false);
});
