import { Hono } from "hono";
import { generateSignedCookie } from "hono/cookie";
import { mkdtempSync,rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppEnv } from "../../src/app-env";
import type { Principal } from "../../src/db/principals";
import { createPrincipal,resolvePrincipal,isUsablePrincipal } from "../../src/db/principals";
import { createUiDb } from "../../src/db/client";
import { openSqliteWriter } from "../../src/db/write-worker";
import { registerPrincipalWrites } from "../../src/db/principal-writes";
import { createAccountPartitionKeys } from "../../src/middleware/account-partition";
import { createGovernanceWrites } from "../../src/governance/event-writes";
import { occurrence } from "../../src/governance/occurrence";
import { SafetyHistory } from "../../src/governance/safety-history";
import { safetyCatalogCreated } from "../../src/governance/safety-store";
import { authGuard,isWsAuthorized,type AuthMode,type AuthRuntime } from "../../src/middleware/auth";
import { createSessionSafetyRoutes } from "../../src/routes/session-safety";
import { createOwnerSafetyReviewRoutes } from "../../src/routes/owner-safety-review";
import { OwnerSafetyReviews } from "../../src/governance/owner-safety-reviews";
import { createWsUpgrade,websocket } from "../../src/ws/connection";
import { WsHost } from "../../src/ws/host";
import { createSessionCatalog } from "../../src/ws/session-catalog";
import { createStaticBackendRegistry } from "../../src/agent/backend";
import { makeFakeBackend } from "./fake-backend";
import type { ServerMessage } from "@schlessera/brain-ui-sdk/protocol";

const FRAME_DEADLINE_MS = 15_000;
export async function safetyHistoryFixture(bound=true,review=false,mode:AuthMode="password"){
  const root=mkdtempSync(join(tmpdir(),"odysseus-safety-history-")),path=join(root,"ui.db"),db=createUiDb(path),writer=openSqliteWriter(db);
  const writes=createGovernanceWrites(db,writer),principal=createPrincipal(db,{authMethod:"password",label:"Odysseus",ttlSeconds:3600});
  if(review)registerPrincipalWrites(db,writer);
  const brainKey=review?createAccountPartitionKeys(db,root,mode)(principal)!:"";
  const reviews=review?new OwnerSafetyReviews(db,writes,mode,brainKey):undefined;
  const valid=(p:Principal)=>{const current=resolvePrincipal(db,p.id);return !!current&&isUsablePrincipal(current,Date.now());};
  let clock=Date.now(),wait:Promise<void>|undefined,entered:(()=>void)|undefined,starts=0;
  const settled=async()=>{await writer.idle();entered?.();await wait;};
  const history=new SafetyHistory(db,valid,settled,()=>clock);
  const backend=makeFakeBackend({id:"claude",startTurn:async()=>{starts++;throw new Error("Read invoked mutation");}});
  const host=new WsHost({registry:createStaticBackendRegistry([backend]),catalog:createSessionCatalog(()=>db),safetyHistory:history,ownerSafetyReviews:reviews,isPrincipalValid:valid});
  const bindingId=crypto.randomUUID();
  await writes.safetyBegin({turnId:"voyage",bindingId,sessionId:null,principalId:principal.id,backendId:"claude",at:0});await writes.safetyReady("voyage","claude",1);
  const bind=async()=>{db.query("INSERT INTO sessions(id,created_at,last_active_at,backend_id) VALUES('ithaca',0,0,'claude')").run();
    db.query("INSERT INTO chat_session_owners VALUES('ithaca',?,0)").run(principal.id);safetyCatalogCreated(db,"ithaca",principal.id,"voyage");await writes.bind("voyage","ithaca");};
  if(bound)await bind();
  const secret="odysseus-safety-history-loopback-secret";
  const auth={host:"127.0.0.1",mode,passwordHash:"unused",cookieSecret:secret,trustProxy:mode==="proxy"||mode==="tailscale",trustProxyHops:1,proxyAuthHeader:"x-user"} as AuthRuntime;
  const app=new Hono<AppEnv>();
  app.get("/ws",async(c,next)=>{const p=await isWsAuthorized(c,mode,auth,db);if(!p)return c.json({error:"unauthorized"},401);c.set("principal",p);return next();},createWsUpgrade(host));
  app.use("/api/*",authGuard(mode,auth,db));app.route("/api",createSessionSafetyRoutes(history,valid));
  if(reviews)app.route("/api",createOwnerSafetyReviewRoutes(reviews,false));
  const server=Bun.serve({hostname:"127.0.0.1",port:0,fetch:app.fetch,websocket});
  const cookieFor=async(p:Principal)=>(await generateSignedCookie("brain_ui_session",p.id,secret)).split(";")[0]!;
  const cookie=await cookieFor(principal),sockets:WebSocket[]=[];
  const get=(suffix="",credential=cookie)=>fetch(`http://127.0.0.1:${server.port}/api/sessions/ithaca/safety${suffix}`,{headers:{cookie:credential}});
  const add=async(name:string,proxy=false)=>{const o=occurrence(bindingId,proxy?"proxy_input":"tool_web_input",proxy?null:name,"finalized");
    await writes.record({kind:"taint",sessionId:bound?"ithaca":null,turnId:"voyage",at:0,actor:"interactive",model:null,profile:"governed",
      payload:{source:proxy?"egress_connection":"web_fetch",tool:proxy?"shell":"WebFetch",detail:"https://odysseus:credential@ithaca.invalid/private?token=secret",occurrence:o}});return o;};
  const connect=async(credential=cookie)=>{
    const frames:ServerMessage[]=[];const listeners=new Set<()=>void>();
    const AuthenticatedWebSocket=WebSocket as unknown as new(url:string,options:Bun.WebSocketOptions)=>WebSocket;
    const ws=new AuthenticatedWebSocket(`ws://127.0.0.1:${server.port}/ws`,{headers:{cookie:credential}});sockets.push(ws);
    ws.addEventListener("message",e=>{frames.push(JSON.parse(String(e.data)));for(const wake of listeners)wake();});
    const until=(predicate:(m:ServerMessage)=>boolean)=>new Promise<ServerMessage>((resolve,reject)=>{
      const check=()=>{const index=frames.findIndex(predicate);if(index<0)return;const frame=frames.splice(index,1)[0]!;clearTimeout(timer);listeners.delete(check);resolve(frame);};
      // The deadline only turns a missing frame into a fast failure. 3 s was
      // shorter than a loaded parallel CI shard needs to deliver a real frame
      // (#3845); every assertion is unchanged.
      const timer=setTimeout(()=>{listeners.delete(check);reject(new Error("Safety frame deadline"));},FRAME_DEADLINE_MS);listeners.add(check);check();});
    const hello=await until(m=>m.type==="server_hello");ws.send(JSON.stringify({type:"client_hello",protocolRev:5,capabilities:{sessionSafetyHistory:true}}));
    return {ws,frames,until,hello,send:(v:unknown)=>ws.send(JSON.stringify(v))};
  };
  return {root,path,url:`ws://127.0.0.1:${server.port}/ws`,cookie,db,writer,writes,principal,history,reviews,brainKey,auth,host,bindingId,add,bind,get,connect,cookieFor,starts:()=>starts,
    advance(ms:number){clock+=ms;},
    hold(){let release!:()=>void;wait=new Promise<void>(r=>{release=r;});const arrived=new Promise<void>(r=>{entered=r;});return {arrived,release(){wait=undefined;entered=undefined;release();}};},
    async close(){for(const s of sockets)s.close();server.stop(true);await host.close();await writer.close();db.close();rmSync(root,{recursive:true,force:true});},
  };
}
