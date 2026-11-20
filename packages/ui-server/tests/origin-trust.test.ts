import { createEffectiveSafety } from "../src/governance/effective-safety.js";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSqliteWriter } from "../src/db/write-worker.js";
import { connect } from "node:net";
import { request } from "node:http";
import { resolveGovernancePolicy, type TrustRule, type GovernancePolicyInput } from "@schlessera/brain-common/internal/governance-policy";
import type { BackendBridge, PermissionDecision } from "@schlessera/brain-ui-sdk/server";
import { createUiDb } from "../src/db/client.js";
import { createGovernanceWrites } from "../src/governance/event-writes.js";
import { queryGovernanceEvents } from "../src/governance/events.js";
import { occurrence } from "../src/governance/occurrence.js";
import { safetyProjection, pruneSafetyDetail } from "../src/governance/safety-store.js";
import { prepareTurnEgress } from "../src/brain/turn-egress.js";
import type { OriginTrust } from "../src/brain/origin-trust.js";
import { connectedSafetySession } from "./helpers/connected-safety.js";
function get(socketPath: string, target: string): Promise<number> {
  return new Promise((resolve, reject) => { const r = request({ socketPath, path: target }, response => {
    response.resume(); response.once("end", () => resolve(response.statusCode!)); response.once("error", reject);
  }); r.once("error", reject); r.end(); });
}
function trust(rule: TrustRule) {
  let revision = "1", rules = [rule]; const listeners = new Set<() => void>();
  const live: OriginTrust = { revision: () => revision, read: () => ({revision,rules,policyHash:"a".repeat(64)}), subscribe: cb => {listeners.add(cb);return () => {listeners.delete(cb);};} };
  return { live, remove() { rules=[];revision="2";for(const cb of listeners)cb(); } };
}
async function fixture(recipient = false, policy: GovernancePolicyInput = {schema_version:1}, response?: () => Response, full = false) {
  const root=full?mkdtempSync(join(tmpdir(),"odysseus-origin-trust-")):null;
  const db = createUiDb(root?join(root,"ui.db"):":memory:"); connectedSafetySession(db,"voyage","turn-voyage");
  const writer=full?openSqliteWriter(db):undefined;
  const writes = createGovernanceWrites(db,writer); let asks = 0, hits = 0;
  let decide: BackendBridge["requestPermission"] = async () => ({behavior:"deny",message:"Athena declines"});
  const origin = Bun.serve({hostname:"127.0.0.1",port:0,fetch(){hits++;return response?.() ?? new Response("Ithaca");}});
  const rule: TrustRule = {id:"ithaca",label:"Ithaca",incomingContent:true,recipientWhileRestricted:recipient,
    selector:{kind:"web_origin",scheme:"http",host:"127.0.0.1",port:origin.port!}};
  const t=trust(rule);const controller=new AbortController();
  const bridge={emit(){},requestPermission:async(...args: Parameters<BackendBridge["requestPermission"]>)=>{asks++;return decide(...args);},admissionSafety:createEffectiveSafety(db,{turnId:"turn-voyage",sessionId:()=>"voyage",policyHash:null,writes,trust:t.live,authority:()=>({current:true,epoch:"0"})})} as unknown as BackendBridge;
  const proxy=await prepareTurnEgress({policy:resolveGovernancePolicy(policy),trust:t.live,controller,turnId:"turn-voyage",sessionId:()=>"voyage",model:()=>null,profile:"governed",origin:"interactive",governanceDb:db,governanceWrites:writes,record:writes.record,
    bridge});
  const epoch=(db.query("SELECT id FROM safety_collections WHERE turn_id='turn-voyage'").get() as {id:string}).id;
  const taint=()=>writes.firstTaint({kind:"taint",turnId:"turn-voyage",sessionId:"voyage",actor:"interactive",profile:"governed",model:null,payload:{source:"web_search",tool:null,detail:null,occurrence:occurrence(epoch,"tool_web_input",crypto.randomUUID(),"finalized")}});
  return {db,writes,writer,origin,proxy,t,taint,controller,bridge,decide(value: BackendBridge["requestPermission"]) { decide=value; },asks:()=>asks,hits:()=>hits,async close(){proxy.stop();origin.stop(true);await proxy.settled();await writer?.close();db.close();if(root)rmSync(root,{recursive:true,force:true});}};
}
test("verified future input retains its decision without creating an unresolved trigger or recipient grant",async()=>{
 const f=await fixture();try{
  expect(await get(f.proxy.socketPath,f.origin.url.href)).toBe(200);await f.proxy.settled();
  expect(safetyProjection(f.db,"turn-voyage","voyage").unresolvedCount,"ORIGIN_TRUST_NO_UNRESOLVED").toBe(0);
  const events=queryGovernanceEvents(f.db,{kinds:["taint"],limit:10});expect(events[0]?.payload).toMatchObject({occurrence:{admission:{trusted:true,ruleId:"ithaca",trustRevision:"1",policyHash:"a".repeat(64)}}});
  await f.taint();expect(await get(f.proxy.socketPath,f.origin.url.href),"SOURCE_ONLY_STILL_ASKS").toBe(403);expect(f.asks()).toBe(1);expect(f.hits()).toBe(1);
 }finally{await f.close();}
});
test("explicit exact recipient permits only the taint card while unrelated triggers remain",async()=>{
 const f=await fixture(true);try{await f.taint();expect(await get(f.proxy.socketPath,f.origin.url.href),"EXPLICIT_RECIPIENT_ADMITTED").toBe(200);expect(f.asks()).toBe(0);await f.proxy.settled();expect(f.proxy.recordingFailure()).toBeUndefined();expect(queryGovernanceEvents(f.db,{kinds:["egress_connection"],limit:10})[0]?.payload).toMatchObject({recipientAdmission:{ruleId:"ithaca",trustRevision:"1"}});expect(safetyProjection(f.db,"turn-voyage","voyage").unresolvedCount).toBe(1);
 }finally{await f.close();}
});
test("removal fences future admissions and preserves historical trust",async()=>{
 const f=await fixture();try{expect(await get(f.proxy.socketPath,f.origin.url.href)).toBe(200);await f.proxy.settled();f.t.remove();
  await f.taint();expect(await get(f.proxy.socketPath,f.origin.url.href)).toBe(403);
  const events=queryGovernanceEvents(f.db,{kinds:["taint"],limit:10});expect(events.some(e=>(e.payload as any).occurrence?.admission?.trusted)).toBe(true);
 }finally{await f.close();}
});

