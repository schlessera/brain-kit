import {afterEach,expect,test} from "bun:test";
import {mkdirSync,mkdtempSync,readFileSync,rmSync,symlinkSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {dirname,join,resolve} from "node:path";
import {browserImporters} from "../scripts/bound-browser-runtime-inputs";
import ts from "typescript";
import {boundBrowserDocuments,browserDocumentRefusals,reviewedBrowserDocuments} from "../scripts/bound-browser-documents";
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
const sceneCaller="packages/ui-react/tests/browser/diagrams-scene-bounds.layout.tsx",sceneFixture="packages/module-diagrams/tests/fixtures/origin-group.ts";
const diagramFiles=[diagram,diagramCaller,sceneCaller,sceneFixture,"packages/ui-react/tests/browser/diagrams-callouts.layout.tsx","packages/module-diagrams/tests/fixtures/callouts.ts","packages/ui-react/tests/browser/diagrams-axis.layout.tsx","packages/ui-react/tests/browser/diagrams-positional.layout.tsx","packages/ui-react/tests/browser/diagrams-node-link.layout.tsx",...new Bun.Glob("packages/module-diagrams/skills/diagram/references/examples/**/*.yaml").scanSync({cwd:repo}),"packages/module-diagrams/tests/fixtures/axis-examples.ts",guard,"packages/ui-kit/tests/visual/form-browser.ts","packages/ui-kit/tests/visual/design-font-setup.ts","packages/ui-kit/tests/visual/design-font-checks.ts","packages/ui-kit/tests/visual/rank-footer-browser.ts","scripts/captures/fonts.ts","scripts/captures/font-lock.json","scripts/captures/fonts.css","packages/ui-kit/.storybook/preview-head.html","packages/module-diagrams/tests/fixtures/renderer-fixture.ts","packages/module-diagrams/tests/fixtures/adopted-homecoming-relay.diagram.yaml",...new Bun.Glob("packages/module-diagrams/src/*.{ts,tsx}").scanSync({cwd:repo})];
test("diagram replay binds all six exact callers and every SVG, fixture, CSS and inline-font producer",()=>{
 const {root}=fixture(diagramFiles),selected=[...files,...diagramFiles],bound=boundBrowserDocuments(root,selected,browserImporters(root,selected));
 expect(bound.has(diagram),"REVIEWED_DIAGRAM_DOCUMENT_BINDS").toBe(true);
 const input=[...bound.get(diagram)!.values()][0]!;expect(input.runtime).toContain(diagramCaller);expect(input.runtime,"SCENE_CALLER_INCLUDED").toContain(sceneCaller);expect(input.runtime,"SCENE_FIXTURE_INCLUDED").toContain(sceneFixture);expect(input.runtime,"SCENE_FLATTEN_INCLUDED").toContain("packages/module-diagrams/src/flatten.ts");for(const file of ["packages/ui-react/tests/browser/diagrams-callouts.layout.tsx","packages/module-diagrams/tests/fixtures/callouts.ts","packages/module-diagrams/src/callout-path.ts","packages/module-diagrams/src/callouts.ts","packages/module-diagrams/src/legend.ts"])expect(input.runtime,"REVIEWED_CALLOUT_PRODUCER_INCLUDED").toContain(file);expect(input.runtime).toContain("packages/ui-react/tests/browser/diagrams-positional.layout.tsx");expect(input.runtime).toContain("packages/ui-react/tests/browser/diagrams-node-link.layout.tsx");expect(input.runtime).toContain("packages/module-diagrams/src/svg-model.ts");expect(input.runtime).toContain(guard);expect(input.bytes).toContain("packages/module-diagrams/tests/fixtures/adopted-homecoming-relay.diagram.yaml");
});
test("changing the reviewed HTML sink to an unchecked argument refuses diagram binding",()=>{
 const {root,write}=fixture(diagramFiles),selected=[...files,...diagramFiles];
 expect(boundBrowserDocuments(root,selected,browserImporters(root,selected)).has(diagram),"CONTROL_REVIEWED_DOCUMENT_BINDS").toBe(true);
 const source=readFileSync(join(root,diagram),"utf8");
 const changed=source.replace("${drawing.html}","${externalHtml}");
 expect(changed).not.toBe(source);
 write(diagram,changed);
 expect(boundBrowserDocuments(root,selected,browserImporters(root,selected)).has(diagram),"UNCHECKED_HTML_SINK_REFUSED").toBe(false);
});
test("diagram caller, renderer, fixture, guard and font drift or extra caller refuse document binding",()=>{
 for(const file of [diagram,diagramCaller,"packages/ui-react/tests/browser/diagrams-axis.layout.tsx","packages/ui-react/tests/browser/diagrams-positional.layout.tsx","packages/ui-react/tests/browser/diagrams-node-link.layout.tsx","packages/module-diagrams/skills/diagram/references/examples/architecture.diagram.yaml","packages/module-diagrams/src/svg-model.ts","packages/module-diagrams/tests/fixtures/adopted-homecoming-relay.diagram.yaml",guard,"scripts/captures/fonts.css"]){const {root,write}=fixture(diagramFiles),selected=[...files,...diagramFiles];write(file,readFileSync(join(root,file),"utf8")+"\n/* drift */\n");expect(boundBrowserDocuments(root,selected,browserImporters(root,selected)).has(diagram)).toBe(false);}
 const {root,write}=fixture(diagramFiles);write("extra.ts",'import {commands as api} from "vitest/browser"; api.diagramCapture("figure","new");');const selected=[...files,...diagramFiles,"extra.ts"];expect(boundBrowserDocuments(root,selected,browserImporters(root,selected)).has(diagram)).toBe(false);
});

const exportOwner="packages/ui-react/tests/browser/diagram-export-command.ts",exportCaller="packages/ui-react/tests/browser/diagrams-export.layout.tsx";
const exportFiles=[...diagramFiles,exportOwner,exportCaller,...[2,4,6,7].map(face=>`packages/module-diagrams/assets/fonts/${face}.ttf`)];
function exportFixture(){const {root,write}=fixture();for(const file of exportFiles){mkdirSync(dirname(join(root,file)),{recursive:true});writeFileSync(join(root,file),readFileSync(join(repo,file)));}return{root,write};}
test("export raster replay binds actual flattening, SVG inputs and four bundled font blobs",()=>{
 const {root}=exportFixture(),selected=[...files,...exportFiles],bound=boundBrowserDocuments(root,selected,browserImporters(root,selected));
 expect(bound.has(exportOwner),"REVIEWED_RASTER_DOCUMENT_BINDS").toBe(true);
 const input=[...bound.get(exportOwner)!.values()][0]!;expect(input.runtime).toContain(exportCaller);expect(input.runtime).toContain("packages/module-diagrams/src/flatten.ts");for(const face of [2,4,6,7])expect(input.bytes).toContain(`packages/module-diagrams/assets/fonts/${face}.ttf`);
});
test("raster argument producer, font bytes and additional or escaped command callers fail fresh",()=>{
 for(const file of [exportOwner,exportCaller,"packages/module-diagrams/src/flatten.ts","packages/module-diagrams/assets/fonts/2.ttf"]){const {root}=exportFixture();writeFileSync(join(root,file),Buffer.concat([readFileSync(join(root,file)),Buffer.from("drift")]));const selected=[...files,...exportFiles];expect(boundBrowserDocuments(root,selected,browserImporters(root,selected)).has(exportOwner)).toBe(false);}
 for(const extra of ['import {commands as api} from "vitest/browser"; api.diagramRasterComparison("new",external,external);','import {commands} from "vitest/browser"; const invoke=commands.diagramRasterComparison;']){const {root,write}=exportFixture();write("extra.ts",extra);const selected=[...files,...exportFiles,"extra.ts"];expect(boundBrowserDocuments(root,selected,browserImporters(root,selected)).has(exportOwner)).toBe(false);}
});

test("callout caller, source math and literal fixture drift refuse replay binding",()=>{
 for(const file of ["packages/ui-react/tests/browser/diagrams-callouts.layout.tsx","packages/module-diagrams/src/callout-path.ts","packages/module-diagrams/src/callouts.ts","packages/module-diagrams/src/legend.ts","packages/module-diagrams/tests/fixtures/callouts.ts"]){
  const {root,write}=fixture(diagramFiles),selected=[...files,...diagramFiles];
  expect(boundBrowserDocuments(root,selected,browserImporters(root,selected)).has(diagram),"CONTROL_REVIEWED_CALLOUT_DOCUMENT_BINDS").toBe(true);
  write(file,readFileSync(join(root,file),"utf8")+"\n/* callout source drift */\n");
  expect(boundBrowserDocuments(root,selected,browserImporters(root,selected)).has(diagram),"CHANGED_CALLOUT_SOURCE_REFUSED").toBe(false);
 }
});

test("a stale reviewed producer pin or an unreviewed caller refuses binding and names the file",()=>{
  const producer="packages/module-diagrams/src/callouts.ts";
  {const {root,write}=fixture(diagramFiles),selected=[...files,...diagramFiles];write(producer,readFileSync(join(root,producer),"utf8")+"\n// drift\n");
   expect(browserDocumentRefusals(root,selected,browserImporters(root,selected)).get(diagram),"STALE_PIN_NAMED").toBe(`stale reviewed pin: ${producer}`);}
  {const {root,write}=fixture(diagramFiles),extra="packages/ui-react/tests/browser/diagrams-unreviewed.layout.tsx";
   write(extra,'import {commands} from "vitest/browser"; await commands.diagramCapture("[data-content-renderer=\\"diagram\\"]","odysseus");');
   const selected=[...files,...diagramFiles,extra];
   expect(browserDocumentRefusals(root,selected,browserImporters(root,selected)).get(diagram),"UNREVIEWED_CALLER_NAMED").toBe(`unreviewed caller: ${extra}`);}
});

/** Static relative imports, resolved the way the build resolves sibling sources. */
function sourceClosure(starts:readonly string[]):Set<string>{
  const seen=new Set<string>(),queue=[...starts];
  while(queue.length){
    const file=queue.pop()!;if(seen.has(file)||!/\.[cm]?[jt]sx?$/.test(file))continue;seen.add(file);
    const source=ts.createSourceFile(file,readFileSync(join(repo,file),"utf8"),ts.ScriptTarget.Latest,true);
    const visit=(node:ts.Node)=>{
      const spec=(ts.isImportDeclaration(node)||ts.isExportDeclaration(node))&&node.moduleSpecifier&&ts.isStringLiteral(node.moduleSpecifier)?node.moduleSpecifier.text:undefined;
      if(spec?.startsWith(".")){const base=join(dirname(file),spec);const target=[base,base.replace(/\.js$/,".ts"),base.replace(/\.js$/,".tsx"),`${base}.ts`,`${base}.tsx`].find(path=>{try{return readFileSync(join(repo,path))&&true;}catch{return false;}});if(target)queue.push(target);}
      ts.forEachChild(node,visit);
    };visit(source);
  }
  return seen;
}
test("every module-diagrams source a reviewed binding imports is pinned among its producers",()=>{
  const reviewed=reviewedBrowserDocuments.filter(entry=>Object.keys(entry.producers).some(file=>file.startsWith("packages/module-diagrams/src/")));
  expect(reviewed.length,"DIAGRAM_BINDINGS_PRESENT").toBeGreaterThan(0);
  for(const entry of reviewed){
    const pinned=new Set(Object.keys(entry.producers));
    const unpinned=[...sourceClosure([entry.caller,...Object.keys(entry.additionalCallers??{}),...pinned].filter(file=>/\.[cm]?[jt]sx?$/.test(file)))].filter(file=>file.startsWith("packages/module-diagrams/src/")&&!pinned.has(file)).sort();
    expect(unpinned,`UNPINNED_PRODUCER_IMPORTS ${entry.command}`).toEqual([]);
  }
});

// Each guard has a passing control before mutation; a stale earlier producer
// must not make a later refusal look effective.
test("origin-scene caller and each changed producer retain exact drift refusal",()=>{
 for(const file of [sceneCaller,sceneFixture,...["callouts.ts","geometry.ts","layout.ts","svg-model.ts","ui.tsx","render.ts","flatten.ts"].map(name=>`packages/module-diagrams/src/${name}`)]){
  const {root,write}=fixture(diagramFiles),selected=[...files,...diagramFiles];
  expect(boundBrowserDocuments(root,selected,browserImporters(root,selected)).has(diagram),"CONTROL_SCENE_DOCUMENT_BINDS").toBe(true);
  write(file,readFileSync(join(root,file),"utf8")+"\n// scene source drift\n");
  expect(browserDocumentRefusals(root,selected,browserImporters(root,selected)).get(diagram),"SCENE_DRIFT_NAMED").toBe(`stale reviewed pin: ${file}`);
 }
});
test("a missing origin caller, direct owner import or unknown aliased caller refuses scene binding",()=>{
 {const {root}=fixture(diagramFiles),selected=[...files,...diagramFiles].filter(file=>file!==sceneCaller);
  expect(browserDocumentRefusals(root,selected,browserImporters(root,selected)).get(diagram),"MISSING_SCENE_CALLER_NAMED").toBe(`not selected: ${sceneCaller}`);}
 for(const source of [`import {diagramCapture} from "./${diagram}";`,
  'import {commands as api} from "vitest/browser"; await api.diagramCapture("figure","origin");',
  'const {commands:api}=await import("vitest/browser"); await api.diagramCapture("figure","origin");']){
  const {root,write}=fixture(diagramFiles),extra="extra.ts",selected=[...files,...diagramFiles,extra];
  expect(boundBrowserDocuments(root,[...files,...diagramFiles],browserImporters(root,[...files,...diagramFiles])).has(diagram),"CONTROL_SCENE_IMPORTERS_BINDS").toBe(true);
  write(extra,source);
  expect(boundBrowserDocuments(root,selected,browserImporters(root,selected)).has(diagram),"UNKNOWN_SCENE_IMPORTER_REFUSED").toBe(false);
 }
});
