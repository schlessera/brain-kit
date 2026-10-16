/** Exact reader/default/verified-data bindings under a complete runner inventory. */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import ts from "typescript";
const declarations = [
  {
    "owner": "scripts/browser-shards.ts",
    "caller": "scripts/browser-sequencer.ts",
    "ownerHash": "67c10cd1f90174c2c8b20440a1998b0f321bf0f4a7a87bd84787fafa4042f78f",
    "callerHash": "480ae6e0f74bff30f5cfc96809b97361b769a58fa3586b99f9562c74f6c782dd",
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
  }
];
const options:ts.CompilerOptions={moduleResolution:ts.ModuleResolutionKind.Bundler,module:ts.ModuleKind.ESNext,customConditions:["bun"],allowImportingTsExtensions:true};
export type BrowserRuntimeBindings=Map<string,Map<string,string[]>>;
/** Only complete activation-audited source inventories may call this helper.
 * Exact caller bodies establish the cost-file default and lock-verified font
 * root/cache flow. Any new import/loader edge to either reader invalidates it.
 * Targets are bytes consumed by those readers, not executed source or CSS.
 */
export function boundBrowserRuntimeInputs(root:string,files:readonly string[]):BrowserRuntimeBindings {
  const result:BrowserRuntimeBindings=new Map();
  for(const declaration of declarations){
    if(!files.includes(declaration.owner)||!files.includes(declaration.caller))continue;
    const matches=(file:string,expected:string)=>{const path=resolve(root,file);return existsSync(path)&&realpathSync(path)===path&&createHash("sha256").update(readFileSync(path)).digest("hex")===expected;};
    if(!matches(declaration.owner,declaration.ownerHash)||!matches(declaration.caller,declaration.callerHash))continue;
    if(declaration.data && Object.entries(declaration.data).some(([file,digest])=>!matches(file,digest)))continue;
    let sealed=true;
    for(const file of files){
      if(!/\.[cm]?[jt]sx?$/.test(file))continue;
      const source=ts.createSourceFile(file,readFileSync(join(root,file),"utf8"),ts.ScriptTarget.Latest,true);
      const edge=(specifier:string)=>{
        const target=ts.resolveModuleName(specifier,join(root,file),options,ts.sys).resolvedModule?.resolvedFileName;
        if(target&&relative(root,target).replaceAll("\\","/")===declaration.owner&&file!==declaration.caller)sealed=false;
      };
      const walk=(node:ts.Node)=>{
        if((ts.isImportDeclaration(node)||ts.isExportDeclaration(node))&&node.moduleSpecifier&&ts.isStringLiteral(node.moduleSpecifier)&&
            !(ts.isImportDeclaration(node)?node.importClause?.isTypeOnly:node.isTypeOnly))edge(node.moduleSpecifier.text);
        if(ts.isCallExpression(node)&&node.arguments.length===1&&ts.isStringLiteralLike(node.arguments[0]!)&&
            (node.expression.kind===ts.SyntaxKind.ImportKeyword||node.expression.getText(source)==="require"))edge(node.arguments[0]!.text);
        ts.forEachChild(node,walk);
      };walk(source);
    }
    if(sealed)result.set(declaration.owner,new Map(Object.entries(declaration.sites)));
  }
  return result;
}