test("exact recipients cannot cover another port, a subdomain or opaque CONNECT",async()=>{
 const f=await fixture(true);const other=Bun.serve({hostname:"127.0.0.1",port:0,fetch:()=>new Response("Troy")});
 try{await f.taint();expect(await get(f.proxy.socketPath,other.url.href)).toBe(403);
  expect(await get(f.proxy.socketPath,`http://sub.localhost:${f.origin.port}/`)).toBe(403);
  const status=await new Promise<number>((resolve,reject)=>{const c=connect(f.proxy.socketPath);c.on("error",reject);c.on("connect",()=>c.write(`CONNECT 127.0.0.1:${f.origin.port} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n`));c.on("data",b=>{resolve(Number(/^HTTP\/1.1 (\d+)/.exec(b.toString())?.[1]));c.destroy();});});
  expect(status,"HTTPS_RULE_NEVER_COVERS_OPAQUE_TUNNEL").toBe(403);expect(f.asks()).toBe(3);expect(f.hits()).toBe(0);
 }finally{other.stop(true);await f.close();}
});
for(const policy of [{schema_version:1,egress:{deny:["127.0.0.1"]}},{schema_version:1,egress:{mode:"allowlist",allow:["ithaca.invalid"]}},{schema_version:1,egress:{max_bytes_per_turn:1}},{schema_version:1,outward:{hosts:["127.0.0.1"]}}] satisfies GovernancePolicyInput[])test(`trust retains independent controls ${JSON.stringify(policy)}`,async()=>{
 const f=await fixture(true,policy);try{await f.taint();expect(await get(f.proxy.socketPath,f.origin.url.href)).toBe(403);expect(f.hits()).toBe(0);}finally{await f.close();}
});
test("source removal during durable admission refuses the actual upstream dispatch",async()=>{
 const f=await fixture(false,{schema_version:1},undefined,true);let entered!:()=>void,release!:()=>void;const reached=new Promise<void>(r=>{entered=r;}),held=new Promise<void>(r=>{release=r;});const original=f.writes.firstTaint;
 f.writes.firstTaint=async(...args)=>{entered();await held;return original(...args);};
 try{const pending=get(f.proxy.socketPath,f.origin.url.href).catch(()=>0);await reached;f.t.remove();release();await pending;await f.proxy.settled();expect(f.hits(),"REMOVAL_AFTER_WRITE_WAIT_PREVENTS_DISPATCH").toBe(0);expect(f.proxy.recordingFailure(),"REMOVAL_DURING_WRITE_KEEPS_RECORDER_HEALTHY").toBeUndefined();expect(f.controller.signal.aborted).toBe(false);}finally{release();await f.close();}
});
test("removal interrupts an actual open trusted response before later input",async()=>{
 let stream!:ReadableStreamDefaultController<Uint8Array>;
 const f=await fixture(false,{schema_version:1},()=>new Response(new ReadableStream<Uint8Array>({start(c){stream=c;c.enqueue(new TextEncoder().encode("first"));}})));
 const other=Bun.serve({hostname:"127.0.0.1",port:0,fetch:()=>new Response("Troy")});
 let first!:()=>void;const received=new Promise<void>(r=>{first=r;});let text="";
 const closed=new Promise<void>((resolve,reject)=>{const r=request({socketPath:f.proxy.socketPath,path:f.origin.url.href},response=>{response.on("data",b=>{text+=b;first();});response.on("close",resolve);response.on("error",()=>resolve());});r.on("error",reject);r.end();});
 try{await received;expect(await get(f.proxy.socketPath,other.url.href)).toBe(200);f.t.remove();await f.proxy.settled();expect(queryGovernanceEvents(f.db,{kinds:["egress_connection"],limit:10}).find(e=>(e.payload as any).port===f.origin.port)?.payload,"REMOVAL_SYNCHRONOUSLY_STOPS_STREAM").toMatchObject({outcome:"cancelled"});expect(f.controller.signal.aborted).toBe(false);try{stream.enqueue(new TextEncoder().encode("later"));}catch{}await closed;expect(text).toBe("first");expect(await get(f.proxy.socketPath,other.url.href),"TRUST_REMOVAL_LEAVES_UNRELATED_TURN_TRAFFIC_USABLE").toBe(200);await f.proxy.settled();expect(queryGovernanceEvents(f.db,{kinds:["taint_exposure"],limit:10}).some(e=>(e.payload as any).state==="interrupted_unknown")).toBe(true);}finally{other.stop(true);await f.close();}
});
test("pruning retains historical admission facts without turning trusted input unresolved",async()=>{
 const f=await fixture();try{expect(await get(f.proxy.socketPath,f.origin.url.href)).toBe(200);await f.proxy.settled();pruneSafetyDetail(f.db,Date.now()+1);expect(safetyProjection(f.db,"turn-voyage","voyage").unresolvedCount).toBe(0);const rows=f.db.query("SELECT payload FROM safety_records WHERE kind='occurrence'").all() as {payload:string}[];expect(JSON.parse(rows[0]!.payload).admission).toMatchObject({trusted:true,ruleId:"ithaca"});}finally{await f.close();}
});
test("recipient-only permission never turns into a legacy hostname grant after removal",async()=>{
 const f=await fixture(true);try{f.t.live.read().rules[0]!.incomingContent=false;await f.taint();expect(await get(f.proxy.socketPath,f.origin.url.href)).toBe(200);await f.proxy.settled();f.t.remove();expect(await get(f.proxy.socketPath,f.origin.url.href),"RECIPIENT_REMOVAL_NO_LEGACY_GRANT").toBe(403);expect(f.asks()).toBe(1);expect(f.hits()).toBe(1);}finally{await f.close();}
});
test("a redirect destination and concurrent unrelated traffic cannot borrow an exact rule",async()=>{
 const other=Bun.serve({hostname:"127.0.0.1",port:0,fetch:()=>new Response("Troy")});
 const f=await fixture(true,{schema_version:1},()=>Response.redirect(other.url.href));try{await f.taint();const results=await Promise.all([get(f.proxy.socketPath,f.origin.url.href),get(f.proxy.socketPath,other.url.href)]);expect(results).toEqual([302,403]);expect(f.asks()).toBe(1);expect(safetyProjection(f.db,"turn-voyage","voyage").unresolvedCount).toBe(1);}finally{other.stop(true);await f.close();}
});
test("an explicitly reviewed tunnel matches its opaque authority without asserting HTTPS",async()=>{
 const f=await fixture(true);try{f.t.live.read().rules[0]!.selector={kind:"tunnel_authority",host:"127.0.0.1",port:f.origin.port!};await f.taint();
  const status=await new Promise<number>((resolve,reject)=>{const c=connect(f.proxy.socketPath);c.on("error",reject);c.on("connect",()=>c.write(`CONNECT 127.0.0.1:${f.origin.port} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n`));c.on("data",b=>{resolve(Number(/^HTTP\/1.1 (\d+)/.exec(b.toString())?.[1]));c.destroy();});});expect(status).toBe(200);expect(f.asks()).toBe(0);
  const event=queryGovernanceEvents(f.db,{kinds:["taint"],limit:10}).find(e=>(e.payload as any).source==="egress_connection");expect(event?.payload).toMatchObject({occurrence:{provenance:{kind:"tunnel_authority"},admission:{trusted:true}}});
  expect(await get(f.proxy.socketPath,f.origin.url.href)).toBe(403);expect(f.asks()).toBe(1);
 }finally{await f.close();}
});

