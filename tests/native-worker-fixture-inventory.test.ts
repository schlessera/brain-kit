/** Composition checks only; positive installed-runtime proof stays in hosted CI. */
import { expect, test } from "bun:test";
import ts from "typescript";
import { readFileSync } from "node:fs";
import { join } from "node:path";
const root=join(import.meta.dir,"..");
const read=(file:string)=>readFileSync(join(root,file),"utf8");
for(const file of ["packages/ui-backend-claude/tests/follow-up-delivery.test.ts","packages/ui-backend-claude/tests/subscription-billing.test.ts","packages/ui-server/tests/bundled-claude.test.ts"])test(`read-only native fixture declares an ephemeral sandbox: ${file}`,()=>{
 const source=ts.createSourceFile(file,read(file),ts.ScriptTarget.Latest,true);let calls=0;
 function visit(node:ts.Node){
  if(ts.isCallExpression(node)&&ts.isPropertyAccessExpression(node.expression)&&node.expression.name.text==="startTurn"){
   const request=node.arguments[0];expect(request&&ts.isObjectLiteralExpression(request),"literal native request").toBe(true);
   if(request&&ts.isObjectLiteralExpression(request)){
    const sandbox=request.properties.find(prop=>ts.isPropertyAssignment(prop)&&prop.name.getText(source)==="workerSandbox") as ts.PropertyAssignment|undefined;
    expect(sandbox,"explicit native sandbox").toBeDefined();expect(sandbox?.initializer.getText(source)).toContain("areas: []");calls++;
   }
  }
  ts.forEachChild(node,visit);
 }visit(source);expect(calls).toBeGreaterThan(0);expect(read(file)).toContain("nativeFixtureDirectory");
});
for(const name of ["provider-history-probe","provider-history-attachment-probe","provider-history-apify-probe","transcript-prefix-probe","stable-roster-probe","shell-startup-probe","session-prompt-probe","autonomous-prompt-probe","interactive-git-prompt-probe"])test(`copied native fixture declares its input root: ${name}`,()=>{
 const file=`packages/ui-backend-claude/tests/fixtures/${name}.ts`,source=ts.createSourceFile(file,read(file),ts.ScriptTarget.Latest,true);let declared=0;
 function visit(node:ts.Node){if(ts.isCallExpression(node)&&node.expression.getText(source)==="nativeScriptedService"){
  expect(node.arguments[1]?.getText(source),"fixture root declaration").toContain("fixtureRoots");declared++;
 }ts.forEachChild(node,visit);}visit(source);expect(declared).toBeGreaterThan(0);
});
for(const name of ["autonomous-dispatch","autonomous-app","autonomous-runtime","autonomous-containment","claude-worker","policy-boundary"])test(`app native fixture declares its whole private temporary tree: ${name}`,()=>{
 const source=read(`tests/fixtures/${name}-probe.ts`);
 expect(source).toContain("fixtureRoots: [root]");
});
