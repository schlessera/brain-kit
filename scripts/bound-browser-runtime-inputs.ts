/** Exact reader/default/verified-data bindings under a complete runner inventory. */
import {resolveRuntimeModule} from "./runtime-module-resolution";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import ts from "typescript";
const declarations = [
  {
    "owner": "scripts/browser-shards.ts",
    "caller": "scripts/browser-sequencer.ts",
    "ownerHash": "958aeecec0f2552037163345a560116718b928fd334ddf9c61c398bc8f691071",
    "callerHash": "fd6a75b71fba29a169f0c84f488a1d1d9927e87c0612dc939122750368cbb77c",
    "sites": {
      "readFileSync(path, \"utf8\")": [
        "scripts/browser-shard-costs.json"
      ]
    }
  },
  {
    "owner": "scripts/captures/fonts.ts",
    "data": {
      "scripts/captures/font-lock.json": "3ec58a552059527131bda0277703425243a63aa311d58b67201a7b2c9fe136ad",
      "scripts/captures/fonts.css": "1a6035cc96ef6b928378a04b1f81c13b52362f18fa00e087f4a5f15155482a4d",
      "packages/ui-kit/.storybook/preview-head.html": "66da7597557f1418096239edcd74f7a8decfc70dfc8f1d820de0cf365df41ed7"
    },
    "caller": "packages/ui-kit/tests/visual/rank-footer-browser.ts",
    "ownerHash": "a0d96b46f110e929e34cdc592927c4a23dedde9f672e059bfae7bba10e8349cd",
    "callerHash": "7c4a2b0e4b5d3f40f2cc84af86f852c36068791fcb1dc6f8989f2863d51733a0",
    "sites": {
      "readFile(resolve(root, \"scripts/captures/font-lock.json\"))": [
        "scripts/captures/font-lock.json"
      ],
      "readFile(resolve(root, lock.stylesheet.file))": [
        "scripts/captures/fonts.css"
      ],
      "readFile(resolve(root, \"packages/ui-kit/.storybook/preview-head.html\"), \"utf8\")": [
        "packages/ui-kit/.storybook/preview-head.html"
      ],
      "readFile(resolve(cache, entry.file))": [
        "scripts/captures/font-lock.json"
      ]
    }
  },
{
  "owner": "packages/module-diagrams/src/fonts.ts",
  "caller": "packages/ui-react/tests/browser/diagram-export-command.ts",
  "ownerHash": "e575dbabbaa452f22389e61770b02200e78b965018f61662573f985024801419",
  "callerHash": "f7c3d14ccf96438bf4e28ecc1929b1208fb99520d21a9947086bb43bca933328",
  "data": {
    "packages/module-diagrams/assets/fonts/2.ttf": "44ce4a84f20d60f24539bd0cef11f79c29e38609e0f8adf18551c9794a5d9dc3",
    "packages/module-diagrams/assets/fonts/4.ttf": "df54dbfafba61d4911eb3dab9bba2d20531fb009f01d64dd42fa96ab862584d8",
    "packages/module-diagrams/assets/fonts/6.ttf": "b4fc14ec283d54236fd302cdb92546f98ae0ff061ca5ee23453a02bdf4628791",
    "packages/module-diagrams/assets/fonts/7.ttf": "50357df108c5d297ec4ece76aeddf49561f3794f67af077cfc2c711b7a75b439"
  },
  "sites": {
    "readFileSync(new URL(`../assets/fonts/${face.file}.ttf`,import.meta.url))": [
      "packages/module-diagrams/assets/fonts/2.ttf",
      "packages/module-diagrams/assets/fonts/4.ttf",
      "packages/module-diagrams/assets/fonts/6.ttf",
      "packages/module-diagrams/assets/fonts/7.ttf"
    ]
  }
}
];
const options:ts.CompilerOptions={moduleResolution:ts.ModuleResolutionKind.Bundler,module:ts.ModuleKind.ESNext,customConditions:["bun"],allowImportingTsExtensions:true};
export type BrowserRuntimeBindings=Map<string,Map<string,string[]>>;
/** Only complete activation-audited source inventories may call this helper.
 * Exact caller bodies establish the cost-file default and lock-verified font
 * root/cache flow. Any new import/loader edge to either reader invalidates it.
 * Targets are bytes consumed by those readers, not executed source or CSS.
 */
export type BrowserImporters=Map<string,Set<string>>;
export function browserImporters(root:string,files:readonly string[]):BrowserImporters {
  const result:BrowserImporters=new Map();
  for(const file of files){
    if(!/\.[cm]?[jt]sx?$/.test(file))continue;
    const source=ts.createSourceFile(file,readFileSync(join(root,file),"utf8"),ts.ScriptTarget.Latest,true);
    const edge=(specifier:string)=>{
      const target=resolveRuntimeModule(specifier,join(root,file),options)?.resolvedFileName;
      if(!target)return;const normalized=relative(root,target).replaceAll("\\","/");
      const sources=result.get(normalized)??new Set<string>();sources.add(file);result.set(normalized,sources);
    };
    const walk=(node:ts.Node)=>{
      if((ts.isImportDeclaration(node)||ts.isExportDeclaration(node))&&node.moduleSpecifier&&ts.isStringLiteral(node.moduleSpecifier)&&
          !(ts.isImportDeclaration(node)?node.importClause?.isTypeOnly:node.isTypeOnly))edge(node.moduleSpecifier.text);
      if(ts.isCallExpression(node)&&node.arguments.length===1&&ts.isStringLiteralLike(node.arguments[0]!)&&
          (node.expression.kind===ts.SyntaxKind.ImportKeyword||node.expression.getText(source)==="require"))edge(node.arguments[0]!.text);
      ts.forEachChild(node,walk);
    };walk(source);
  }
  return result;
}
export function boundBrowserRuntimeInputs(root:string,files:readonly string[],importers=browserImporters(root,files)):BrowserRuntimeBindings {
  const result:BrowserRuntimeBindings=new Map();
  for(const declaration of declarations){
    if(!files.includes(declaration.owner)||!files.includes(declaration.caller))continue;
    const matches=(file:string,expected:string)=>{const path=resolve(root,file);return existsSync(path)&&realpathSync(path)===path&&createHash("sha256").update(readFileSync(path)).digest("hex")===expected;};
    if(!matches(declaration.owner,declaration.ownerHash)||!matches(declaration.caller,declaration.callerHash))continue;
    if(declaration.data && Object.entries(declaration.data).some(([file,digest])=>!matches(file,digest)))continue;
    const sealed=[...(importers.get(declaration.owner)??[])].every(file=>file===declaration.caller);
    if(sealed)result.set(declaration.owner,new Map(Object.entries(declaration.sites)));
  }
  return result;
}
