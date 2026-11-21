/** Synthetic compiler outcomes only: no installed native runtime executes. */
import { expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
const guard=join(import.meta.dir,"../scripts/test-native-guard.ts");
for(const kind of ["stderr","throw","artifact"] as const)test(`native policy ${kind} failure is bounded scrubbed and latched`,async()=>{
 const root=mkdtempSync(join(tmpdir(),"odysseus-policy-refusal-"));
 try{
  const script=join(root,"probe.ts"),secret="odysseus-compiler-private-secret";
  writeFileSync(script,`const original=Bun.spawnSync;
   Bun.spawnSync=((argv,options)=>argv[0]==="cc"?${kind==="throw"?'(()=>{throw Error("password='+secret+' /tmp/odysseus-private/cc1");})()':'({exitCode:1,stdout:Buffer.alloc(0),stderr:Buffer.from("cc1 missing\\npassword='+secret+'\\n"+"compiler note voyage\\n".repeat(1000)+"late")})'}:Reflect.apply(original,Bun,[argv,options]));
   ${kind==="artifact"?'process.argv.push("--native-rtk-view","--native-socket-policy-sha256="+"a".repeat(64));':''}
   const {compileSocketPolicy,nativeIsolationFailed}=await import(${JSON.stringify(guard+"?compiler-fixture")});
   try{compileSocketPolicy();}catch{}process.exit(nativeIsolationFailed()?1:0);`);
  const child=Bun.spawn([process.execPath,script],{env:{...process.env,TEST_COMPILER_SECRET:secret},stdout:"pipe",stderr:"pipe"});
  const [code,text]=await Promise.all([child.exited,new Response(child.stderr).text()]);expect(code).not.toBe(0);
  const receipt=JSON.parse(text.split("\n").find(line=>line.startsWith('{"kind":"native-offline-boundary"'))!);
  expect(receipt.nativeLaunched).toBe(false);expect(text).not.toContain(secret);expect(text).not.toContain("/tmp/odysseus-private");
  if(kind==="artifact")expect(receipt.reason).toBe("native socket policy artifact is unavailable or changed");
  else{expect(receipt.compilerStderr.length).toBeLessThanOrEqual(4096);expect(receipt.compilerStderr).toContain(kind==="throw"?"[redacted":"cc1 missing");}
 }finally{rmSync(root,{recursive:true,force:true});}
});

for(const mode of ["valid","changed","writable"] as const)test(`read-only RTK policy artifact ${mode} is verified without compiling`,async()=>{
 const root=mkdtempSync(join(tmpdir(),"odysseus-policy-artifact-"));
 try{
  const file=join(root,"policy"),script=join(root,"probe.ts");writeFileSync(file,"Odysseus synthetic policy bytes");
  writeFileSync(script,`import * as fs from "node:fs";import {createHash} from "node:crypto";import {mock} from "bun:test";
   const originalFs={...fs};const file=${JSON.stringify(file)},fixed="/usr/local/bin/brain-native-connect";
   fs.chmodSync(file,${mode==="writable"?'0o755':'0o555'});
   const digest=createHash("sha256").update(fs.readFileSync(file)).digest("hex");
   mock.module("node:fs",()=>({...originalFs,statSync:(path,...args)=>originalFs.statSync(path===fixed?file:path,...args),openSync:(path,...args)=>originalFs.openSync(path===fixed?file:path,...args),lstatSync:(path,...args)=>originalFs.lstatSync(path===fixed?file:path,...args),readFileSync:(path,...args)=>originalFs.readFileSync(path===fixed?file:path,...args)}));
   process.argv.push("--native-rtk-view","--native-socket-policy-sha256="+${mode==="changed"?'"a".repeat(64)':'digest'});
   const original=Bun.spawnSync;Bun.spawnSync=((argv,options)=>{if(argv[0]==="cc")throw Error("INNER_COMPILER_REACHED");return Reflect.apply(original,Bun,[argv,options]);});
   const {compileSocketPolicy}=await import(${JSON.stringify(guard+"?artifact-fixture")});
   console.log(compileSocketPolicy());`);
  const child=Bun.spawn([process.execPath,script],{stdout:"pipe",stderr:"pipe"});
  const [code,out,err]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
  expect(code,err).toBe(mode==="valid"?0:1);expect(err).not.toContain("INNER_COMPILER_REACHED");
  if(mode==="valid")expect(out.trim()).toBe("/usr/local/bin/brain-native-connect");else expect(err).toContain("native socket policy artifact is unavailable or changed");
 }finally{rmSync(root,{recursive:true,force:true});}
});

test("an isolated preload without receipt libraries never prints raw diagnostic text",async()=>{
 const root=mkdtempSync(join(tmpdir(),"odysseus-isolated-diagnostic-"));
 try{
  mkdirSync(join(root,"scripts"));mkdirSync(join(root,"packages"));
  writeFileSync(join(root,"package.json"),JSON.stringify({private:true}));copyFileSync(guard,join(root,"scripts/test-native-guard.ts"));
  const script=join(root,"probe.ts"),secret="odysseus-private-diagnostic-material";
  writeFileSync(script,`const original=Bun.spawnSync;
   Bun.spawnSync=((argv,options)=>argv[0]==="cc"?{exitCode:1,stdout:Buffer.alloc(0),stderr:Buffer.from(process.env.TEST_DIAGNOSTIC_SECRET)}:Reflect.apply(original,Bun,[argv,options]));
   const {compileSocketPolicy,scrubNativeStartupTrace}=await import(${JSON.stringify(join(root,"scripts/test-native-guard.ts"))});
   console.log(JSON.stringify({text:scrubNativeStartupTrace(process.env.TEST_DIAGNOSTIC_SECRET)}));
   try{compileSocketPolicy();}catch{}process.exit(1);`);
  const child=Bun.spawn([process.execPath,script],{env:{...process.env,TEST_DIAGNOSTIC_SECRET:secret},stdout:"pipe",stderr:"pipe"});
  const [code,out,err]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
  expect(code).toBe(1);expect(out+err).not.toContain(secret);
  expect(JSON.parse(out).text).toBe("[diagnostic redaction unavailable]");
  const receipt=JSON.parse(err.split("\n").find(line=>line.startsWith('{"kind":"native-offline-boundary"'))!);
  expect(receipt.compilerStderr).toBe("[diagnostic redaction unavailable]");
 }finally{rmSync(root,{recursive:true,force:true});}
});
