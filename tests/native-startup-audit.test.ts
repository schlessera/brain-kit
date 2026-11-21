import { spawnGuardFixture } from "./helpers/native-receipt-fixture";
import { expect, test } from "bun:test";
import { scrubNativeStartupTrace } from "../scripts/test-native-guard";

test("identity startup audit bounds the tail and omits argv environment credentials and paths",()=>{
 const prompt="SIRENS_PROMPT_MUST_NOT_PRINT",secret="sk-ant-"+"v".repeat(48);
 const text=scrubNativeStartupTrace('old header\n'+"compiler note voyage\n".repeat(6000)+
  `42 execve("/tmp/odysseus-runtime", ["${prompt}"], ["TOKEN=${secret}"]) = 0\n`+
  `43 execveat(3, "cli", ["${prompt}"], ["TOKEN=${secret}"], 0) = 0\n`+
  '42 openat(AT_FDCWD, "/tmp/odysseus-private/config", O_RDONLY) = -1 ENOENT\n'+
  '42 clone3({flags=CLONE_VM}, 88) = -1 EAGAIN\n');
 expect(text.length).toBeLessThanOrEqual(65536);expect(text).not.toContain("old header");
 for(const hidden of [prompt,secret,"/tmp/odysseus-private"])expect(text).not.toContain(hidden);
 expect(text).toContain("execve([arguments omitted])");expect(text).toContain("clone3");expect(text).toContain("EAGAIN");
 expect(scrubNativeStartupTrace('execve("x", ["'+prompt.repeat(4000)+'"], []) = 0')).toBe("");
});

for(const writeFailure of [false,true]) test(`identity audit snapshots sanitized file/process evidence before raw cleanup (${writeFailure?"blocked":"retained"})`,async()=>{
 const fs=await import("node:fs"),path=await import("node:path"),os=await import("node:os");
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"odysseus-identity-audit-"));
 try{
  const script=path.join(root,"probe.ts"),guard=path.join(import.meta.dir,"../scripts/test-native-guard.ts");
  fs.writeFileSync(script,`import * as fs from "node:fs";import {mock} from "bun:test";
   const originalFs={...fs};
   ${writeFailure?'mock.module("node:fs",()=>({...originalFs,writeFileSync:(path,...args)=>{if(String(path).includes("/native-startup-audit-"))throw Error("fixture diagnostic write refused");return originalFs.writeFileSync(path,...args);}}));':''}
   const spawnSync=Bun.spawnSync;
   Bun.spawnSync=((argv,options)=>{if(argv[0]==="/usr/bin/python3") {if(argv[5]==="set"){fs.chmodSync(argv[7],0o730);fs.chmodSync(argv[8],0o620);}return {exitCode:0,stdout:Buffer.alloc(0),stderr:Buffer.alloc(0)};}return Reflect.apply(spawnSync,Bun,[argv,options]);});
   process.argv.push("--native-identity-startup-audit="+${JSON.stringify(root)});
   const {auditNativeLaunch}=await import(${JSON.stringify(guard+"?identity-audit-fixture")});
   let cleaned=false;const audit=auditNativeLaunch(["/usr/bin/true"],["/synthetic/runtime"],()=>{cleaned=true;},21002);
   const selection=audit.argv.find(value=>value.startsWith("trace="));
   if(!selection.includes("%file,%process")||/read|write/.test(selection))throw Error("UNSAFE_OR_MISSING_STARTUP_TRACE");
   const raw=audit.argv[audit.argv.indexOf("-o")+1];
   fs.writeFileSync(raw,'42 execve("/synthetic/runtime", ["SIRENS_PRIVATE_PROMPT"], ["TOKEN=sk-ant-'+"v".repeat(48)+'"]) = 0\\n42 clone3({}, 88) = -1 EAGAIN\\n42 openat(AT_FDCWD, \"connect(3) = -1 EPERM\", O_RDONLY) = -1 ENOENT\\n');
   audit.dispose();
   if(!cleaned||fs.existsSync(raw))throw Error("RAW_AUDIT_NOT_CLEANED");
   console.log(JSON.stringify(fs.readdirSync(${JSON.stringify(root)}).filter(name=>name.startsWith("native-startup-audit-")).map(name=>JSON.parse(fs.readFileSync(${JSON.stringify(root)}+"/"+name,"utf8")))));`);
  const child=spawnGuardFixture([process.execPath,script],{stdout:"pipe",stderr:"pipe"});
  const [code,out,err]=await Promise.all([child.exited,new Response(child.stdout).text(),child.guardOutput()]);
  expect(code,err).toBe(0);
  const audit=JSON.parse(err.split("\n").find(line=>line.startsWith('{"kind":"native-offline-audit"'))!);expect(audit.deniedConnects).toBe(0);
  const snapshots=JSON.parse(out);expect(snapshots).toHaveLength(writeFailure?0:1);
  if(writeFailure) { expect(err).toContain('"kind":"native-fixture-startup-audit-failure"');expect(err).toContain('"nativeLaunched":true,"success":true'); }
  else {expect(snapshots[0].text).toContain("EAGAIN");expect(snapshots[0].text).not.toContain("SIRENS_PRIVATE_PROMPT");expect(snapshots[0].text).not.toContain("sk-ant-");}
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
