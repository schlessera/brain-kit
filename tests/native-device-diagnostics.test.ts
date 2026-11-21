import { expect,test } from "bun:test";
import { mkdtempSync,readFileSync,rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nativeDeviceMetadata,nativeDeviceMetadataCommand,nativeStartupOpenStages } from "../scripts/native-device-diagnostics";
test("device metadata is collected by the harmless payload inside its actual view",async()=>{
 const root=mkdtempSync(join(tmpdir(),"odysseus-device-metadata-"));
 try{
  const log=join(root,"trace"),strace=Bun.which("strace");expect(strace,"strace required for device metadata proof").toBeTruthy();
  const child=Bun.spawn([strace!,"-f","-qq","-e","trace=newfstatat","-e","abbrev=!newfstatat,statx","-o",log,"--","bwrap","--unshare-user","--uid","21002","--gid","21002","--unshare-net","--ro-bind","/","/","--dev","/dev","--",...nativeDeviceMetadataCommand(["python3","-I","-S","-c",'import os; fd=os.open("/dev/urandom",os.O_RDONLY);os.close(fd)'])],{env:{PATH:"/usr/bin:/bin"},stdout:"pipe",stderr:"pipe"});
  const [code,out,err]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
  expect(code,"DEVICE_PROBE_PRESERVES_PATH_SEARCH "+err).toBe(0);expect(out).toBe("");
  const records=nativeDeviceMetadata(readFileSync(log,"utf8"));
  expect(records.map(value=>value.device),"ACTUAL_CHILD_DEVICE_METADATA").toEqual(["dev","urandom"]);
  expect(records.find(value=>value.device==="dev")?.uid).toBe(21002);
  for(const value of records){expect(value.mode).toBeGreaterThan(0);expect(Number.isSafeInteger(value.uid)).toBe(true);expect(Number.isSafeInteger(value.gid)).toBe(true);}
 }finally{rmSync(root,{recursive:true,force:true});}
});
test("device metadata cannot retain host paths or arbitrary syscall content",()=>{
 const trace='1 newfstatat(AT_FDCWD, "/home/private-owner/secret", {st_mode=S_IFDIR|0700, st_uid=1000, st_gid=1000}, 0) = 0\n2 newfstatat(AT_FDCWD, "/dev/urandom", {st_mode=S_IFCHR|0666, st_uid=21002, st_gid=21002, private="TOKEN=secret"}, 0) = 0\n3 newfstatat(AT_FDCWD, "/dev", 0x1, 0) = -1 EACCES (Permission denied)';
 expect(nativeDeviceMetadata(trace),"DEVICE_METADATA_FIXED_FIELDS_ONLY").toEqual([{device:"urandom",mode:0o666,uid:21002,gid:21002},{device:"dev",error:"EACCES"}]);
});

test("startup open evidence distinguishes wrapper and native payload without paths",()=>{
 const trace='4 execve("/runtime/bun", ["bun"], 0x0) = 0\n4 openat(AT_FDCWD, "/dev/urandom", O_RDONLY) = -1 EACCES (Permission denied)\n4 clone(child_stack=NULL, flags=SIGCHLD) = 5\n5 execve("/runtime/claude", ["claude"], 0x0) = 0\n5 openat(AT_FDCWD, "/dev/fd/2", O_RDONLY) = -1 EPERM (Operation not permitted)';
 expect(nativeStartupOpenStages(trace,["/runtime/claude"],"/runtime/bun"),"STARTUP_OPEN_EXEC_STAGE").toEqual([{stage:"wrapper",execPosition:1,device:"urandom",error:"EACCES"},{stage:"payload",execPosition:2,device:"fd/2",error:"EPERM"}]);
 const resumed=trace.replace('4 execve("/runtime/bun", ["bun"], 0x0) = 0','4 execve("/runtime/bun", ["bun"], 0x0 <unfinished ...>\n4 <... execve resumed>) = 0');
 expect(nativeStartupOpenStages(resumed,["/runtime/claude"],"/runtime/bun"),"RESUMED_EXEC_STAGE_IS_RETAINED").toEqual(nativeStartupOpenStages(trace,["/runtime/claude"],"/runtime/bun"));
});
test("real worker diagnostic plan stats devices before the trusted Bun wrapper starts",async()=>{
 const {nativeDiagnosticWorkerPayload,nativeWorkerPayloadCommand}=await import("../scripts/test-native-guard");
 const root=mkdtempSync(join(tmpdir(),"odysseus-device-wrapper-"));const socket=join(root,"proxy.sock");
 const server=Bun.listen({unix:socket,socket:{data(){}}});
 try{
  const entry=join(import.meta.dir,"../packages/ui-sdk/src/server/egress-worker-entry.ts"),payload=["/usr/bin/true"],log=join(root,"trace");
  const command=nativeDiagnosticWorkerPayload(nativeWorkerPayloadCommand([process.execPath,entry,...payload],payload,args=>args),true);
  const child=Bun.spawn([Bun.which("strace")!,"-f","-qq","-e","trace=newfstatat,execve","-e","abbrev=!newfstatat,statx","-o",log,"--","bwrap","--unshare-user","--uid","21002","--gid","21002","--unshare-net","--ro-bind","/","/","--tmpfs","/run","--dir","/run/brain-egress","--ro-bind",socket,"/run/brain-egress/proxy.sock","--dev","/dev","--",...command],{env:{PATH:"/usr/bin:/bin"},stdout:"pipe",stderr:"pipe"});
  const [code,err]=await Promise.all([child.exited,new Response(child.stderr).text()]);expect(code,err).toBe(0);
  const trace=readFileSync(log,"utf8"),metadata=nativeDeviceMetadata(trace);expect(metadata.map(v=>v.device),"DEVICE_STATS_PRECEDE_WRAPPER").toEqual(["dev","urandom"]);
  expect(trace.indexOf('"/dev/urandom", {')).toBeLessThan(trace.indexOf('execve('+JSON.stringify(process.execPath)));
 }finally{server.stop();rmSync(root,{recursive:true,force:true});}
});