test("recipient removal during outward approval cannot carry the old rule across the wait",async()=>{
 const f=await fixture(true,{schema_version:1,outward:{hosts:["127.0.0.1"]}});let entered!:()=>void,release!:()=>void;const reached=new Promise<void>(r=>{entered=r;}),held=new Promise<void>(r=>{release=r;});
 try{f.t.live.read().rules[0]!.incomingContent=false;await f.taint();let asks=0;f.decide(async()=>{if(++asks===1){entered();await held;return {behavior:"allow"};}return {behavior:"deny",message:"Athena declines the new taint card"};});
 const pending=get(f.proxy.socketPath,f.origin.url.href);await reached;f.t.remove();release();expect(await pending,"RECIPIENT_REMOVAL_REVALIDATES_AFTER_OUTWARD_WAIT").toBe(403);expect(asks,"STALE_OUTWARD_CARD_TERMINATES_WITHOUT_AUTOMATIC_REPROMPT").toBe(1);expect(f.hits()).toBe(0);
 }finally{release();await f.close();}
});
test("removing incoming trust leaves its historical decision and makes a later input independently unresolved",async()=>{
 const f=await fixture();try{expect(await get(f.proxy.socketPath,f.origin.url.href)).toBe(200);await f.proxy.settled();f.t.remove();expect(await get(f.proxy.socketPath,f.origin.url.href)).toBe(200);await f.proxy.settled();expect(safetyProjection(f.db,"turn-voyage","voyage").unresolvedCount,"REMOVAL_APPLIES_ONLY_TO_FUTURE_INPUT").toBe(1);const rows=queryGovernanceEvents(f.db,{kinds:["taint"],limit:10});expect(rows.map(e=>(e.payload as any).occurrence.admission.trusted).sort()).toEqual([false,true]);}finally{await f.close();}
});

