/** Static native deadlines plus real, keyless verification of Bun's outer scaling. */
import { expect,test } from "bun:test";
import ts from "typescript";
import { mkdtempSync,readFileSync,writeFileSync,rmSync } from "node:fs";
import { join,relative } from "node:path";
import { nativeDeadlineSources,nativeDeadlines,unscaledNativeDeadlines } from "./helpers/native-timeout-inventory";
import { repetitionArgv } from "../scripts/test-determinism";
import { watchdogMs } from "../scripts/test-deadlines";
const root=join(import.meta.dir,"..");
test("native launch inventory contains no unscaled inner hang deadline",()=>{
 const sources=nativeDeadlineSources(root),failures:string[]=[];
 expect(sources.has("packages/ui-backend-claude/tests/native-restart-versions.test.ts")).toBe(true);
 expect(sources.has("packages/core/tests/claude-runner-subscription.test.ts")).toBe(true);
 expect(sources.has("packages/ui-backend-claude/tests/fixtures/prepared-consumer-native-root.ts")).toBe(true);
 for(const[file,source]of sources)for(const item of unscaledNativeDeadlines(file,source))failures.push(`${file}:${item.line}: ${item.expression.getText(source)}`);
 expect(failures,"NATIVE_INNER_WATCHDOGS_MUST_SCALE").toEqual([]);
});
test("new native literal timer, spawn, polling and aliased options cannot bypass inventory",()=>{
 const source=ts.createSourceFile("new-native.ts",`import {query} from "@anthropic-ai/claude-agent-sdk"; void query;
 import {setTimeout as schedule} from "node:timers";
 schedule(()=>abort.abort(),25000); globalThis.AbortSignal.timeout(6000);
 setTimeout(()=>abort.abort(),20000); AbortSignal.timeout(5000); const options={"timeout":30000}; Bun.spawn(["fixture"],options);
 expect.poll(()=>ready,{timeout:5000}); prewarm({initializeTimeoutMs:30000}); const deadline=Date.now()+5000;
 test("outer",()=>{},90000); test("outer options",{timeout:90000},()=>{});
 setTimeout(()=>{},watchdogMs(5000));
 setTimeout(()=>{},/* native-product-timing: Fixed measured application budget. */ 1000);
 const receipt={timeout:false};`,ts.ScriptTarget.Latest,true);
 expect(unscaledNativeDeadlines("new-native.ts",source).map(item=>item.expression.getText(source))).toEqual(["25000","6000","20000","5000","30000","5000","30000","5000"]);
 expect(nativeDeadlines("new-native.ts",source).filter(item=>item.kind==="registrar")).toHaveLength(2);
});
test("native repetitions actually load the outer registrar scaling preload",async()=>{
 const source=ts.createSourceFile("determinism.ts",readFileSync(join(root,"scripts/test-determinism.ts"),"utf8"),ts.ScriptTarget.Latest,true);
 const wiring:ts.CallExpression[]=[];function visit(node:ts.Node){if(ts.isCallExpression(node)&&node.expression.getText(source)==="repetitionArgv")wiring.push(node);ts.forEachChild(node,visit);}visit(source);
 expect(wiring,"NATIVE_REPETITION_WIRES_DEADLINE_PRELOAD").toHaveLength(1);
 expect(wiring[0]!.arguments[2]?.getText(source),"NATIVE_REPETITION_WIRES_DEADLINE_PRELOAD").toContain("preload: join(root, DEADLINE_PRELOAD)");
 const directory=mkdtempSync(join(root,"tmp/odysseus-native-deadline-"));
 try{
  const file=join(directory,"native-suite.test.ts");
  // No query executes: the reference makes this an SDK suite while the body is harmless.
  writeFileSync(file,'import {test,expect} from "bun:test";import {query} from "@anthropic-ai/claude-agent-sdk";void query;test("native suite outer timeout scales",async()=>{await Bun.sleep(60);expect(true).toBe(true);},10);');
  const argv=repetitionArgv([relative(root,file)],1,{capMs:600000,preload:join(root,"scripts/test-deadline-preload.ts")});
  argv[argv.findIndex(value=>value.startsWith("--reporter-outfile="))]=`--reporter-outfile=${join(directory,"junit.xml")}`;
  const child=Bun.spawn(argv,{cwd:root,env:{PATH:process.env.PATH,BRAIN_TEST_DEADLINE_FACTOR:"20",GITHUB_ACTIONS:"false",RUNNER_ENVIRONMENT:"local"},stdout:"pipe",stderr:"pipe",timeout:watchdogMs(15000)});
  const [code,out,err]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
  expect(code,"NATIVE_BUN_REGISTRARS_ARE_SCALED "+out+err).toBe(0);expect(out+err).toContain(" 0 fail");
 }finally{rmSync(directory,{recursive:true,force:true});}
},watchdogMs(20000));

test("native product timings and Bash budgets stay unscaled",()=>{
 const sources=nativeDeadlineSources(root);let products=0,health=0;
 for(const[file,source]of sources)for(const item of nativeDeadlines(file,source))if(item.productReason){
  products++;expect(item.expression.getText(source),"NATIVE_PRODUCT_TIMING_STAYS_FIXED").not.toContain("watchdogMs");
  if(file==="scripts/native-proof/hosted-app.test.ts"&&item.kind==="abort"){
   health++;expect(item.expression.getText(source),"ADMISSION_ONE_SECOND_BUDGET_UNCHANGED").toBe("1000");
  }
 }
 expect(products).toBeGreaterThan(0);expect(health).toBe(4);
});
