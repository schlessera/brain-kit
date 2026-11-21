import {expect,test} from "bun:test";
import {mkdtempSync,rmSync,statSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {watchdogMs} from "../scripts/test-deadlines";
import {compileSocketPolicy,nativeTestHead,nativeDirectTransportCommand,nativeDirectTransportEnvironment,nativeScriptedService,startNativeTurnProxyTunnel,nativeTurnProxyArguments,WORKER_TURN_PROXY} from "../scripts/test-native-guard";

test("direct native plans preserve product authentication without injecting socket login",()=>{
 const product={ANTHROPIC_BASE_URL:"http://127.0.0.1:1234",ANTHROPIC_API_KEY:"fixture-key",CLAUDE_CODE_OAUTH_TOKEN:"fixture-oauth"};
 const direct={...product,...nativeDirectTransportEnvironment(product,false)};
 expect(direct,"DIRECT_QUERY_AUTH_ENV_UNCHANGED").toEqual({...product,ANTHROPIC_BASE_URL:"http://127.0.0.1"});
 expect(direct,"DIRECT_QUERY_HAS_NO_SOCKET_LOGIN").not.toHaveProperty("ANTHROPIC_UNIX_SOCKET");
 expect(nativeDirectTransportEnvironment({...product,ANTHROPIC_UNIX_SOCKET:"/admitted/relay.sock"},true)).toEqual({ANTHROPIC_BASE_URL:"http://localhost",ANTHROPIC_UNIX_SOCKET:"/tmp/native-relay/relay.sock"});
});

test("direct pinned transport delivers native headers unchanged through private loopback and Unix tunnel",async()=>{
 const root=mkdtempSync(join(tmpdir(),"odysseus-direct-transport-")),seen:Array<{key:string|null;auth:string|null;path:string}>=[];
 const recorder=Bun.serve({hostname:"127.0.0.1",port:0,fetch(req){seen.push({key:req.headers.get("x-api-key"),auth:req.headers.get("authorization"),path:new URL(req.url).pathname});return new Response("Ithaca");}});
 const origin=recorder.url.origin,leave=nativeScriptedService(origin,{fixtureRoots:[root]}),tunnel=startNativeTurnProxyTunnel(origin,root);
 try{
  const policy=compileSocketPolicy(),info=statSync(tunnel.socket,{bigint:true});
  const code='import os,http.client,urllib.parse\nassert "ANTHROPIC_UNIX_SOCKET" not in os.environ,"DIRECT_QUERY_HAS_NO_SOCKET_LOGIN"\nu=urllib.parse.urlsplit(os.environ["ANTHROPIC_BASE_URL"])\nassert u.hostname=="127.0.0.1" and u.port\nc=http.client.HTTPConnection(u.hostname,u.port);c.request("POST","/v1/messages",body="{}",headers={"x-api-key":"odysseus-helper-key","authorization":"Bearer odysseus-oauth"});r=c.getresponse();assert r.read()==b"Ithaca";assert r.status==200\nprint("DIRECT_HEADERS_UNCHANGED")';
  const payload=nativeDirectTransportCommand(["/usr/bin/python3","-I","-S","-c",code]);
  const child=Bun.spawn(["bwrap","--unshare-user","--unshare-net","--unshare-pid","--die-with-parent","--ro-bind","/","/","--tmpfs","/run","--dir","/run/brain-egress","--ro-bind",tunnel.socket,WORKER_TURN_PROXY,"--proc","/proc","--dev","/dev","--",process.execPath,join(import.meta.dir,"../packages/ui-sdk/src/server/egress-worker-entry.ts"),"--direct-loopback",policy,"--head",nativeTestHead(),"--socket",tunnel.socket,"--device",String(info.dev),"--inode",String(info.ino),"--allowed",tunnel.socket,...nativeTurnProxyArguments(tunnel.socket,WORKER_TURN_PROXY),"--",...payload],{env:{PATH:"/usr/bin:/bin",...nativeDirectTransportEnvironment({},false)},stdin:"ignore",stdout:"pipe",stderr:"pipe",timeout:watchdogMs(10000)});
  const [exit,out,err]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
  expect(exit,"DIRECT_HEADERS_UNCHANGED "+err).toBe(0);expect(out).toContain("DIRECT_HEADERS_UNCHANGED");expect(seen).toEqual([{key:"odysseus-helper-key",auth:"Bearer odysseus-oauth",path:"/v1/messages"}]);
 }finally{tunnel.dispose();leave();recorder.stop(true);rmSync(root,{recursive:true,force:true});}
});