test("review: an approved card cannot survive independent input during its occurrence write",async()=>{
 const f=await fixture(false,{schema_version:1},undefined,true);let entered!:()=>void,release!:()=>void;const reached=new Promise<void>(r=>{entered=r;}),held=new Promise<void>(r=>{release=r;});const original=f.writes.firstTaint;
 try{await f.taint();f.decide(async()=>({behavior:"allow"}));f.writes.firstTaint=async(...args)=>{if(args[0].payload.source==="egress_connection"){entered();await held;}return original(...args);};
 const pending=get(f.proxy.socketPath,f.origin.url.href);await reached;await f.taint();release();expect(await pending,"STALE_APPROVAL_AFTER_INDEPENDENT_WRITE_REFUSES_DISPATCH").toBe(403);expect(f.hits()).toBe(0);
 }finally{release();await f.close();}
});
for(const trusted of [false,true])test(`review: a card remains usable across only its own durable occurrence write (trusted ${trusted})`,async()=>{
 const f=await fixture(false,{schema_version:1},undefined,true);try{if(!trusted)f.t.live.read().rules[0]!.selector={kind:"web_origin",scheme:"http",host:"ithaca.invalid",port:f.origin.port!};await f.taint();f.decide(async()=>({behavior:"allow"}));expect(await get(f.proxy.socketPath,f.origin.url.href),"OWN_OCCURRENCE_DOES_NOT_WITHDRAW_APPROVAL").toBe(200);}finally{await f.close();}
});
for(const tunnel of [false,true])test(`review: managed HTTPS recipient uses actual transport identity (tunnel ${tunnel})`,async()=>{
 const f=await fixture(true);try{await f.taint();f.t.live.read().rules[0]!.selector=tunnel?{kind:"tunnel_authority",host:"github.com",port:443}:{kind:"web_origin",scheme:"https",host:"github.com",port:443};
 const op=f.proxy.managedReference(new URL("https://github.com/"),new AbortController().signal);const allowed=await op.admit();expect(allowed,"MANAGED_HTTPS_NEVER_BORROWS_OPAQUE_TUNNEL_PERMISSION").toBe(!tunnel);op.finish(allowed?"completed":"denied");await f.proxy.settled();if(allowed)expect(queryGovernanceEvents(f.db,{kinds:["egress_connection"],limit:10})[0]?.payload,"MANAGED_RECIPIENT_DECISION_RETAINS_AUDIT").toMatchObject({managedReference:true,standingRecipient:true,recipientAdmission:{ruleId:"ithaca"}});
 }finally{await f.close();}
});
test("review: outward cards cannot survive independent input even on a taint-allowlisted host",async()=>{
 const f=await fixture(false,{schema_version:1,taint:{egress:{allow:["127.0.0.1"]}},outward:{hosts:["127.0.0.1"]}},undefined,true);let entered!:()=>void,release!:()=>void;const reached=new Promise<void>(r=>{entered=r;}),held=new Promise<void>(r=>{release=r;});const original=f.writes.firstTaint;
 try{await f.taint();f.decide(async()=>({behavior:"allow"}));f.writes.firstTaint=async(...args)=>{if(args[0].payload.source==="egress_connection"){entered();await held;}return original(...args);};const pending=get(f.proxy.socketPath,f.origin.url.href);await reached;await f.taint();release();expect(await pending,"STALE_OUTWARD_CARD_CANNOT_BORROW_TAINT_ALLOWLIST").toBe(403);expect(f.hits()).toBe(0);}finally{release();await f.close();}
});
test("review: independent pending input also withdraws a card on a permanently restricted turn",async()=>{
 const f=await fixture(false,{schema_version:1},undefined,true);let entered!:()=>void,release!:()=>void;const reached=new Promise<void>(r=>{entered=r;}),held=new Promise<void>(r=>{release=r;});const original=f.writes.firstTaint;let slow:Promise<unknown>|undefined,pendingTaint:Promise<unknown>|undefined;
 try{f.db.query("UPDATE safety_collections SET restricted_begin=1,gap='uninstrumented_backend_input' WHERE turn_id='turn-voyage'").run();await f.taint();f.decide(async()=>({behavior:"allow"}));
  f.writes.firstTaint=async(...args)=>{const result=await original(...args);if(args[0].payload.source==="egress_connection"){entered();await held;}return result;};
  const pending=get(f.proxy.socketPath,f.origin.url.href);await reached;const probe=await import('./fixtures/write-worker-probe');const channel=f.writer!.channel(probe,{table:'origin_pending_hold'});await channel.ready;const active=new Int32Array(new SharedArrayBuffer(4));slow=channel.call('slow','Calypso',400,active);await Atomics.waitAsync(active,0,0).value;
  pendingTaint=f.taint();expect(f.writes.safety('turn-voyage','voyage').pendingCount).toBeGreaterThan(0);release();expect(await pending,'PENDING_INPUT_WITHDRAWS_CARD_WITHOUT_NORMALIZING_AWAY_OTHER_SIGNALS').toBe(403);expect(f.hits()).toBe(0);
 }finally{release();await slow;await pendingTaint;await f.close();}
});
test("review2: a later revision cannot join a hostname's earlier pending Network card",async()=>{
 const f=await fixture();const answers:Array<(v:PermissionDecision)=>void>=[];let firstReady!:()=>void,secondReady!:()=>void;const firstCard=new Promise<void>(r=>{firstReady=r;}),secondRequest=new Promise<void>(r=>{secondReady=r;});let first:Promise<number>|undefined,second:Promise<number>|undefined;const safety=f.bridge.admissionSafety!,read=safety.read;
 try{delete f.bridge.admissionSafety;await f.taint();f.decide(()=>new Promise(r=>{answers.push(r);firstReady();}));first=get(f.proxy.socketPath,f.origin.url.href);await firstCard;await f.taint();let announced=false;safety.read=()=>{const value=read();if(!announced){announced=true;queueMicrotask(secondReady);}return value;};second=get(f.proxy.socketPath,f.origin.url.href);await secondRequest;
 const cards=f.asks();answers[0]!({behavior:'allow'});expect(await first).toBe(403);if(cards===1){expect(await second,'OLDER_CARD_ANSWER_CANNOT_DISPATCH_A_LATER_CONTEXT').toBe(403);}else{expect(f.hits()).toBe(0);answers[1]!({behavior:'deny',message:'Athena declines the new context'});expect(await second).toBe(403);}expect(cards,'NEW_EVIDENCE_REQUIRES_A_NEW_NETWORK_CARD').toBe(2);
 }finally{f.bridge.admissionSafety=safety;safety.read=read;for(const answer of answers)answer({behavior:'deny',message:'Closed'});await Promise.allSettled([first,second]);await f.close();}
});
for(const pruned of [false,true])test(`review2: forks inherit unresolved input only, regardless of pruning (${pruned})`,async()=>{
 const f=await fixture();try{expect(await get(f.proxy.socketPath,f.origin.url.href)).toBe(200);await f.proxy.settled();if(pruned)pruneSafetyDetail(f.db,Number.MAX_SAFE_INTEGER);expect(f.writes.safety(null,'voyage').unresolvedCount).toBe(0);
 await f.writes.safetyBegin({turnId:'fork-trusted',bindingId:crypto.randomUUID(),sessionId:null,principalId:'odysseus',backendId:'claude',sourceSessionId:'voyage',at:2});expect(f.writes.safety('fork-trusted',null).unresolvedCount,'FORK_NEVER_TURNS_TRUSTED_INPUT_INTO_AN_UNRESOLVED_SIGNAL').toBe(0);expect(f.writes.safety('fork-trusted',null).restriction).toBe('restricted');
 await f.taint();if(pruned)pruneSafetyDetail(f.db,Number.MAX_SAFE_INTEGER);await f.writes.safetyBegin({turnId:'fork-unresolved',bindingId:crypto.randomUUID(),sessionId:null,principalId:'odysseus',backendId:'claude',sourceSessionId:'voyage',at:3});expect(f.writes.safety('fork-unresolved',null).unresolvedCount).toBe(1);
 }finally{await f.close();}
});
test('review2: unchanged context still shares one pending destination card',async()=>{
 const f=await fixture();const answers:Array<(v:PermissionDecision)=>void>=[];let firstReady!:()=>void,secondReady!:()=>void;const firstCard=new Promise<void>(r=>{firstReady=r;}),secondRequest=new Promise<void>(r=>{secondReady=r;});let first:Promise<number>|undefined,second:Promise<number>|undefined;const safety=f.bridge.admissionSafety!,read=safety.read;
 try{await f.taint();f.decide(()=>new Promise(r=>{answers.push(r);firstReady();}));first=get(f.proxy.socketPath,f.origin.url.href);await firstCard;let announced=false;safety.read=()=>{const value=read();if(!announced){announced=true;queueMicrotask(secondReady);}return value;};second=get(f.proxy.socketPath,f.origin.url.href);await secondRequest;expect(f.asks(),'UNCHANGED_CONTEXT_COALESCES_ONE_PENDING_CARD').toBe(1);answers[0]!({behavior:'deny',message:'Athena declines'});expect(await first).toBe(403);expect(await second).toBe(403);
 }finally{safety.read=read;for(const answer of answers)answer({behavior:'deny',message:'Closed'});await Promise.allSettled([first,second]);await f.close();}
});

