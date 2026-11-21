/** Syntax-only native watchdog inventory; never evaluates a launcher. */
import ts from "typescript";
import { readFileSync } from "node:fs";
import { join,basename } from "node:path";
import { fixtureSources,nativeSdkLauncher,namespaceLaunches } from "./native-launcher-inventory";
export function nativeDeadlineSources(root:string):Map<string,ts.SourceFile> {
 const result=new Map<string,ts.SourceFile>(),known=fixtureSources(root),files=new Set<string>();
 for(const pattern of ["packages/*/tests/**/*.ts","scripts/**/*.ts","tests/**/*.ts","experiments/**/*.ts"])for(const file of new Bun.Glob(pattern).scanSync({cwd:root}))files.add(file);
 for(const file of [...files].sort()){
  const source=known.get(file)??ts.createSourceFile(file,readFileSync(join(root,file),"utf8"),ts.ScriptTarget.Latest,true);
  let direct=false;
  function imports(node:ts.Node){if(ts.isImportDeclaration(node)&&!node.importClause?.isTypeOnly){const names=node.importClause?.namedBindings;if(names&&ts.isNamedImports(names))for(const item of names.elements)if(!item.isTypeOnly&&/^(?:nativeScriptedService|nativeScriptedQuery|bundledClaudeBinary|nativeGuardEnvironment|nativeNamespacePolicy|launchAgentWorker|launchAgentWorkerAsync|workerBootstrap)$/.test((item.propertyName??item.name).text))direct=true;}ts.forEachChild(node,imports);}imports(source);
  // Disposable native/identity entrypoints also launch through argv delegates.
  const delegated=file.includes("/fixtures/")&&/(?:native|identity)/.test(basename(file));
  if(nativeSdkLauncher(source)||namespaceLaunches(source).length||direct||delegated||file.startsWith("scripts/native-proof/"))result.set(file,source);
 }
 return result;
}
export interface NativeDeadline {file:string;line:number;kind:"registrar"|"timer"|"abort"|"spawn"|"poll";expression:ts.Expression;source:ts.SourceFile;productReason?:string}
export function nativeDeadlines(file:string,source:ts.SourceFile):NativeDeadline[]{
 const timerNames=new Set(["setTimeout"]);
 const result:NativeDeadline[]=[],registrars=new Set(["test","it","beforeAll","afterAll","beforeEach","afterEach","setDefaultTimeout"]);
 function emit(kind:NativeDeadline["kind"],expression:ts.Expression){
  const comments=source.text.slice(expression.getFullStart(),expression.getStart(source));
  const reason=/\/\*\s*native-product-timing:\s*([^*]+)\*\//.exec(comments)?.[1]?.trim();
  result.push({file,line:source.getLineAndCharacterOfPosition(expression.getStart(source)).line+1,kind,expression,source,...(reason?{productReason:reason}:{})});
 }
 function visit(node:ts.Node):void{
  if(ts.isImportDeclaration(node)&&node.moduleSpecifier.getText(source).includes("bun:test")){const names=node.importClause?.namedBindings;if(names&&ts.isNamedImports(names))for(const item of names.elements)if(registrars.has((item.propertyName??item.name).text))registrars.add(item.name.text);}
  if(ts.isImportDeclaration(node)&&ts.isStringLiteral(node.moduleSpecifier)&&["node:timers","timers"].includes(node.moduleSpecifier.text)){const names=node.importClause?.namedBindings;if(names&&ts.isNamedImports(names))for(const item of names.elements)if((item.propertyName??item.name).text==="setTimeout")timerNames.add(item.name.text);}
  if(ts.isCallExpression(node)){
   const name=node.expression.getText(source),root=name.split(/[.(]/)[0]!,outer=registrars.has(root);
   if((/(?:^|\.)setTimeout$/.test(name)||timerNames.has(name))&&node.arguments[1])emit("timer",node.arguments[1]);
   else if(/(?:^|\.)AbortSignal\.timeout$/.test(name)&&node.arguments[0])emit("abort",node.arguments[0]);
   else if(outer){const last=node.arguments.at(-1);if(last&&ts.isExpression(last)&&!ts.isArrowFunction(last)&&!ts.isFunctionExpression(last)&&!ts.isObjectLiteralExpression(last)&&(node.arguments.length>1||root==="setDefaultTimeout"))emit("registrar",last);}
  }
  if(ts.isBinaryExpression(node)&&node.operatorToken.kind===ts.SyntaxKind.PlusToken&&/^(?:Date|performance)\.now\(\)$/.test(node.left.getText(source))){
   const parent=node.parent;
   if(ts.isVariableDeclaration(parent)&&/(?:deadline|until|end)/i.test(parent.name.getText(source))||ts.isCallExpression(parent)&&/(?:readLine|ready|readySteps|childPid|verifyWorkerFolderMounts)/.test(parent.expression.getText(source)))emit("poll",node.right);
  }
  if(ts.isPropertyAssignment(node)&&["timeout","timeoutMs"].includes(ts.isIdentifier(node.name)||ts.isStringLiteral(node.name)?node.name.text:ts.isComputedPropertyName(node.name)&&ts.isStringLiteral(node.name.expression)?node.name.expression.text:node.name.getText(source))&&![ts.SyntaxKind.TrueKeyword,ts.SyntaxKind.FalseKeyword,ts.SyntaxKind.NullKeyword].includes(node.initializer.kind)){
   let parent:ts.Node=node.parent;while(parent&&!ts.isCallExpression(parent)&&!ts.isStatement(parent))parent=parent.parent;
   if(parent&&ts.isCallExpression(parent)){
    const name=parent.expression.getText(source),root=name.split(/[.(]/)[0]!;
    if(registrars.has(root))emit("registrar",node.initializer);
    else if(/(?:^|\.)(?:spawn|spawnSync|run|runStreaming)$/.test(name))emit("spawn",node.initializer);
    else if(/(?:^|\.)poll$/.test(name))emit("poll",node.initializer);
    else emit("spawn",node.initializer);
   }else emit("spawn",node.initializer);
  }
  ts.forEachChild(node,visit);
 }visit(source);return result;
}
export function deadlineValue(node:ts.Expression,source:ts.SourceFile,seen=new Set<string>()):number|undefined {
 if(ts.isNumericLiteral(node))return Number(node.text);
 if(ts.isParenthesizedExpression(node))return deadlineValue(node.expression,source,seen);
 if(ts.isIdentifier(node)&&!seen.has(node.text)){
  const name=node.text;
  const values:ts.Expression[]=[];function visit(n:ts.Node){if((ts.isVariableDeclaration(n)||ts.isParameter(n))&&ts.isIdentifier(n.name)&&n.name.text===name&&n.initializer)values.push(n.initializer);ts.forEachChild(n,visit);}visit(source);
  if(values.length===1){const next=new Set(seen);next.add(node.text);return deadlineValue(values[0]!,source,next);}
 }
 return;
}
export function unscaledNativeDeadlines(file:string,source:ts.SourceFile,threshold=100):NativeDeadline[]{
 return nativeDeadlines(file,source).filter(item=>{
  if(item.kind==="registrar"||item.productReason)return false;
  if(ts.isCallExpression(item.expression)&&item.expression.expression.getText(source)==="watchdogMs")return false;
  const value=deadlineValue(item.expression,source);return value===undefined||value>threshold;
 });
}
