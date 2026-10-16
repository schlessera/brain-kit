/** Exact fixture producers and every selected BrowserCommands invocation. */
import {createHash} from "node:crypto";
import {existsSync,readFileSync,realpathSync} from "node:fs";
import {resolve} from "node:path";
import ts from "typescript";
import type {BrowserImporters} from "./bound-browser-runtime-inputs";
const config="packages/ui-kit/vitest.config.ts";
const declarations=[{
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
    "packages/ui-kit/tests/visual/design-font-setup.ts":"d5121235f061bf3088129e9fe43a4826980a2ca1173f43f033da223a3291283d",
    "packages/ui-kit/tests/visual/design-font-checks.ts":"34958b4a55a603d068fea561029c667d70fb18930ed37eda309d8def3fee27de",
    "packages/ui-kit/tests/visual/rank-footer-browser.ts":"7c4a2b0e4b5d3f40f2cc84af86f852c36068791fcb1dc6f8989f2863d51733a0",
    "scripts/captures/fonts.ts":"a0d96b46f110e929e34cdc592927c4a23dedde9f672e059bfae7bba10e8349cd",
    "scripts/captures/font-lock.json":"3ec58a552059527131bda0277703425243a63aa311d58b67201a7b2c9fe136ad",
    "scripts/captures/fonts.css":"1a6035cc96ef6b928378a04b1f81c13b52362f18fa00e087f4a5f15155482a4d",
    "packages/ui-kit/.storybook/preview-head.html":"66da7597557f1418096239edcd74f7a8decfc70dfc8f1d820de0cf365df41ed7"
  }
}];
export interface BrowserDocumentInputs {runtime:string[];bytes:string[];}
/** Requires a successful complete activation audit; aliases/loaders are checked
 * there. All producers/dependencies retain normal input traversal here.
 */
export function boundBrowserDocuments(root:string,files:readonly string[],importers:BrowserImporters):Map<string,Map<string,BrowserDocumentInputs>>{
  const result=new Map<string,Map<string,BrowserDocumentInputs>>();
  const matches=(file:string,hash:string)=>{const path=resolve(root,file);return existsSync(path)&&realpathSync(path)===path&&createHash("sha256").update(readFileSync(path)).digest("hex")===hash;};
  if(!matches(config,"9c92faea6e53921e05672750f7a8b5ef909b223712890078808d4b0dafe1788e"))return result;
  for(const declaration of declarations){
    if(![config,declaration.owner,declaration.caller].every(file=>files.includes(file))||!matches(declaration.owner,declaration.ownerHash)||!matches(declaration.caller,declaration.callerHash)||Object.entries(declaration.producers).some(([file,hash])=>!matches(file,hash))||[...(importers.get(declaration.owner)??[])].some(file=>file!==config))continue;
    let count=0,unsafe=false;
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
          if(file!==declaration.caller||!ts.isCallExpression(node.parent)||node.parent.expression!==node)unsafe=true;else count++;
        }
        ts.forEachChild(node,walk);
      };walk(source);
    }
    // Form: cleanup(null), literal paragraphs and a reporting/scroll script.
    // Ghost: argument-free call immediately after the exact Performance story;
    // all replay network attempts abort and fail before/after fonts and trace.
    const producers=Object.keys(declaration.producers);
    if(!unsafe&&count===declaration.calls)result.set(declaration.owner,new Map([[declaration.sink,{runtime:[declaration.caller,...producers.filter(file=>/\.[cm]?[jt]sx?$/.test(file))],bytes:producers.filter(file=>!/\.[cm]?[jt]sx?$/.test(file))}]]));
  }
  return result;
}
