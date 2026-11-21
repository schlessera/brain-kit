/** Harmless Bun/bwrap processes prove guard records never enter child stderr. */
import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, copyFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { captureNativeReceipts } from "../scripts/native-test-receipts";
const receiptModule=join(import.meta.dir,"../scripts/native-test-receipts.ts");
for(const view of ["plain","clearenv"] as const)test(`guard-owned receipts bypass ${view} child stderr`,async()=>{
 const capture=captureNativeReceipts();
 try{
  const script=`import {nativeReceipt} from ${JSON.stringify(receiptModule)};nativeReceipt({kind:"native-offline-audit",head:"${"a".repeat(40)}",success:true,nativeLaunched:true,fixture:true});console.log("Odysseus protocol");`;
  const argv=view==="plain"?[process.execPath,"-e",script]:["bwrap","--ro-bind","/","/","--tmpfs","/tmp","--proc","/proc","--dev","/dev","--clearenv","--setenv","PATH","/usr/bin:/bin",process.execPath,"-e",script];
  const child=Bun.spawn(argv,{env:{PATH:"/usr/bin:/bin",...capture.env},stdout:"pipe",stderr:"pipe"});
  const [code,out,err]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
  expect(code,err).toBe(0);expect(out.trim()).toBe("Odysseus protocol");expect(err,"CHILD_STDERR_IS_PROTOCOL_ONLY").toBe("");
  expect(JSON.parse(capture.read())).toMatchObject({kind:"native-offline-audit",success:true,fixture:true});
 }finally{capture.dispose();}
});

test("protocol-only worker bootstrap receives no guard receipt authority",async()=>{
 const root=mkdtempSync(join(tmpdir(),"odysseus-protocol-fds-")),capture=captureNativeReceipts();
 try{
  const directory=join(root,"ui-sdk/src/server");mkdirSync(directory,{recursive:true});
  const script=join(directory,"worker-entry.ts");writeFileSync(script,`import {readdirSync,readFileSync,readlinkSync} from "node:fs";const extra=[];for(const name of readdirSync("/proc/self/fd")){const fd=Number(name);if(fd<=2)continue;try{const flags=readFileSync("/proc/self/fdinfo/"+fd,"utf8").match(/^flags:\\s+([0-7]+)/m)?.[1];if(flags&&!(parseInt(flags,8)&0o2000000)&&readlinkSync("/proc/self/fd/"+fd)!=="/dev/urandom")extra.push(fd);}catch{}}console.log(JSON.stringify({extra,receipt:process.env.BRAIN_NATIVE_RECEIPT??null}));`);
  const child=Bun.spawn([process.execPath,script],{env:{PATH:"/usr/bin:/bin",HOME:root,...capture.env},stdout:"pipe",stderr:"pipe"});
  const [code,out,err]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
  expect(code,err).toBe(0);expect(JSON.parse(out),"WORKER_HAS_NO_RECEIPT_DESCRIPTOR").toEqual({extra:[],receipt:null});expect(capture.read()).toBe("");
 }finally{capture.dispose();rmSync(root,{recursive:true,force:true});}
});

test("an already-exited bootstrap still reports numeric exit evidence through the owner channel",async()=>{
 const capture=captureNativeReceipts();
 try{
  const script=`import {recordNativeGuardChild,nativeBootstrapStatus} from ${JSON.stringify(join(import.meta.dir,"../scripts/test-native-guard.ts"))};const child=Bun.spawn(["/usr/bin/true"],{stdout:"ignore",stderr:"ignore"});await child.exited;recordNativeGuardChild(child,true);await Promise.resolve();console.log(JSON.stringify(nativeBootstrapStatus(child.pid)));`;
  const child=Bun.spawn([process.execPath,"-e",script],{env:{PATH:"/usr/bin:/bin",...capture.env},stdout:"pipe",stderr:"pipe"});
  const [code,out,err]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
  expect(code,err).toBe(0);expect(err).toBe("");expect(JSON.parse(out)).toEqual({exitCode:0,signalCode:null});
  expect(JSON.parse(capture.read())).toMatchObject({kind:"native-offline-bootstrap-exit",exitCode:0,signal:null});
 }finally{capture.dispose();}
});


test("copied preload modules retain the same owner channel after environment consumption",async()=>{
 const root=mkdtempSync(join(tmpdir(),"odysseus-copied-receipts-")),capture=captureNativeReceipts();
 try{
  const copied=join(root,"receipts.ts");copyFileSync(receiptModule,copied);
  const script=`import {nativeReceipt} from ${JSON.stringify(copied)};nativeReceipt({kind:"native-offline-audit",success:true,fixture:"copied-preload"});`;
  const child=Bun.spawn([process.execPath,"-e",script],{env:{PATH:"/usr/bin:/bin",...capture.env},stdout:"pipe",stderr:"pipe"});
  const [code,err]=await Promise.all([child.exited,new Response(child.stderr).text()]);
  expect(code,err).toBe(0);expect(err,"COPIED_PRELOAD_STDERR_IS_CLEAN").toBe("");expect(JSON.parse(capture.read()).fixture).toBe("copied-preload");
 }finally{capture.dispose();rmSync(root,{recursive:true,force:true});}
});
