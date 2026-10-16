/** Exact fixture producers and every selected BrowserCommands invocation. */
import {createHash} from "node:crypto";
import {existsSync,readFileSync,realpathSync} from "node:fs";
import {resolve} from "node:path";
import ts from "typescript";
import type {BrowserImporters} from "./bound-browser-runtime-inputs";
const config="packages/ui-kit/vitest.config.ts";
interface DocumentDeclaration { command:string;owner:string;ownerHash:string;caller:string;callerHash:string;calls:number;additionalCallers?:Record<string,{hash:string;calls:number}>;sink:string;producers:Record<string,string>; }
const declarations:DocumentDeclaration[]=[{
  command:"htmlPreviewFixture",owner:"packages/ui-kit/tests/visual/form-browser.ts",ownerHash:"3ccf67a71fa64af195bbf8cf6d173064dc9d2d4fc6abc699fa0a638c352ca62e",
  caller:"packages/ui-react/tests/browser/destination-press.pointer.tsx",callerHash:"85e9a20f9a15dd38a6479e3dd668e45f6f8324c2e6a97a252172392c1bfb857e",calls:2,
  sink:'route.fulfill(requested === path\n      ? { status: 200, contentType: "text/html", body: html }\n      : { status: 404, contentType: "text/plain", body: "Unknown fixture file" })',
  producers:{} as Record<string,string>
},{
  command:"ghostTrace",owner:"packages/ui-kit/tests/visual/ghost-browser.ts",ownerHash:"004c45bd7261997efccc74623ee2f67db4fc832b99039bc2f49cea81e75fb799",
  caller:"packages/ui-kit/tests/visual/ghost-sweep.visual.tsx",callerHash:"77ecc3626f82ae9687f17fdc9846353ed9bd3057a802ac3e8acd89b72d17039e",calls:1,
  sink:'page.setContent(`<html data-theme="${fixture.theme}"><head><base href="${fixture.base}"><style>${fixture.css}</style><style>body{margin:0;padding:16px;box-sizing:border-box;background:var(--bk-color-canvas)}</style></head><body>${fixture.html}</body></html>`)',
  producers:{
    "packages/ui-kit/stories/states/GhostSweep.stories.tsx":"25da76fdba02282bb4ff656da68f27dd1b134d1ed938ceff353ae4c88e0f30b7",
    "packages/ui-kit/.storybook/preview.ts":"bff3b384ba6fd35c4ac6381e2fc125cbeefeda32a58ec3eeef288a19238de0a1",
    "packages/ui-kit/.storybook/preview.css":"d98834fb114fc7aa26cf2b79bcbaf363943fdd99b1535748f14f1dd861a0d4ec",
    "packages/ui-kit/tests/visual/zero-request-replay.ts":"694080b66abfd6235d1873e63c908f4284b8804e5f3ff2ac98ca89169c59290e",
    "packages/ui-kit/tests/visual/design-font-setup.ts":"ef812cb97c62da898dc0050cdfc09762163dfdb2cac1e3b813d586fd0fa95fb2",
    "packages/ui-kit/tests/visual/design-font-checks.ts":"c534a18213734a16731e9ff70aedf267c2fdde6867a17b068b0292040e00634f",
    "packages/ui-kit/tests/visual/rank-footer-browser.ts":"7c4a2b0e4b5d3f40f2cc84af86f852c36068791fcb1dc6f8989f2863d51733a0",
    "scripts/captures/fonts.ts":"a0d96b46f110e929e34cdc592927c4a23dedde9f672e059bfae7bba10e8349cd",
    "scripts/captures/font-lock.json":"3ec58a552059527131bda0277703425243a63aa311d58b67201a7b2c9fe136ad",
    "scripts/captures/fonts.css":"1a6035cc96ef6b928378a04b1f81c13b52362f18fa00e087f4a5f15155482a4d",
    "packages/ui-kit/.storybook/preview-head.html":"66da7597557f1418096239edcd74f7a8decfc70dfc8f1d820de0cf365df41ed7"
  }
},{
  "command": "diagramCapture",
  "owner": "packages/ui-react/tests/browser/diagram-proof-command.ts",
  "ownerHash": "5bb6584e6341323a5e8570a6cb3709416cddbf655187cbe4d9128fdac79af4a5",
  "caller": "packages/ui-react/tests/browser/diagrams-renderer.layout.tsx",
  "callerHash": "6546f81e60768d3741bbbee71229fdbf1ac609b5a1e90de54074a35fe550ffb3",
  "calls": 2,
  "additionalCallers": {"packages/ui-react/tests/browser/diagrams-axis.layout.tsx": {"hash": "6512cb4660834ef7b15a52258d51f694c4e34fd530754bdc51580137db22b75c", "calls": 3}},
  "sink": "page.setContent(`<html data-theme=\"${drawing.theme}\"><head><style>${drawing.styles}</style><style>body{margin:0}</style></head><body>${drawing.html}</body></html>`)",
  "producers": {
    "packages/ui-kit/tests/visual/zero-request-replay.ts": "694080b66abfd6235d1873e63c908f4284b8804e5f3ff2ac98ca89169c59290e",
    "packages/ui-kit/tests/visual/form-browser.ts": "3ccf67a71fa64af195bbf8cf6d173064dc9d2d4fc6abc699fa0a638c352ca62e",
    "packages/ui-kit/tests/visual/design-font-setup.ts": "ef812cb97c62da898dc0050cdfc09762163dfdb2cac1e3b813d586fd0fa95fb2",
    "packages/ui-kit/tests/visual/design-font-checks.ts": "c534a18213734a16731e9ff70aedf267c2fdde6867a17b068b0292040e00634f",
    "packages/ui-kit/tests/visual/rank-footer-browser.ts": "7c4a2b0e4b5d3f40f2cc84af86f852c36068791fcb1dc6f8989f2863d51733a0",
    "scripts/captures/fonts.ts": "a0d96b46f110e929e34cdc592927c4a23dedde9f672e059bfae7bba10e8349cd",
    "scripts/captures/font-lock.json": "3ec58a552059527131bda0277703425243a63aa311d58b67201a7b2c9fe136ad",
    "scripts/captures/fonts.css": "1a6035cc96ef6b928378a04b1f81c13b52362f18fa00e087f4a5f15155482a4d",
    "packages/ui-kit/.storybook/preview-head.html": "66da7597557f1418096239edcd74f7a8decfc70dfc8f1d820de0cf365df41ed7",
    "packages/module-diagrams/tests/fixtures/renderer-fixture.ts": "dc0db9aba9cd425c0cb12bd0241c6d9b4d8edd4a1ed6270e391f9d0cae7018be",
    "packages/module-diagrams/tests/fixtures/adopted-homecoming-relay.diagram.yaml": "bc5d906627a8392da7921f8d74ff72eb7de4fb9cf03879fc6c83b1aaec0ee3a4",
    "packages/module-diagrams/src/axis-check.ts": "ba2133b3c42bcd72abcdb7200ba4fd4a05656aee0028b7894db7a22bcafbdbe9",
    "packages/module-diagrams/src/axis-layout.ts": "969b035e0cccb2bb63dabd403561efa41fc597af9b1537c29a3e9f60cd987bb9",
    "packages/module-diagrams/src/axis-spec.ts": "55bce9fad9e94af099a55fb1f7d282247c4b5f0dbdd9b33679e2903acfc28b93",
    "packages/module-diagrams/src/shape-svg.ts": "b629406bfec41e3ed9973a395a6271d69f1ce45d823591ab15b5581a0116a29b",
    "packages/module-diagrams/src/shape.ts": "126cb4f530ea60736764c1237cc33a944ef924d62d74ba404e9b97d9f1e2696e",
    "packages/module-diagrams/tests/fixtures/axis-examples.ts": "3925e82b8bc2ced444d8d6019fa13a93396315438e6e1c426fd338cc42685d2e",
    "packages/module-diagrams/src/skin.generated.ts": "3c78137114fdb7ac4d376bec30c871c57ebba64fe3872427807a8b4e77200996",
    "packages/module-diagrams/src/check.ts": "dd6e84f52864d2868e37cb8cca2026ea3c9787567fbcafe1a722897eb98accd9",
    "packages/module-diagrams/src/svg-model.ts": "3a394e6491161a6444d299572b9462f6cc43c11a3c6a0f405ac2358aa0079bef",
    "packages/module-diagrams/src/geometry.ts": "78a88cb14a00be81ce54bbdb88720da04ff75b6beca36a16e9810d8b05b47ca6",
    "packages/module-diagrams/src/drawing-style.ts": "9d9108f2e8fdf5c416d1deee3ecc8d4f4ad709956a15ffcdb0a1b3a07919cfe5",
    "packages/module-diagrams/src/ui.tsx": "99c60be85b9a5f21096c4535eaf7eb0bdcfc67b3ddf9b3f3520089f338f80040",
    "packages/module-diagrams/src/layout.ts": "0c3c6e84cdfccb4675ceda99f06604a69001f9efde4f9d742265cbd771d7f399",
    "packages/module-diagrams/src/skin.ts": "79b463167bbab59194e9a652da41013d552cf931bd3e9bd062a503926329c0f0",
    "packages/module-diagrams/src/render.ts": "677245cc5b3b7ec4757e5771aecbe80dbd9f1f5e2d53d23b5cac355b7c28c463",
    "packages/module-diagrams/src/spec.ts": "647500d978198622cc0b4b57d122b2100c87623cbd569ed77a971b56c7d71f0f"
  }
}];
export interface BrowserDocumentInputs {runtime:string[];bytes:string[];}
/** Requires a successful complete activation audit; aliases/loaders are checked
 * there. All producers/dependencies retain normal input traversal here.
 */
