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

test("registered turn proxy stream works while another port or loopback address stays denied",async()=>{
 const {createServer}=await import("node:net"),{once}=await import("node:events");
 const {nativeScriptedService,startNativeTurnProxyTunnel,nativeTurnProxyArguments,WORKER_TURN_PROXY}=await import("../scripts/test-native-guard");
 const root=mkdtempSync(join(tmpdir(),"odysseus-registered-proxy-"));
 const recorder=createServer(peer=>{peer.on("error",()=>{});peer.pipe(peer);});recorder.listen(0,"127.0.0.1");await once(recorder,"listening");
 const leave=nativeScriptedService(`http://127.0.0.1:${(recorder.address() as {port:number}).port}`,{fixtureRoots:[root]});
 const tunnel=startNativeTurnProxyTunnel(`http://127.0.0.1:${(recorder.address() as {port:number}).port}`,root);
 try{
  const policy=compileSocketPolicy(),info=statSync(tunnel.socket,{bigint:true});
  const code='import socket,errno,os,urllib.parse\np=urllib.parse.urlparse(os.environ["HTTP_PROXY"]).port\nos.environ["HTTP_PROXY"]="http://127.0.0.2:1"\ns=socket.socket();s.connect(("127.0.0.1",p));s.sendall(b"Ithaca");assert s.recv(6)==b"Ithaca";s.close()\nfor host,port in [("127.0.0.1",p%65535+1),("127.0.0.2",p)]:\n s=socket.socket()\n try: s.connect((host,port));raise AssertionError("UNDECLARED_LOOPBACK_ENDPOINT_ALLOWED")\n except OSError as e: assert e.errno==errno.EPERM\n finally: s.close()\nfor op in ["bind","listen"]:\n s=socket.socket()\n try:\n  s.bind(("127.0.0.1",0)) if op=="bind" else s.listen(1)\n  raise AssertionError("PAYLOAD_LISTEN_ALLOWED")\n except OSError as e: assert e.errno==errno.EPERM\n finally: s.close()\nprint("DECLARED_PROXY_STREAM_ONLY")';
  const payload=["/usr/bin/python3","-I","-S","-c",code];
  const argv=nativeWorkerPayloadCommand([process.execPath,entry,...payload],payload,args=>[policy,"--head",nativeTestHead(),"--socket",tunnel.socket,"--device",String(info.dev),"--inode",String(info.ino),"--allowed",tunnel.socket,...nativeTurnProxyArguments(tunnel.socket,WORKER_TURN_PROXY),"--",...args]);
  const child=Bun.spawn(["bwrap","--unshare-user","--unshare-net","--unshare-pid","--die-with-parent","--ro-bind","/","/","--tmpfs","/run","--dir","/run/brain-egress","--ro-bind",tunnel.socket,WORKER_TURN_PROXY,"--proc","/proc","--dev","/dev","--",...argv],{env:{PATH:"/usr/bin:/bin"},stdin:"ignore",stdout:"pipe",stderr:"pipe",timeout:watchdogMs(10000)});
  const [exit,out,err]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
  expect(exit,"DECLARED_PROXY_STREAM_ONLY "+err).toBe(0);expect(out).toContain("DECLARED_PROXY_STREAM_ONLY");
  const source=require("node:fs").readFileSync(join(import.meta.dir,"../scripts/native-proof/native-connect.c"),"utf8");expect(source).toContain('.flags=0');expect(source).not.toMatch(/\.flags\s*=\s*SECCOMP_USER_NOTIF_FLAG_CONTINUE/);
 }finally{tunnel.dispose();leave();recorder.close();rmSync(root,{recursive:true,force:true});}
});
