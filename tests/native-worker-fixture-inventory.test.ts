/** Composition checks only; positive installed-runtime proof stays in hosted CI. */
import { expect, test } from "bun:test";
import ts from "typescript";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
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

// The enforcement entry re-enters the RTK view before constructing its worker;
// inspecting only tests/ and the shared worker helper misses its HOME/PATH roots.
test("enforcement RTK re-entry declares every temporary worker input",()=>{
 const file="scripts/measure-claude-enforcement.ts",text=read(file),source=ts.createSourceFile(file,text,ts.ScriptTarget.Latest,true);
 let created=0;
 function visit(node:ts.Node){
  if(ts.isCallExpression(node)&&node.expression.getText(source)==="nativeFixtureDirectory"){
   expect(node.arguments[0]?.getText(source)).toBe('"enforcement-probe-"');created++;
  }
  ts.forEachChild(node,visit);
 }visit(source);
 expect(created,"ENFORCEMENT_ROOT_REGISTERED").toBe(1);
 expect(text).not.toContain("mkdtempSync");
 expect(text).toContain("createMeasurementWorkerFixture(cwd, home)");
 expect(text.indexOf("await enterMeasurementRtkView()")).toBeLessThan(text.indexOf('nativeFixtureDirectory("enforcement-probe-")'));
 const rtk=read("scripts/measurement-rtk-fixture.ts");
 expect(rtk).toContain('process.argv.slice(1), "--native-rtk-view"');
 expect(rtk).toContain('"--bind", "/tmp", "/tmp"');
});

for(const [file,source] of fixtureSources(root))if(namespaceLaunches(source).length)test(`compiler-free native namespaces carry outer policy: ${file}`,()=>{
 const text=source.text;
 const namespaces=[...text.matchAll(/\.\.\.nativeNamespaceEnvironment\(\)/g)].length;
 expect(namespaces).toBeGreaterThan(0);
 expect([...text.matchAll(/const policy = nativeNamespacePolicy\(\)/g)].length,"OUTER_POLICY_PREPARED").toBe(namespaces);
 expect([...text.matchAll(/\.\.\.policy\.mounts/g)].length,"POLICY_READ_ONLY_MOUNT").toBe(namespaces);
 expect([...text.matchAll(/\.\.\.policy\.args/g)].length,"POLICY_DIGEST_ARGUMENT").toBe(namespaces);
 // Every policy bind follows the fixture masks, including /tmp and /etc.
 expect([...text.matchAll(/"--dev", "\/dev", \.\.\.policy\.mounts/g)].length,"POLICY_AFTER_MASKS").toBe(namespaces);
});

// The list comes from SDK imports/calls, dynamic SDK bindings and backend
// constructors, including scripts and experiments. A new source enters it
// without updating a filename list.
import {fixtureSources,nativeSdkLauncher,namespaceLaunches} from "./helpers/native-launcher-inventory";
const discoveredSources=fixtureSources(root);
for(const [file,source] of discoveredSources)if(nativeSdkLauncher(source))test(`discovered native launcher has explicit fixture provenance: ${file}`,()=>{
 const text=source.text;
 // Synthetic stream fixtures explicitly inject their SDK/worker seam.
 if(/mockWorkerHostForSdkStream\(\)|mock\.module|makeFakeBackend\(|installNativeHostFixtures\(/.test(text))return;
 // SDK protocol tests select a fixture executable instead of installed Claude.
 if(text.includes("pathToClaudeCodeExecutable")&&text.includes("writeFileSync"))return;
 if(text.includes('command: process.execPath, args: ["-e",'))return;
 // History-only API tests do not call query; their startTurn controls refuse
 // before a runtime is selected. Constructor discovery still inventories them.
 if(!/\bquery\s*\(/.test(text)&&/getSessionMessages|listSessions/.test(text))return;
 if(/createMeasurementWorkerFixture|createWorkerSpawn|createClaudeSdkTurn/.test(text)){
  expect(/nativeFixtureDirectory|fixtureRoots/.test(text),`NATIVE_WORKER_INPUT_PROVENANCE ${file}`).toBe(true);
 }else{
  expect(/nativeScriptedService|nativeScriptedQuery|measurement-entry-preload|scriptedModel\(|enterRealProviderMeasurement\(/.test(text)||text.includes("mock.module"),`NATIVE_SCRIPTED_AUTHORITY ${file}`).toBe(true);
 }

});

test("launcher discovery finds new aliased and dynamic SDK callers and default backends",()=>{
 for(const text of [
  'import {query as run} from "@anthropic-ai/claude-agent-sdk"; run({});',
  'const {query}=await import(entry) as typeof import("@anthropic-ai/claude-agent-sdk"); query({});',
  'const backend=createClaudeBackend({brainPath:root}); createApp({backend});',
  'const backend=createClaudeBackend({brainPath:root}); backend.startTurn({});',
  'import {query} from "@anthropic-ai/claude-agent-sdk"; createClaudeBackend({queryFn:query});',
  'import {query} from "@anthropic-ai/claude-agent-sdk"; function run(fn:typeof query=query){}',
  'import {prewarm} from "@anthropic-ai/claude-agent-sdk"; const warm=prewarm;',
  'const fake=createClaudeBackend({queryFn:fakeQuery}); const real=createClaudeBackend({brainPath:root});',
  'import {createClaudeBackend as make} from "../backend"; const backend=make({brainPath:root}); backend.startTurn({});',
  'import * as sdk from "@anthropic-ai/claude-agent-sdk"; sdk.query({});',
  'const sdk=await import("@anthropic-ai/claude-agent-sdk"); sdk["query"]({});',
 ])expect(nativeSdkLauncher(ts.createSourceFile("new-fixture.ts",text,ts.ScriptTarget.Latest,true))).toBe(true);
 for(const text of ['import type {query} from "@anthropic-ai/claude-agent-sdk";',
  'import {query} from "@anthropic-ai/claude-agent-sdk"; type Q=typeof query;',
  'const backend=createClaudeBackend({queryFn:fakeQuery});'])expect(nativeSdkLauncher(ts.createSourceFile("synthetic.ts",text,ts.ScriptTarget.Latest,true))).toBe(false);
});


test("inventory discovers a new launcher file without a filename registration",()=>{
 const scratch=mkdtempSync(join(tmpdir(),"odysseus-launcher-inventory-"));
 try{
  const file="packages/ship/tests/new-launcher.test.ts";
  mkdirSync(join(scratch,"packages/ship/tests"),{recursive:true});
  writeFileSync(join(scratch,file),'import {query as run} from "@anthropic-ai/claude-agent-sdk"; run({});');
  const sources=fixtureSources(scratch);
  expect([...sources.keys()],"NEW_LAUNCHER_DISCOVERED").toContain(file);
  expect(nativeSdkLauncher(sources.get(file)!)).toBe(true);
 }finally{rmSync(scratch,{recursive:true,force:true});}
});

test("hosted file-tool startup watchdog scales with repetition load",()=>{
 const source=read("packages/ui-backend-claude/tests/native-hosted-runtime.test.ts");
 expect(source).toContain("setTimeout(() => controller.abort(), watchdogMs(20_000))");
 expect(source).toContain("workerStarted:");expect(source).toContain("observeNativeWorkerStartup");
});