export function boundBrowserDocuments(root:string,files:readonly string[],importers:BrowserImporters):Map<string,Map<string,BrowserDocumentInputs>>{
  const result=new Map<string,Map<string,BrowserDocumentInputs>>();
  const matches=(file:string,hash:string)=>{const path=resolve(root,file);return existsSync(path)&&realpathSync(path)===path&&createHash("sha256").update(readFileSync(path)).digest("hex")===hash;};
  if(!matches(config,"81d969b3022e0dfa6d82c59ff2f16ea8de923d650958b6d7f932e85f409a23ce"))return result;
  for(const declaration of declarations){
    const callers=new Map<string,{hash:string;calls:number}>([[declaration.caller,{hash:declaration.callerHash,calls:declaration.calls}],...Object.entries(declaration.additionalCallers??{})]);
    if(![config,declaration.owner,...callers.keys()].every(file=>files.includes(file))||!matches(declaration.owner,declaration.ownerHash)||[...callers].some(([file,entry])=>!matches(file,entry.hash))||Object.entries(declaration.producers).some(([file,hash])=>!matches(file,hash))||[...(importers.get(declaration.owner)??[])].some(file=>file!==config))continue;
    const counts=new Map([...callers.keys()].map(file=>[file,0]));let unsafe=false;
    for(const file of files){
      if(!/\.[cm]?[jt]sx?$/.test(file))continue;
      const source=ts.createSourceFile(file,readFileSync(resolve(root,file),"utf8"),ts.ScriptTarget.Latest,true),names=new Set<string>();
      for(const statement of source.statements)if(ts.isImportDeclaration(statement)&&ts.isStringLiteral(statement.moduleSpecifier)&&statement.moduleSpecifier.text==="vitest/browser"){
        const bindings=statement.importClause?.namedBindings;
        if(bindings&&ts.isNamedImports(bindings))for(const binding of bindings.elements)if((binding.propertyName?.text??binding.name.text)==="commands")names.add(binding.name.text);
      }
      const bindings=(node:ts.Node)=>{
        if(ts.isVariableDeclaration(node)&&ts.isObjectBindingPattern(node.name)&&node.initializer&&ts.isAwaitExpression(node.initializer)&&ts.isCallExpression(node.initializer.expression)&&node.initializer.expression.expression.kind===ts.SyntaxKind.ImportKeyword){
          const literal=node.initializer.expression.arguments[0];
          if(literal&&ts.isStringLiteral(literal)&&literal.text==="vitest/browser")for(const binding of node.name.elements)if(ts.isIdentifier(binding.name)&&(binding.propertyName?.getText(source)??binding.name.text)==="commands")names.add(binding.name.text);
        }
        ts.forEachChild(node,bindings);
      };bindings(source);
      const walk=(node:ts.Node)=>{
        if(ts.isPropertyAccessExpression(node)&&ts.isIdentifier(node.expression)&&names.has(node.expression.text)&&node.name.text===declaration.command){
          if(!callers.has(file)||!ts.isCallExpression(node.parent)||node.parent.expression!==node)unsafe=true;else counts.set(file,counts.get(file)!+1);
        }
        ts.forEachChild(node,walk);
      };walk(source);
    }
    // Form: cleanup(null), literal paragraphs and a reporting/scroll script.
    // Ghost: argument-free call immediately after the exact Performance story;
    // all replay network attempts abort and fail before/after fonts and trace.
    const producers=Object.keys(declaration.producers);
    if(!unsafe&&[...callers].every(([file,entry])=>counts.get(file)===entry.calls))result.set(declaration.owner,new Map([[declaration.sink,{runtime:[...callers.keys(),...producers.filter(file=>/\.[cm]?[jt]sx?$/.test(file))],bytes:producers.filter(file=>!/\.[cm]?[jt]sx?$/.test(file))}]]));
  }
  return result;
}
