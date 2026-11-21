import { watchdogMs } from "../scripts/test-deadlines";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, copyFileSync, symlinkSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileSocketPolicy, nativeTestHead, nativeWorkerPayloadCommand } from "../scripts/test-native-guard";

const entry=join(import.meta.dir,"../packages/ui-sdk/src/server/egress-worker-entry.ts");
const protect=(argv:string[])=>["/synthetic/broker","--",...argv];
const command=["/usr/bin/true"];

test("only the exact pinned egress wrapper receives the inner-command exemption",()=>{
 const root=mkdtempSync(join(tmpdir(),"odysseus-wrapper-"));
 try {
  const copy=join(root,"egress-worker-entry.ts"),alias=join(root,"alias.ts"),trustedAlias=join(root,"trusted-alias.ts");copyFileSync(entry,copy);symlinkSync(copy,alias);symlinkSync(entry,trustedAlias);
  for(const direct of [[],["--direct-loopback"]]) {
   const prefix=[process.execPath,entry,...direct];
   expect(nativeWorkerPayloadCommand([...prefix,...command],command,protect),"PINNED_WRAPPER_OUTSIDE_FILTER").toEqual([...prefix,...protect(command)]);
  }
  for(const payload of [[process.execPath,copy,...command],[process.execPath,alias,...command],[process.execPath,trustedAlias,...command],[process.execPath,entry,"extra",...command],["/usr/bin/true",entry,...command],["/bin/sh","-c","exec bad",...command]]) {
   expect(nativeWorkerPayloadCommand(payload,command,protect),"LOOKALIKE_WRAPPER_NOT_EXEMPT").toEqual(protect(payload));
  }
  const prefix=["/usr/bin/prlimit","--nofile=1024:1024","--","/bin/sh","-c",'IFS= read -r go <&4 && [ "$go" = go ] || exit 125; exec 4<&-; exec "$@"',"brain-worker-start-gate",process.execPath,entry];
  expect(nativeWorkerPayloadCommand([...prefix,...command],command,protect),"FIXED_LAUNCHER_GATES_PRESERVED").toEqual([...prefix,...protect(command)]);
 }finally{rmSync(root,{recursive:true,force:true});}
});

test("trusted egress listens while its synthetic payload and descendant cannot connect or listen",async()=>{
 const root=mkdtempSync(join(tmpdir(),"odysseus-wrapper-policy-")),socket=join(root,"relay.sock");
 const server=Bun.listen({unix:socket,socket:{data(){},open(){},close(){}}});
 try {
  const policy=compileSocketPolicy(),info=statSync(socket,{bigint:true});
  const checks='import socket,errno\nfor op in ["connect","listen"]:\n s=socket.socket()\n try:\n  s.connect(("127.0.0.1",9)) if op=="connect" else s.listen(1)\n  raise AssertionError("payload socket allowed")\n except OSError as e: assert e.errno==errno.EPERM,(op,e)\n finally: s.close()\n';
  const code=checks+'import subprocess,sys\nsubprocess.run([sys.executable,"-I","-S","-c",'+JSON.stringify(checks)+'],check=True)\nprint("RELAY_LISTENED_PAYLOAD_AND_DESCENDANT_DENIED")\n';
  const payload=["/usr/bin/python3","-I","-S","-c",code];
  const argv=nativeWorkerPayloadCommand([process.execPath,entry,...payload],payload,args=>[policy,"--head",nativeTestHead(),"--socket",socket,"--device",String(info.dev),"--inode",String(info.ino),"--allowed",socket,"--",...args]);
  const child=Bun.spawn(["bwrap","--unshare-user","--unshare-net","--unshare-pid","--die-with-parent","--ro-bind","/","/","--proc","/proc","--dev","/dev","--",...argv],{env:{PATH:"/usr/bin:/bin"},stdin:"ignore",stdout:"pipe",stderr:"pipe",timeout:watchdogMs(10000)});
  const [exit,out,err]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
  expect(exit,"TRUSTED_RELAY_STARTS_BEFORE_PAYLOAD_FILTER "+err).toBe(0);
  expect(out).toContain("RELAY_LISTENED_PAYLOAD_AND_DESCENDANT_DENIED");
 }finally{server.stop();rmSync(root,{recursive:true,force:true});}
});
