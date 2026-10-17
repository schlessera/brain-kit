/** Finite private registries retain every handler's normal runtime input audit. */
import {createHash} from "node:crypto";
import {existsSync,readFileSync,realpathSync} from "node:fs";
import {resolve} from "node:path";
import ts from "typescript";
import type {BrowserImporters} from "./bound-browser-runtime-inputs";
// These two consumers import/re-export runStateForFrame only. They never
// acquire the mutable chat handler map. Any consumer edit requires re-audit.
const helperConsumers:Record<string,string>={
  "packages/ui-react/src/connection.ts":"30b0d883ffafc59fe94169ab2cc45ca2414da30dbf06702effe06f2807cd0b25",
  "packages/ui-react/src/hooks/use-websocket.ts":"ab5208f9edeccee5d30fd3c9c81962d1cba3339222bd3f86b7ea143e0596ffcc"
};
const declarations=[
  {
    "owner": "packages/ui-react/src/hooks/websocket-handlers/index.ts",
    "source": "21bf20fc8dad6e8a985f1d8686b559627b46824048f1021ad422c5c002f123b8",
    "registry": "serverMessageHandlers",
    "expression": "serverMessageHandlers[msg.type](msg as never, context)",
    "maps": [
      {
        "owner": "packages/ui-react/src/hooks/websocket-handlers/chat.ts",
        "name": "chatFrameHandlers",
        "source": "b0632f545a57a1a40bd3c7953bcbb4d424b267c7b53998adafc5e4d5b5ad294a"
      },
      {
        "owner": "packages/ui-react/src/hooks/websocket-handlers/activity.ts",
        "name": "activityFrameHandlers",
        "source": "401e15e6b6105dc9336ca45fa57eb6d235efba19178c3e1b6f6fcd0babca6ba5"
      },
      {
        "owner": "packages/ui-react/src/hooks/websocket-handlers/mask.ts",
        "name": "maskFrameHandlers",
        "source": "5cfccf2cf8b2fee994e57b44f3a4c6c789419fc2bf6015d79a344974b1485737"
      },
      {
        "owner": "packages/ui-react/src/hooks/websocket-handlers/provider.ts",
        "name": "providerFrameHandlers",
        "source": "0de9131781f27ba26a4469640e849170b9e063ed1d595a90361ac815128b617f"
      },
      {
        "owner": "packages/ui-react/src/hooks/websocket-handlers/connection.ts",
        "name": "connectionFrameHandlers",
        "source": "cddde70fb099b570cd6ef20a3bf310ae7edf61ce008d1165a48184bb109fd06c"
      },
      {
        "owner": "packages/ui-react/src/hooks/websocket-handlers/handoff.ts",
        "name": "handoffFrameHandlers",
        "source": "e1ff17fc6d995a81aa64e1150c560f977e1e4c6bfcfcd2a7798528e0cb96ada9"
      }
    ]
  },
  {
    "owner": "packages/ui-react/src/lib/stats/context-text.ts",
    "source": "76fb1634a81ed2a794def6e9de3f69961bc50a52ab68e5a6f907f0304395956c",
    "registry": "REQUIRED",
    "expression": "REQUIRED[kind as StatsSection[\"kind\"]](section as Record<string, unknown>)",
    "maps": []
  }
];
function definition(source:ts.SourceFile,name:string,privateOnly:boolean):ts.ObjectLiteralExpression|undefined {
  const variables=source.statements.filter(ts.isVariableStatement).filter(statement=>!privateOnly||!statement.modifiers?.some(modifier=>modifier.kind===ts.SyntaxKind.ExportKeyword)).flatMap(statement=>statement.declarationList.flags&ts.NodeFlags.Const?[...statement.declarationList.declarations]:[]).filter(declaration=>ts.isIdentifier(declaration.name)&&declaration.name.text===name);
  if(variables.length!==1)return;let value=variables[0]!.initializer;
  while(value&&(ts.isSatisfiesExpression(value)||ts.isAsExpression(value)||ts.isParenthesizedExpression(value)))value=value.expression;
  return value&&ts.isObjectLiteralExpression(value)?value:undefined;
}
export function sourceBrowserDispatch(root:string,files:readonly string[],importers:BrowserImporters):Map<string,Set<string>> {
  const result=new Map<string,Set<string>>();
  const source=(owner:string,expected:string)=>{const path=resolve(root,owner);if(!files.includes(owner)||!existsSync(path)||realpathSync(path)!==path)return;
    const bytes=readFileSync(path,"utf8");if(createHash("sha256").update(bytes).digest("hex")!==expected)return;return ts.createSourceFile(owner,bytes,ts.ScriptTarget.Latest,true);};
  for(const declaration of declarations){
    const owner=source(declaration.owner,declaration.source);if(!owner)continue;
    const registry=definition(owner,declaration.registry,true);if(!registry)continue;
    if(declaration.maps.length){
      if(registry.properties.length!==declaration.maps.length||registry.properties.some(property=>!ts.isSpreadAssignment(property)||!ts.isIdentifier(property.expression)||!declaration.maps.some(map=>map.name===property.expression.getText(owner))))continue;
      let valid=true;
      for(const map of declaration.maps){
        const ast=source(map.owner,map.source),value=ast&&definition(ast,map.name,false);
        const foreign=[...(importers.get(map.owner)??[])].filter(file=>file!==declaration.owner);
        if(!value||foreign.some(file=>map.name!=="chatFrameHandlers"||!helperConsumers[file]||!source(file,helperConsumers[file]!))||value.properties.some(property=>{
          if(ts.isSpreadAssignment(property)||ts.isComputedPropertyName(property.name))return true;
          if(ts.isMethodDeclaration(property))return !property.body;
          return !ts.isPropertyAssignment(property)||!(ts.isArrowFunction(property.initializer)||ts.isFunctionExpression(property.initializer));
        })) {valid=false;break;}
      }
      if(!valid)continue;
    }else if(registry.properties.some(property=>!ts.isPropertyAssignment(property)||ts.isComputedPropertyName(property.name)||!(ts.isArrowFunction(property.initializer)||ts.isFunctionExpression(property.initializer))))continue;
    let callSites=0,escaped=false;
    const walk=(node:ts.Node)=>{
      if(ts.isIdentifier(node)&&node.text===declaration.registry){
        const parent=node.parent;
        if(ts.isVariableDeclaration(parent)&&parent.name===node) { /* Private const definition. */ }
        else if(ts.isElementAccessExpression(parent)&&parent.expression===node&&ts.isCallExpression(parent.parent)&&parent.parent.expression===parent&&parent.parent.getText(owner)===declaration.expression)callSites++;
        else if(ts.isCallExpression(parent)&&parent.expression.getText(owner)==="Object.hasOwn"&&parent.arguments[0]===node) { /* Own-key guard, not an escaping callable. */ }
        else escaped=true;
      }
      ts.forEachChild(node,walk);
    };walk(owner);
    if(callSites===1&&!escaped)result.set(declaration.owner,new Set([declaration.expression]));
  }
  return result;
}