test('review3: managed HTTPS and opaque CONNECT never share a pending Network card',async()=>{
 const f=await fixture();const answers:Array<(v:PermissionDecision)=>void>=[];let firstReady!:()=>void,secondReady!:()=>void;const firstCard=new Promise<void>(r=>{firstReady=r;}),secondRequest=new Promise<void>(r=>{secondReady=r;});const safety=f.bridge.admissionSafety!,read=safety.read;
 let socket:ReturnType<typeof connect>|undefined,managed:Promise<boolean>|undefined,tunnel:Promise<number>|undefined;
 try{await f.taint();f.decide(()=>new Promise(r=>{answers.push(r);firstReady();}));const op=f.proxy.managedReference(new URL("https://github.com/"),new AbortController().signal);managed=op.admit();await firstCard;
 let announced=false;safety.read=()=>{const value=read();if(!announced){announced=true;queueMicrotask(secondReady);}return value;};
 tunnel=new Promise<number>((resolve,reject)=>{socket=connect(f.proxy.socketPath);socket.on('error',reject);socket.on('connect',()=>socket!.write(`CONNECT github.com:443 HTTP/1.1\r\nHost: github.com\r\n\r\n`));socket.on('data',b=>{resolve(Number(/^HTTP\/1.1 (\d+)/.exec(b.toString())?.[1]));socket!.destroy();});});await secondRequest;
 const cards=f.asks();for(const answer of answers)answer({behavior:'deny',message:'Athena declines'});expect(await managed).toBe(false);op.finish('denied');expect(await tunnel).toBe(403);expect(cards,'MANAGED_AND_OPAQUE_TRANSPORTS_REQUIRE_DISTINCT_CARDS').toBe(2);
 }finally{safety.read=read;for(const answer of answers)answer({behavior:'deny',message:'Closed'});socket?.destroy();await Promise.allSettled([managed,tunnel]);await f.close();}
});
