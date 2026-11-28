import { createEffectiveSafety } from "../src/governance/effective-safety.js";
import { Database } from "bun:sqlite";
import { watchdogMs } from "../../../scripts/test-deadlines.js";
import { expect, test, spyOn } from "bun:test";
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
import { originTrustMatchSnapshot, type OriginTrust } from "../src/brain/origin-trust.js";
import { connectedSafetySession } from "./helpers/connected-safety.js";
function get(socketPath: string, target: string): Promise<number> {
  return new Promise((resolve, reject) => { const r = request({ socketPath, path: target }, response => {
    response.resume(); response.once("end", () => resolve(response.statusCode!)); response.once("error", reject);
  }); r.once("error", reject); r.end(); });
}
function trust(rule: TrustRule) {
  let revision = "1", rules = [rule], policyHash="a".repeat(64),ruleInstances:Record<string,string>={[rule.id]:"1"}; const listeners = new Set<() => void>();
  const live: OriginTrust = { revision: () => revision, read: () => ({revision,rules,policyHash,ruleInstances}), subscribe: cb => {listeners.add(cb);return () => {listeners.delete(cb);};} };
  return { live, publish(next:TrustRule[]) {const old=new Map(rules.map(r=>[r.id,JSON.stringify([r.selector,r.incomingContent])]));revision=String(BigInt(revision)+1n);ruleInstances=Object.fromEntries(next.map(r=>[r.id,old.get(r.id)===JSON.stringify([r.selector,r.incomingContent])?ruleInstances[r.id]??revision:revision]));rules=next;policyHash=revision.padStart(64,"0");for(const cb of listeners)cb();}, remove(notify=true) { rules=[];ruleInstances={};revision=String(BigInt(revision)+1n);policyHash="b".repeat(64);if(notify)for(const cb of listeners)cb(); } };
}
async function fixture(recipient = false, policy: GovernancePolicyInput = {schema_version:1}, response?: () => Response, full = false, listenHost = "127.0.0.1", legacy = false) {
  const root=full?mkdtempSync(join(tmpdir(),"odysseus-origin-trust-")):null;
  const db = createUiDb(root?join(root,"ui.db"):":memory:"); connectedSafetySession(db,"voyage","turn-voyage");
  const writer=full?openSqliteWriter(db):undefined;
  const writes = createGovernanceWrites(db,writer); let asks = 0, hits = 0;
  let decide: BackendBridge["requestPermission"] = async () => ({behavior:"deny",message:"Athena declines"});
  // How the host reports a denied card: an owner denial unless a test says it was withdrawn.
  let refusal: (toolUseId: string) => false | "superseded" | "expired" | "unconfirmed" = () => false;
  const origin = Bun.serve({hostname:listenHost,port:0,fetch(){hits++;return response?.() ?? new Response("Ithaca");}});
  const rule: TrustRule = {id:"ithaca",label:"Ithaca",incomingContent:true,recipientWhileRestricted:recipient,
    selector:{kind:"web_origin",scheme:"http",host:origin.url.hostname,port:origin.port!}};
  const t=trust(rule);const controller=new AbortController();
  const bridge={emit(){},requestPermission:async(...args: Parameters<BackendBridge["requestPermission"]>)=>{asks++;return decide(...args);},admissionSafety:createEffectiveSafety(db,{turnId:"turn-voyage",sessionId:()=>"voyage",policyHash:null,writes,trust:t.live,authority:()=>({current:true,epoch:"0"})})} as unknown as BackendBridge;
  const proxy=await prepareTurnEgress({policy:resolveGovernancePolicy(policy),trust:t.live,controller,turnId:"turn-voyage",sessionId:()=>"voyage",model:()=>null,profile:"governed",origin:"interactive",governanceDb:db,governanceWrites:legacy?undefined:writes,record:legacy?event=>writes.record(event):writes.record,
    networkRefusal:toolUseId=>refusal(toolUseId),bridge});
  const epoch=(db.query("SELECT id FROM safety_collections WHERE turn_id='turn-voyage'").get() as {id:string}).id;
  const taint=()=>writes.firstTaint({kind:"taint",turnId:"turn-voyage",sessionId:"voyage",actor:"interactive",profile:"governed",model:null,payload:{source:"web_search",tool:null,detail:null,occurrence:occurrence(epoch,"tool_web_input",crypto.randomUUID(),"finalized")}});
  return {db,writes,writer,origin,proxy,t,taint,controller,bridge,decide(value: BackendBridge["requestPermission"]) { decide=value; },refuse(value: typeof refusal) { refusal=value; },asks:()=>asks,hits:()=>hits,async close(){proxy.stop();origin.stop(true);await proxy.settled();await writer?.close();db.close();if(root)rmSync(root,{recursive:true,force:true});}};
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
  f.t.live.read().rules[0]!.selector={kind:"web_origin",scheme:"http",host:"localhost",port:f.origin.port!};
  expect(await get(f.proxy.socketPath,`http://sub.localhost:${f.origin.port}/`)).toBe(403);
  expect(f.asks(),"SUBDOMAIN_REQUIRES_ITS_OWN_CARD").toBe(2);
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
 const op=f.proxy.managedReference(new URL("https://github.com/"),new AbortController().signal);const allowed=await op.admit();if(allowed)expect(op.dispatch(()=>{})).toEqual({ok:true});expect(allowed,"MANAGED_HTTPS_NEVER_BORROWS_OPAQUE_TUNNEL_PERMISSION").toBe(!tunnel);op.finish(allowed?"completed":"denied");await f.proxy.settled();if(allowed)expect(queryGovernanceEvents(f.db,{kinds:["egress_connection"],limit:10})[0]?.payload,"MANAGED_RECIPIENT_DECISION_RETAINS_AUDIT").toMatchObject({managedReference:true,standingRecipient:true,recipientAdmission:{ruleId:"ithaca"}});
 }finally{await f.close();}
});
test("review: outward cards cannot survive independent input even on a taint-allowlisted host",async()=>{
 const f=await fixture(false,{schema_version:1,taint:{egress:{allow:["127.0.0.1"]}},outward:{hosts:["127.0.0.1"]}},undefined,true);let entered!:()=>void,release!:()=>void;const reached=new Promise<void>(r=>{entered=r;}),held=new Promise<void>(r=>{release=r;});const original=f.writes.firstTaint;
 try{await f.taint();f.decide(async()=>({behavior:"allow"}));f.writes.firstTaint=async(...args)=>{if(args[0].payload.source==="egress_connection"){entered();await held;}return original(...args);};const pending=get(f.proxy.socketPath,f.origin.url.href);await reached;await f.taint();release();expect(await pending,"STALE_OUTWARD_CARD_CANNOT_BORROW_TAINT_ALLOWLIST").toBe(403);expect(f.hits()).toBe(0);}finally{release();await f.close();}
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

for(const phase of ['none','card','commit'] as const)test(`shared Network card with real FULL writer excludes only peer reservations (independent ${phase})`,async()=>{
 const f=await fixture(false,{schema_version:1},undefined,true);const independent=phase!=='none';
 const committed=Promise.withResolvers<void>(),releaseAdmissions=Promise.withResolvers<void>();let commits=0;
 const card=Promise.withResolvers<void>(),answer=Promise.withResolvers<PermissionDecision>(),secondEntered=Promise.withResolvers<void>();
 const safety=f.bridge.admissionSafety!,read=safety.read.bind(safety),firstTaint=f.writes.firstTaint;
 const otherDb=new Database(f.db.filename),otherWriter=openSqliteWriter(otherDb),otherWrites=createGovernanceWrites(f.db,otherWriter);
 const gate=new Int32Array(new SharedArrayBuffer(4)),entered=new Int32Array(new SharedArrayBuffer(4));
 let held:Promise<unknown>|undefined,pendingInput:Promise<unknown>|undefined,first:Promise<number>|undefined,second:Promise<number>|undefined,peak=0;
 try{
  await f.taint();
  f.writes.firstTaint=(...args)=>{const pending=firstTaint(...args);peak=Math.max(peak,f.writes.safety('turn-voyage','voyage').pendingCount);return phase==='commit'?pending.then(async result=>{if(++commits===2)committed.resolve();await releaseAdmissions.promise;return result;}):pending;};
  f.decide(()=>{card.resolve();return answer.promise;});first=get(f.proxy.socketPath,f.origin.url.href);await card.promise;
  let announced=false;safety.read=(...args)=>{const state=read(...args);if(!announced){announced=true;queueMicrotask(secondEntered.resolve);}return state;};
  second=get(f.proxy.socketPath,`${f.origin.url.href}again`);await secondEntered.promise;safety.read=read;
  expect(f.asks(),'REAL_WRITER_PEERS_SHARE_EXACTLY_ONE_CARD').toBe(1);
  if(phase==='commit'){answer.resolve({behavior:'allow'});await committed.promise;}
  if(independent){
   const probe=await import('./fixtures/pending-safety-writer');const channel=otherWriter.channel(probe,undefined);await channel.ready;
   held=channel.call('hold',entered,gate,watchdogMs(15000));
   if(!Atomics.load(entered,0))await Atomics.waitAsync(entered,0,0,watchdogMs(15000)).value;
   expect(Atomics.load(entered,0),'INDEPENDENT_WRITER_IS_HELD_WITHOUT_BLOCKING_PEERS').toBe(1);
   pendingInput=otherWrites.firstTaint({kind:'taint',turnId:'turn-voyage',sessionId:'voyage',actor:'interactive',profile:'governed',model:null,payload:{source:'web_search',tool:null,detail:'Odysseus reads a separate harbour notice'}});
   expect(f.writes.safety('turn-voyage','voyage').pendingCount).toBe(1);
  }
  answer.resolve({behavior:'allow'});releaseAdmissions.resolve();
  expect(await Promise.all([first,second]),independent?'INDEPENDENT_PENDING_INPUT_IS_NOT_A_CARD_PEER':'APPROVED_FULL_WRITER_PEERS_BOTH_DISPATCH').toEqual(independent?[403,403]:[200,200]);
  expect(f.hits()).toBe(independent?0:2);
  if(!independent)expect(peak,'REAL_PEER_WRITE_RESERVATIONS_OVERLAPPED').toBeGreaterThanOrEqual(2);
  await f.proxy.settled();
  const rows=queryGovernanceEvents(f.db,{kinds:['egress_connection'],limit:10});expect(rows).toHaveLength(2);
  for(const row of rows)expect(row.payload).toMatchObject(independent?{outcome:'denied',dispatched:false}:{outcome:'completed',dispatched:true});
 }finally{
  safety.read=read;answer.resolve({behavior:'deny',message:'Athena closes the fixture'});releaseAdmissions.resolve();Atomics.store(gate,0,1);Atomics.notify(gate,0);
  await Promise.allSettled([held,pendingInput,first,second]);await otherWriter.close();otherDb.close();await f.close();
 }
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


test('review4: IPv6 Settings selector reaches an exact real opaque tunnel',async()=>{
 const f=await fixture(true,{schema_version:1},undefined,false,'::1');try{await f.taint();f.t.live.read().rules[0]!.selector={kind:'tunnel_authority',host:'[::1]',port:f.origin.port!};
 const status=await new Promise<number>((resolve,reject)=>{const c=connect(f.proxy.socketPath);c.on('error',reject);c.on('connect',()=>c.write(`CONNECT [::1]:${f.origin.port} HTTP/1.1\r\nHost: [::1]\r\n\r\n`));c.on('data',b=>{resolve(Number(/^HTTP\/1.1 (\d+)/.exec(b.toString())?.[1]));c.destroy();});});expect(status,'EXPLICIT_IPV6_TUNNEL_IS_ENFORCED').toBe(200);expect(f.asks()).toBe(0);
 }finally{await f.close();}
});
test('review4: exact DNS parent never authorizes its subdomain',()=>{
 const t=trust({id:'ithaca',label:'Ithaca',incomingContent:true,recipientWhileRestricted:true,selector:{kind:'web_origin',scheme:'https',host:'ithaca.example.org',port:443}});
 const destination={host:'ithaca.example.org',port:443,method:'GET',protocol:'https:'};
 expect(originTrustMatchSnapshot(t.live.read(),destination,'recipientWhileRestricted','0')).not.toBeNull();
 expect(originTrustMatchSnapshot(t.live.read(),{...destination,host:'sub.ithaca.example.org'},'recipientWhileRestricted','0'),'DNS_SUBDOMAIN_NEVER_INHERITS_PARENT_TRUST').toBeNull();
});

test('review6: explicit recipient approval survives independently of a source-only rule',async()=>{
 const f=await fixture();try{await f.taint();f.decide(async()=>({behavior:'allow'}));expect(await get(f.proxy.socketPath,f.origin.url.href)).toBe(200);await f.proxy.settled();f.decide(async()=>({behavior:'deny',message:'No second card should appear'}));
 expect(await get(f.proxy.socketPath,f.origin.url.href),'EXPLICIT_RECIPIENT_APPROVAL_SURVIVES_SOURCE_TRUST').toBe(200);expect(f.asks()).toBe(1);const {contactedHosts}=await import('../src/governance/session-taint');expect(contactedHosts(f.db,'voyage'),'EXPLICIT_RECIPIENT_APPROVAL_IS_DURABLE').toContain('127.0.0.1');
 }finally{await f.close();}
});


for(const restricted of [false,true])test(`review7: streaming counters avoid history scans (restricted ${restricted})`,async()=>{
 const f=await fixture();try{if(restricted)await f.taint();f.decide(async()=>({behavior:'allow'}));const op=f.proxy.managedReference(new URL('https://github.com/'),new AbortController().signal);expect(await op.admit()).toBe(true);
 const query=f.db.query.bind(f.db);let scans=0;const spy=spyOn(f.db,'query').mockImplementation(((...args:Parameters<typeof f.db.query>)=>{if(String(args[0]).includes('FROM safety_records'))scans++;return Reflect.apply(query,f.db,args);}) as typeof f.db.query);
 try{expect(op.charge(1).ok).toBe(true);scans=0;for(let i=0;i<32;i++)expect(op.charge(1).ok).toBe(true);expect(scans,'STABLE_APPROVED_CHUNKS_NEVER_SCAN_HISTORY').toBe(0);await f.taint();expect(op.charge(1).ok,'NEW_INPUT_STILL_WITHDRAWS_CACHED_APPROVAL').toBe(false);}finally{spy.mockRestore();op.finish('cancelled');}
 }finally{await f.close();}
});


test('review7: provisional safety reads never survive a rolled-back transaction',async()=>{
 const f=await fixture();try{await f.taint();const safety=f.bridge.admissionSafety!;expect(safety.read().restricted).toBe(true);
 expect(()=>f.db.transaction(()=>{f.db.exec('DELETE FROM safety_records');expect(safety.read().restricted).toBe(false);throw new Error('Odysseus rolls back');})()).toThrow('Odysseus rolls back');
 expect(safety.read().restricted,'ROLLED_BACK_INPUT_NEVER_REUSES_PROVISIONAL_SAFETY').toBe(true);
 }finally{await f.close();}
});


test('review8: unmatched input after removal records the current policy hash and revision',async()=>{
 const f=await fixture();try{f.t.remove();expect(await get(f.proxy.socketPath,f.origin.url.href)).toBe(200);await f.proxy.settled();const events=queryGovernanceEvents(f.db,{kinds:['taint'],limit:10});expect(events[0]?.payload,'UNMATCHED_ADMISSION_USES_ONE_LIVE_POLICY_SNAPSHOT').toMatchObject({occurrence:{admission:{trusted:false,policyHash:'b'.repeat(64),trustRevision:'2'}}});}finally{await f.close();}
});


for(const change of ['remove','replace','disable'] as const)test(`review11: an unrelated recipient edit keeps a real trusted source stream until ${change}`,async()=>{
 let stream!:ReadableStreamDefaultController<Uint8Array>;const f=await fixture(false,{schema_version:1},()=>new Response(new ReadableStream<Uint8Array>({start(c){stream=c;c.enqueue(new TextEncoder().encode('first'));}})));let first!:()=>void,second!:()=>void;const received=new Promise<void>(r=>{first=r;}),later=new Promise<void>(r=>{second=r;});let text='';
 const closed=new Promise<void>((resolve,reject)=>{const r=request({socketPath:f.proxy.socketPath,path:f.origin.url.href},response=>{response.on('data',b=>{text+=b;first();if(text.includes('second'))second();});response.on('close',resolve);response.on('error',()=>resolve());});r.on('error',reject);r.end();});
 try{await received;const source=f.t.live.read().rules[0]!;f.t.publish([source,{...source,id:'troy-recipient',incomingContent:false,recipientWhileRestricted:true,selector:{kind:'web_origin',scheme:'https',host:'troy.example.org',port:443}}]);try{stream.enqueue(new TextEncoder().encode('second'));}catch{}
 expect(await Promise.race([later.then(()=>true),closed.then(()=>false)]),'UNRELATED_RECIPIENT_EDIT_NEVER_REVOKES_SOURCE_INPUT').toBe(true);if(change==='remove')f.t.remove();else f.t.publish([{...source,...(change==='replace'?{id:'replacement-source'}:{incomingContent:false,recipientWhileRestricted:true})}]);await f.proxy.settled();expect(queryGovernanceEvents(f.db,{kinds:['egress_connection'],limit:10})[0]?.payload,'SOURCE_RULE_REPLACEMENT_NEVER_BORROWS_TRUST').toMatchObject({reason:'source_trust_changed'});await closed;expect(text).toBe('firstsecond');expect(f.controller.signal.aborted).toBe(false);expect(queryGovernanceEvents(f.db,{kinds:['taint'],limit:10})[0]?.payload).toMatchObject({occurrence:{admission:{trusted:true,ruleId:'ithaca',trustRevision:'1',policyHash:'a'.repeat(64)}}});
 }finally{await f.close();}
});


test('review11: unrelated trust publication during occurrence COMMIT keeps the same source admission',async()=>{
 const f=await fixture(false,{schema_version:1},undefined,true);const original=f.writes.firstTaint;let entered!:()=>void,release!:()=>void;const reached=new Promise<void>(r=>{entered=r;}),held=new Promise<void>(r=>{release=r;});f.writes.firstTaint=async(...args)=>{entered();await held;return original(...args);};
 try{const pending=get(f.proxy.socketPath,f.origin.url.href);await reached;const source=f.t.live.read().rules[0]!;f.t.publish([source,{...source,id:'troy-recipient',incomingContent:false,recipientWhileRestricted:true,selector:{kind:'web_origin',scheme:'https',host:'troy.example.org',port:443}}]);release();expect(await pending,'UNRELATED_REVISION_DURING_COMMIT_KEEPS_SOURCE').toBe(200);expect(f.hits()).toBe(1);expect(f.proxy.recordingFailure()).toBeUndefined();}finally{release();await f.close();}
});


for(const order of ['notification','chunk','post-write'] as const)test(`review12: source removal audit is identical when first detected by ${order}`,async()=>{
 let stream:ReadableStreamDefaultController<Uint8Array>|undefined,first!:()=>void,release!:()=>void;const received=new Promise<void>(r=>{first=r;});const f=await fixture(false,{schema_version:1},order==='post-write'?undefined:()=>new Response(new ReadableStream<Uint8Array>({start(c){stream=c;c.enqueue(new TextEncoder().encode('first'));}})),order==='post-write');
 let pending:Promise<unknown>|undefined;
 try{if(order==='post-write'){const original=f.writes.firstTaint,held=new Promise<void>(r=>{release=r;});f.writes.firstTaint=async(...args)=>{first();await held;return original(...args);};pending=get(f.proxy.socketPath,f.origin.url.href).catch(()=>0);await received;f.t.remove(false);release();await pending;}else{pending=new Promise<void>((resolve,reject)=>{const r=request({socketPath:f.proxy.socketPath,path:f.origin.url.href},response=>{response.on('data',()=>first());response.on('close',resolve);response.on('error',()=>resolve());});r.on('error',reject);r.end();});await received;f.t.remove(order==='notification');if(order==='chunk')try{stream!.enqueue(new TextEncoder().encode('second'));}catch{}await pending;}
 await f.proxy.settled();expect(queryGovernanceEvents(f.db,{kinds:['egress_connection'],limit:10})[0]?.payload,'EVERY_SOURCE_REMOVAL_ORDER_HAS_ONE_AUDIT_CLASS').toMatchObject({outcome:'cancelled',reason:'source_trust_changed',trustedSource:true,method:'GET'});expect(f.controller.signal.aborted).toBe(false);
 }finally{release?.();f.proxy.stop();await pending;await f.close();}
});

for(const change of ['end','opaque'] as const)test(`review15: outward covering-call ${change} during occurrence write fences dispatch`,async()=>{
 const f=await fixture(false,{schema_version:1,outward:{hosts:['127.0.0.1']}},undefined,true);let entered!:()=>void,release!:()=>void;const reached=new Promise<void>(r=>{entered=r;}),held=new Promise<void>(r=>{release=r;});const original=f.writes.firstTaint;
 try{f.proxy.bridge.activity?.({kind:'outward_classification',toolUseId:'voyage',classification:{kind:'read',actions:[]},decision:'allow'});f.writes.firstTaint=async(...args)=>{entered();await held;return original(...args);};const pending=get(f.proxy.socketPath,f.origin.url.href);await reached;if(change==='end')f.proxy.bridge.emit({type:'tool_result',toolUseId:'voyage',output:'Ithaca',isError:false});else f.proxy.bridge.activity?.({kind:'outward_classification',toolUseId:'opaque',classification:{kind:'unknown',actions:[],opaque:true},decision:'allow'});release();expect(await pending,'EXPIRED_OUTWARD_COVERAGE_NEVER_DISPATCHES').toBe(403);expect(f.hits()).toBe(0);}finally{release();await f.close();}
});

test('review15: unrelated call changes do not withdraw an explicit Network card',async()=>{
 const f=await fixture(false,{schema_version:1},undefined,true);let entered!:()=>void,release!:()=>void;const reached=new Promise<void>(r=>{entered=r;}),held=new Promise<void>(r=>{release=r;});const original=f.writes.firstTaint;
 try{await f.taint();f.decide(async()=>({behavior:'allow'}));f.proxy.bridge.activity?.({kind:'outward_classification',toolUseId:'voyage',classification:{kind:'read',actions:[]},decision:'allow'});f.writes.firstTaint=async(...args)=>{entered();await held;return original(...args);};const pending=get(f.proxy.socketPath,f.origin.url.href);await reached;f.proxy.bridge.emit({type:'tool_result',toolUseId:'voyage',output:'Ithaca',isError:false});release();expect(await pending,'NETWORK_APPROVAL_IS_INDEPENDENT_OF_OUTWARD_CALL_LIFETIME').toBe(200);expect(f.hits()).toBe(1);}finally{release();await f.close();}
});

test('review16: terminal cleanup releases both suffixed per-connection approval keys',async()=>{
 const seen:Array<{map:Map<unknown,unknown>;key:string}>=[];const original=Map.prototype.set;const spy=spyOn(Map.prototype,'set').mockImplementation(function(this:Map<unknown,unknown>,key:unknown,value:unknown){if(typeof key==='string'&&/^[a-f0-9-]+:(network|outward)$/.test(key)&&typeof value==='object'&&value!==null&&'marker' in value)seen.push({map:this,key});return original.call(this,key,value);});const f=await fixture(false,{schema_version:1,outward:{hosts:['127.0.0.1']}});
 try{await f.taint();f.decide(async()=>({behavior:'allow'}));for(let i=0;i<8;i++){expect(await get(f.proxy.socketPath,f.origin.url.href)).toBe(200);await f.proxy.settled();}for(const kind of ['network','outward']){const keys=seen.filter(({key})=>key.endsWith(':'+kind));expect(keys.length,'APPROVAL_KEY_EXERCISED_'+kind).toBeGreaterThan(0);for(const {map,key} of keys)expect(map.has(key),'TERMINAL_OWNER_RELEASES_'+kind+'_APPROVAL_KEY').toBe(false);}}finally{spy.mockRestore();await f.close();}
});

test('review16: terminal owner joins the real occurrence write before cleanup',async()=>{
 const f=await fixture(false,{schema_version:1},undefined,true);let entered!:()=>void,release!:()=>void;const reached=new Promise<void>(r=>{entered=r;}),held=new Promise<void>(r=>{release=r;});const original=f.writes.firstTaint;
 try{f.t.remove();f.writes.firstTaint=async(...args)=>{entered();await held;return original(...args);};const pending=get(f.proxy.socketPath,f.origin.url.href).catch(()=>0);await reached;f.proxy.stop();release();await pending;await f.proxy.settled();const rows=f.db.query("SELECT state FROM safety_records WHERE kind='exposure'").all() as {state:string}[];expect(rows,'CANCELLED_OCCURRENCE_HAS_DURABLE_TERMINAL_EVIDENCE').toEqual([{state:'interrupted_unknown'}]);expect(queryGovernanceEvents(f.db,{kinds:['egress_connection'],limit:10})).toHaveLength(1);}finally{release();await f.close();}
});

for(const invalid of ['zero port','long host'] as const)test(`review17: ${invalid} cannot poison durable safety history`,async()=>{
 const f=await fixture();const {SafetyHistory}=await import('../src/governance/safety-history');const {safetyPageSchema}=await import('@schlessera/brain-ui-sdk/schemas');const history=new SafetyHistory(f.db,()=>true,()=>f.proxy.settled());
 try{const target=invalid==='zero port'?'http://127.0.0.1:0/':`http://${'ithaca.'.repeat(37)}example.org/`;expect(await get(f.proxy.socketPath,target).catch(()=>0),'INVALID_DESTINATION_IS_REFUSED_LOCALLY').toBe(400);await f.proxy.settled();expect(f.db.query("SELECT count(*) AS n FROM safety_records WHERE kind='occurrence'").get(),'INVALID_DESTINATION_NEVER_ENTERS_DURABLE_HISTORY').toEqual({n:0});expect(await get(f.proxy.socketPath,f.origin.url.href)).toBe(200);await f.proxy.settled();const page=await history.read({id:'odysseus'} as import('../src/db/principals').Principal,{sessionId:'voyage'},null,50,false,true);expect(safetyPageSchema.safeParse(page).success,'STRICT_HISTORY_REMAINS_READABLE_AFTER_BAD_DESTINATION').toBe(true);}finally{history.close();await f.close();}
});

for(const second of [false,true])test(`review17: inference binding loss on ${second?'second':'first'} admission stays unavailable`,async()=>{
 const f=await fixture();const {retainTurnSessionBinding}=await import('../src/ws/bridge-session-binding');const {startInferenceRelay}=await import('../../ui-sdk/src/server/inference-relay');let entered!:()=>void,release!:()=>void;const reached=new Promise<void>(r=>{entered=r;}),held=new Promise<void>(r=>{release=r;});const binding:{pending?:Promise<void>;failed:boolean}={failed:!second};retainTurnSessionBinding(f.bridge,{sessionBinding:binding,current:()=>{if(binding.pending)entered();return true;},host:{},turn:{sessionId:'voyage'},turnId:'turn-voyage'} as unknown as Parameters<typeof retainTurnSessionBinding>[1]);const relay=startInferenceRelay({upstream:f.origin.url.origin,routes:['/v1/messages'],egress:f.proxy,credentials:async()=>{binding.pending=held;return {'x-api-key':'odysseus-key'};}});
 try{const response=new Promise<{status:number;body:string}>((resolve,reject)=>{const r=request({socketPath:relay.socketPath,path:'/v1/messages',method:'POST',headers:{'content-type':'application/json'}},res=>{let body='';res.on('data',b=>{body+=b;});res.on('end',()=>resolve({status:res.statusCode!,body}));});r.on('error',reject);r.end(JSON.stringify({model:'odysseus-model',messages:[]}));});if(second){await reached;binding.failed=true;binding.pending=undefined;release();}const got=await response;expect(got.status,'EVERY_BINDING_ADMISSION_USES_THE_STORED_UNAVAILABLE_REASON').toBe(503);expect(JSON.parse(got.body).error.message,'BINDING_FAILURE_KEEPS_COMPATIBLE_HOST_REFUSAL_TEXT').toBe('Inference network admission refused');expect(f.hits()).toBe(0);}finally{release();await relay.stop();await f.close();}
});

for(const tunnel of [false,true])for(const valid of [false,true])test(`review17: server ${tunnel?'tunnel':'origin'} provenance uses UTF-8 bounds (valid ${valid})`,async()=>{
 const {OccurrenceSchema}=await import('../src/governance/occurrence');const input=occurrence('voyage','proxy_input','odysseus');const host='λ'.repeat(valid?126:127);input.provenance=tunnel?{kind:'tunnel_authority',authority:{host,port:443},verifiedBy:'host_proxy'}:{kind:'web_origin',origin:{scheme:'https',host,port:443},verifiedBy:'host_transport'};expect(OccurrenceSchema.safeParse(input).success,'SERVER_AND_WIRE_PROVENANCE_USE_IDENTICAL_BYTE_LIMITS').toBe(valid);
});

test('review28: recipient receipt uses final dispatch authority after preparation',async()=>{
 const f=await fixture(true,{schema_version:1,taint:{egress:{allow:['github.com']}}});try{
 f.t.publish([{id:'ithaca',label:'Ithaca',incomingContent:false,recipientWhileRestricted:true,selector:{kind:'web_origin',scheme:'https',host:'github.com',port:443}}]);await f.taint();
 const op=f.proxy.managedReference(new URL('https://github.com/'),new AbortController().signal);expect(await op.admit()).toBe(true);expect(op.prepare()).toEqual({ok:true});f.t.remove();expect(op.dispatch(()=>{})).toEqual({ok:true});op.finish('completed');await f.proxy.settled();const payload=queryGovernanceEvents(f.db,{kinds:['egress_connection'],limit:10})[0]?.payload;expect(payload,'REMOVED_RECIPIENT_RULE_NEVER_APPEARS_IN_DISPATCH_RECEIPT').not.toHaveProperty('standingRecipient');expect(payload).not.toHaveProperty('recipientAdmission');
 }finally{await f.close();}
});

test('review31: a permanent gap never substitutes for a durable trusted occurrence',async()=>{
 const f=await fixture(true,{schema_version:1},undefined,true);const outcomes:boolean[]=[];const original=f.writes.firstTaint;
 try{f.db.query("UPDATE safety_collections SET restricted_begin=1,gap='uninstrumented_backend_input' WHERE turn_id='turn-voyage'").run();f.db.exec("CREATE TRIGGER ithaca_missing_source BEFORE INSERT ON governance_events WHEN NEW.kind='taint' AND json_extract(NEW.payload,'$.source')='egress_connection' BEGIN SELECT RAISE(FAIL,'Odysseus source write unavailable'); END");f.writes.firstTaint=async(...args)=>{const result=await original(...args);outcomes.push(result);return result;};expect(f.writes.recordingAvailable('turn-voyage','voyage')).toBe(true);
 expect(await get(f.proxy.socketPath,f.origin.url.href).catch(()=>0),'TRUST_REQUIRES_CONFIRMED_DURABLE_OCCURRENCE').toBe(503);expect(outcomes).toEqual([false]);expect(f.hits()).toBe(0);await f.proxy.settled();const denied=queryGovernanceEvents(f.db,{kinds:['egress_connection'],limit:10})[0]?.payload;expect(denied).toMatchObject({reason:'egress_unavailable',failureReason:'unavailable',dispatched:false});expect(denied).not.toHaveProperty('trustedSource');expect(queryGovernanceEvents(f.db,{kinds:['taint_exposure'],limit:10})).toHaveLength(0);expect(f.controller.signal.aborted).toBe(false);expect(f.writes.recordingAvailable('turn-voyage','voyage')).toBe(true);
 f.db.exec('DROP TRIGGER ithaca_missing_source');
 }finally{await f.close();}
});
for(const result of ['false','reject'] as const)test(`review31: ${result} occurrence write refuses only its operation as unavailable`,async()=>{
 const f=await fixture(true);const original=f.writes.firstTaint;
 try{f.writes.firstTaint=async()=>{if(result==='reject')throw new Error('Odysseus write unavailable');return false;};expect(f.writes.recordingAvailable('turn-voyage','voyage')).toBe(true);expect(await get(f.proxy.socketPath,f.origin.url.href).catch(()=>0),'EVERY_FAILED_OCCURRENCE_WRITE_IS_503').toBe(503);expect(f.hits()).toBe(0);expect(f.controller.signal.aborted).toBe(false);f.writes.firstTaint=original;expect(await get(f.proxy.socketPath,f.origin.url.href)).toBe(200);}finally{await f.close();}
});


test('review31: the legacy recorder adapter awaits and preserves a negative commit result',async()=>{
 const f=await fixture(true,{schema_version:1},undefined,false,'127.0.0.1',true);const original=f.writes.record;let entered!:()=>void,release!:()=>void;const reached=new Promise<void>(r=>{entered=r;}),gate=new Promise<void>(r=>{release=r;});
 try{f.writes.record=async(...args)=>{if(args[0].kind==='taint'){entered();await gate;return {id:0,recorded:false};}return original(...args);};const attempt=get(f.proxy.socketPath,f.origin.url.href).catch(()=>0);await reached;expect(f.hits(),'LEGACY_COMMIT_WAIT_PRECEDES_TRUSTED_DISPATCH').toBe(0);release();expect(await attempt,'LEGACY_NEGATIVE_COMMIT_IS_UNAVAILABLE').toBe(503);expect(f.hits()).toBe(0);f.writes.record=original;expect(await get(f.proxy.socketPath,f.origin.url.href)).toBe(200);}finally{release();await f.close();}
});

for(const outcome of ['missing','rejected','replay'] as const)test(`review31: egress audit commit ${outcome} preserves truthful recording health`,async()=>{
 const f=await fixture(true,{schema_version:1},undefined,false,'127.0.0.1',true);const original=f.writes.record;
 try{f.writes.record=async(...args)=>{if(args[0].kind==='egress_connection'){if(outcome==='missing')return {id:0,recorded:false};if(outcome==='rejected')throw new Error('Odysseus audit unavailable');const result=await original(...args);return {...result,recorded:false};}return original(...args);};await get(f.proxy.socketPath,f.origin.url.href).catch(()=>0);await f.proxy.settled();expect(f.controller.signal.aborted,'AUDIT_NEGATIVE_RESULTS_ARE_NOT_SUCCESSFUL_COMMITS').toBe(outcome!=='replay');expect(Boolean(f.proxy.recordingFailure())).toBe(outcome!=='replay');}finally{await f.close();}
});

// #4351: on a turn that began restricted, the writer tolerates a lost
// occurrence or terminal exposure ({id:0,recorded:false}): the permanent gap
// already covers it. Ordinary traffic keeps its restricted recipient policy;
// source trust still needs a durable occurrence.
const permanentGap = (db: Database, failing: "source" | "exposure" | "audit") => {
  db.query("UPDATE safety_collections SET restricted_begin=1,gap='uninstrumented_backend_input' WHERE turn_id='turn-voyage'").run();
  const when = failing === "source" ? "NEW.kind='taint' AND json_extract(NEW.payload,'$.source')='egress_connection'"
    : failing === "exposure" ? "NEW.kind='taint_exposure'" : "NEW.kind='egress_connection'";
  db.exec(`CREATE TRIGGER ithaca_permanent_gap BEFORE INSERT ON governance_events WHEN ${when} BEGIN SELECT RAISE(FAIL,'Odysseus store unavailable'); END`);
};
for (const recipient of ["allowlisted", "card-needing"] as const) test(`#4351: a tolerated occurrence loss on a gapped turn admits ${recipient} untrusted traffic only under its recipient policy`, async () => {
  const f = await fixture(false, recipient === "allowlisted" ? { schema_version: 1, taint: { egress: { allow: ["127.0.0.1"] } } } : { schema_version: 1 }, undefined, true);
  let untrustedHits = 0;
  const untrusted = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { untrustedHits++; return new Response("Troy"); } });
  const outcomes: boolean[] = [];
  const original = f.writes.firstTaint;
  try {
    permanentGap(f.db, "source");
    f.writes.firstTaint = async (...args) => { const result = await original(...args); outcomes.push(result); return result; };
    f.decide(async () => ({ behavior: "allow" }));
    const status = await get(f.proxy.socketPath, untrusted.url.href).catch(() => 0);
    await f.proxy.settled();
    // A destination that would need a Network card is refused without one
    // (maintainer ruling on #4351); the allow-listed one needs none.
    expect(status, "GAPPED_UNTRUSTED_TRAFFIC_KEEPS_ITS_RECIPIENT_POLICY").toBe(recipient === "allowlisted" ? 200 : 403);
    if (recipient === "card-needing") expect(queryGovernanceEvents(f.db, { kinds: ["egress_connection"], limit: 10 })[0]?.payload).toMatchObject({ reason: "recording_gap", dispatched: false });
    expect(untrustedHits).toBe(recipient === "allowlisted" ? 1 : 0);
    expect(f.asks()).toBe(0);
    expect(outcomes).toEqual(recipient === "allowlisted" ? [false] : []);
    expect(f.controller.signal.aborted, "GAPPED_UNTRUSTED_TRAFFIC_KEEPS_THE_TURN").toBe(false);
    expect(f.proxy.recordingFailure()).toBeUndefined();
    const connections = queryGovernanceEvents(f.db, { kinds: ["egress_connection"], limit: 10 });
    for (const connection of connections) expect(connection.payload).not.toHaveProperty("trustedSource");
    expect(queryGovernanceEvents(f.db, { kinds: ["taint_exposure"], limit: 10 })).toHaveLength(0);
    const projection = safetyProjection(f.db, "turn-voyage", "voyage");
    expect(projection.restriction, "PERMANENT_GAP_STAYS_VISIBLE").toBe("restricted");
    expect(projection.coverage.state).toBe("incomplete");
    // The same lost write never stands in for a trusted source's occurrence.
    if (recipient === "allowlisted") {
      expect(await get(f.proxy.socketPath, f.origin.url.href).catch(() => 0), "GAPPED_TRUSTED_SOURCE_STILL_503").toBe(503);
      expect(f.hits()).toBe(0);
      await f.proxy.settled();
      expect(f.controller.signal.aborted).toBe(false);
    }
  } finally { f.db.exec("DROP TRIGGER IF EXISTS ithaca_permanent_gap"); untrusted.stop(true); await f.close(); }
});
test("#4351: a tolerated terminal-exposure loss on a gapped turn stops neither the turn nor later traffic", async () => {
  const f = await fixture(false, { schema_version: 1, taint: { egress: { allow: ["127.0.0.1"] } } }, undefined, true);
  let untrustedHits = 0;
  const untrusted = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { untrustedHits++; return new Response("Troy"); } });
  try {
    permanentGap(f.db, "exposure");
    expect(await get(f.proxy.socketPath, untrusted.url.href)).toBe(200);
    await f.proxy.settled();
    expect(f.controller.signal.aborted, "TOLERATED_TERMINAL_LOSS_KEEPS_THE_TURN").toBe(false);
    expect(f.proxy.recordingFailure()).toBeUndefined();
    expect(await get(f.proxy.socketPath, untrusted.url.href), "TOLERATED_TERMINAL_LOSS_KEEPS_LATER_TRAFFIC").toBe(200);
    await f.proxy.settled();
    expect(untrustedHits).toBe(2);
    expect(f.controller.signal.aborted).toBe(false);
    // The first source occurrence stays durable and immutable. Its lost
    // terminal exposure fails the collection, so the second connection's
    // occurrence is a tolerated loss as well, and it still proceeds.
    const sources = queryGovernanceEvents(f.db, { kinds: ["taint"], limit: 10 }).filter(event => (event.payload as { source?: string }).source === "egress_connection");
    expect(sources).toHaveLength(1);
    expect((sources[0]!.payload as { occurrence: { exposure: string } }).occurrence.exposure).toBe("open");
    expect(queryGovernanceEvents(f.db, { kinds: ["taint_exposure"], limit: 10 })).toHaveLength(0);
    const projection = safetyProjection(f.db, "turn-voyage", "voyage");
    expect(projection.restriction, "PERMANENT_GAP_STAYS_VISIBLE").toBe("restricted");
    expect(projection.coverage.state).toBe("incomplete");
  } finally { f.db.exec("DROP TRIGGER IF EXISTS ithaca_permanent_gap"); untrusted.stop(true); await f.close(); }
});
test("#4351: a lost connection audit on a gapped turn keeps its existing containment", async () => {
  const f = await fixture(false, { schema_version: 1, taint: { egress: { allow: ["127.0.0.1"] } } }, undefined, true);
  const untrusted = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("Troy") });
  try {
    permanentGap(f.db, "audit");
    await get(f.proxy.socketPath, untrusted.url.href).catch(() => 0);
    await f.proxy.settled();
    expect(f.controller.signal.aborted, "UNTOLERATED_AUDIT_LOSS_STILL_STOPS_THE_TURN").toBe(true);
    expect(f.proxy.recordingFailure()).toBeDefined();
  } finally { f.db.exec("DROP TRIGGER IF EXISTS ithaca_permanent_gap"); untrusted.stop(true); await f.close(); }
});
for (const lost of ["taint", "taint_exposure"] as const) test(`#4351: outside a permanent gap a lost untrusted ${lost} keeps its existing containment`, async () => {
  const f = await fixture(false, { schema_version: 1, taint: { egress: { allow: ["127.0.0.1"] } } }, undefined, false, "127.0.0.1", true);
  let untrustedHits = 0;
  const untrusted = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { untrustedHits++; return new Response("Troy"); } });
  const original = f.writes.record;
  try {
    f.writes.record = async (...args) => args[0].kind === lost ? { id: 0, recorded: false } : original(...args);
    const status = await get(f.proxy.socketPath, untrusted.url.href).catch(() => 0);
    await f.proxy.settled();
    if (lost === "taint") {
      expect(status, "UNGAPPED_LOST_OCCURRENCE_STILL_503").toBe(503);
      expect(untrustedHits).toBe(0);
      expect(f.controller.signal.aborted).toBe(false);
    } else {
      expect(status).toBe(200);
      expect(f.controller.signal.aborted, "UNGAPPED_LOST_TERMINAL_EXPOSURE_STILL_STOPS_THE_TURN").toBe(true);
      expect(f.proxy.recordingFailure()).toBeDefined();
    }
  } finally { untrusted.stop(true); await f.close(); }
});

test("#4351: a refused occurrence write on a gapped turn is never a tolerated loss", async () => {
  const f = await fixture(false, { schema_version: 1, taint: { egress: { allow: ["127.0.0.1"] } } }, undefined, true);
  let untrustedHits = 0;
  const untrusted = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { untrustedHits++; return new Response("Troy"); } });
  try {
    f.db.query("UPDATE safety_collections SET restricted_begin=1,gap='uninstrumented_backend_input' WHERE turn_id='turn-voyage'").run();
    // The writer refuses outright when its recording queue is full: ingestion must stop.
    f.writes.firstTaint = async () => { throw new Error("Safety occurrence write capacity exceeded; ingestion must stop"); };
    expect(await get(f.proxy.socketPath, untrusted.url.href).catch(() => 0), "GAPPED_REFUSED_WRITE_STILL_503").toBe(503);
    expect(untrustedHits).toBe(0);
  } finally { untrusted.stop(true); await f.close(); }
});

// #4351, maintainer ruling 2026-11-27: a turn with a permanent recording gap
// raises no approval card and uses none it holds, because a card's marker
// cannot see the losses such a turn tolerates. Allow-listed and
// already-contacted destinations need no card and still connect; a new turn
// restores approvals.
type Fixture = Awaited<ReturnType<typeof fixture>>;
const gappedTurn = (f: Fixture) => f.db.query("UPDATE safety_collections SET restricted_begin=1,gap='uninstrumented_backend_input' WHERE turn_id='turn-voyage'").run();
const lastConnection = (f: Fixture) => queryGovernanceEvents(f.db, { kinds: ["egress_connection"], limit: 10 })[0]?.payload;
const untrustedOrigin = () => {
  let hits = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { hits++; return new Response("Troy"); } });
  return { url: server.url.href, hits: () => hits, stop: () => server.stop(true) };
};

test("#4351: a gapped turn refuses a card-needing destination without raising a card", async () => {
  const f = await fixture(false, { schema_version: 1 }, undefined, true);
  const troy = untrustedOrigin();
  try {
    gappedTurn(f);
    await f.taint();
    f.decide(async () => ({ behavior: "allow" }));
    expect(await get(f.proxy.socketPath, troy.url).catch(() => 0)).toBe(403);
    await f.proxy.settled();
    expect(f.asks(), "GAPPED_TURN_RAISES_NO_CARD").toBe(0);
    expect(troy.hits()).toBe(0);
    expect(lastConnection(f), "GAPPED_TURN_NAMES_ITS_REFUSAL").toMatchObject({ outcome: "denied", reason: "recording_gap", dispatched: false });
    expect(f.controller.signal.aborted).toBe(false);
  } finally { troy.stop(); await f.close(); }
});

test("#4351: a gapped turn refuses a managed GitHub fetch that needs a card", async () => {
  const f = await fixture(false, { schema_version: 1 }, undefined, true);
  try {
    gappedTurn(f);
    await f.taint();
    f.decide(async () => ({ behavior: "allow" }));
    const op = f.proxy.managedReference(new URL("https://github.com/"), new AbortController().signal);
    expect(await op.admit(), "GAPPED_TURN_REFUSES_A_MANAGED_FETCH").toBe(false);
    expect(f.asks()).toBe(0);
    expect(op.reason()).toBe("recording_gap");
    await f.proxy.settled();
    expect(lastConnection(f)).toMatchObject({ managedReference: true, reason: "recording_gap", dispatched: false });
  } finally { await f.close(); }
});

for (const route of ["allow-listed", "already contacted"] as const) test(`#4351: a gapped turn still connects an ${route} destination without a card`, async () => {
  const f = await fixture(false, route === "allow-listed" ? { schema_version: 1, taint: { egress: { allow: ["127.0.0.1"] } } } : { schema_version: 1 }, undefined, true);
  const troy = untrustedOrigin();
  try {
    await f.taint();
    f.decide(async () => ({ behavior: "allow" }));
    // Reached once under an answered card before the gap: the host is contacted.
    if (route === "already contacted") { expect(await get(f.proxy.socketPath, troy.url)).toBe(200); expect(f.asks()).toBe(1); }
    gappedTurn(f);
    expect(await get(f.proxy.socketPath, troy.url), "GAPPED_TURN_KEEPS_DESTINATIONS_THAT_NEED_NO_CARD").toBe(200);
    expect(f.asks(), "NO_CARD_ON_THE_GAPPED_TURN").toBe(route === "allow-listed" ? 0 : 1);
    expect(troy.hits()).toBe(route === "allow-listed" ? 1 : 2);
  } finally { troy.stop(); await f.close(); }
});

for (const answer of ["withdrawn", "answered late"] as const) test(`#4351: a turn that becomes gapped while its card is pending never uses the card (${answer})`, async () => {
  const f = await fixture(false, { schema_version: 1 }, undefined, true);
  const troy = untrustedOrigin();
  try {
    await f.taint();
    // The gap arrives while the card waits. The host withdraws the card, or
    // the owner's answer lands after the gap and the host cannot confirm it.
    f.decide(async () => { gappedTurn(f); return answer === "withdrawn" ? { behavior: "deny", message: "The card expired" } : { behavior: "allow" }; });
    f.refuse(() => answer === "withdrawn" ? "superseded" : "unconfirmed");
    expect(await get(f.proxy.socketPath, troy.url).catch(() => 0)).toBe(403);
    await f.proxy.settled();
    expect(f.asks(), "NO_REPLACEMENT_CARD_ON_THE_GAPPED_TURN").toBe(1);
    expect(troy.hits()).toBe(0);
    expect(lastConnection(f), "PENDING_CARD_ON_A_NEWLY_GAPPED_TURN_IS_NEVER_USED").toMatchObject({ reason: "recording_gap", dispatched: false });
  } finally { troy.stop(); await f.close(); }
});

test("#4351: a turn that becomes gapped between an answered card and its dispatch refuses the dispatch", async () => {
  const f = await fixture(false, { schema_version: 1 }, undefined, true);
  try {
    await f.taint();
    f.decide(async () => ({ behavior: "allow" }));
    // A managed acquisition writes nothing between its answer and its dispatch.
    const op = f.proxy.managedReference(new URL("https://github.com/"), new AbortController().signal);
    expect(await op.admit()).toBe(true);
    gappedTurn(f);
    const prepared = op.prepare();
    const sent = prepared.ok ? op.dispatch(() => {}) : prepared;
    expect(sent.ok).toBe(false);
    expect(op.reason(), "GAP_BEFORE_DISPATCH_REFUSES_AN_ANSWERED_CARD").toBe("recording_gap");
  } finally { await f.close(); }
});

const OUTWARD: GovernancePolicyInput = { schema_version: 1, taint: { egress: { allow: ["127.0.0.1"] } }, outward: { hosts: ["127.0.0.1"] } };
test("#4351: a gapped turn refuses an outward destination without raising its card", async () => {
  const f = await fixture(false, OUTWARD, undefined, true);
  const troy = untrustedOrigin();
  try {
    gappedTurn(f);
    f.decide(async () => ({ behavior: "allow" }));
    expect(await get(f.proxy.socketPath, troy.url).catch(() => 0), "GAPPED_TURN_REFUSES_AN_OUTWARD_DESTINATION").toBe(403);
    await f.proxy.settled();
    expect(f.asks(), "GAPPED_TURN_RAISES_NO_OUTWARD_CARD").toBe(0);
    expect(troy.hits()).toBe(0);
    expect(lastConnection(f), "GAPPED_OUTWARD_REFUSAL_IS_NAMED").toMatchObject({ reason: "recording_gap", dispatched: false });
  } finally { troy.stop(); await f.close(); }
});
test("#4351: an outward card is never used once the turn becomes gapped while it is pending", async () => {
  const f = await fixture(false, OUTWARD, undefined, true);
  const troy = untrustedOrigin();
  try {
    f.decide(async () => { gappedTurn(f); return { behavior: "allow" }; });
    expect(await get(f.proxy.socketPath, troy.url).catch(() => 0)).toBe(403);
    await f.proxy.settled();
    expect(f.asks()).toBe(1);
    expect(troy.hits()).toBe(0);
    expect(lastConnection(f), "OUTWARD_ANSWER_AFTER_THE_GAP_IS_REFUSED").toMatchObject({ reason: "recording_gap", dispatched: false });
  } finally { troy.stop(); await f.close(); }
});
test("#4351: an outward card answered before the gap is not used at dispatch", async () => {
  const f = await fixture(false, { schema_version: 1 }, undefined, true);
  try {
    f.decide(async () => ({ behavior: "allow" }));
    // An untainted managed fetch of a GitHub API host needs only its outward
    // card, and it writes nothing between that answer and its dispatch.
    const op = f.proxy.managedReference(new URL("https://api.github.com/"), new AbortController().signal);
    expect(await op.admit()).toBe(true);
    expect(f.asks()).toBe(1);
    gappedTurn(f);
    const prepared = op.prepare();
    const sent = prepared.ok ? op.dispatch(() => {}) : prepared;
    expect(sent.ok).toBe(false);
    expect(op.reason(), "GAP_BEFORE_DISPATCH_REFUSES_AN_ANSWERED_OUTWARD_CARD").toBe("recording_gap");
  } finally { await f.close(); }
});
test("#4351: a gapped turn still connects an outward host a classified call covers, without a card", async () => {
  const f = await fixture(false, OUTWARD, undefined, true);
  const troy = untrustedOrigin();
  try {
    gappedTurn(f);
    f.decide(async () => ({ behavior: "allow" }));
    // A visible read in progress covers the outward host: it needs no card.
    f.proxy.bridge.activity?.({ kind: "outward_classification", toolUseId: "toolu-odysseus-read", decision: "allow",
      classification: { kind: "read", opaque: false, actions: [] } } as never);
    expect(await get(f.proxy.socketPath, troy.url).catch(() => 0), "GAPPED_TURN_KEEPS_COVERED_OUTWARD_TRAFFIC").toBe(200);
    expect(f.asks()).toBe(0);
    expect(troy.hits()).toBe(1);
  } finally { troy.stop(); await f.close(); }
});
const classifiedRead = (f: Fixture, toolUseId = "toolu-odysseus-read") => f.proxy.bridge.activity?.({ kind: "outward_classification", toolUseId, decision: "allow",
  classification: { kind: "read", opaque: false, actions: [] } } as never);
test("#4351: covered outward traffic on a gapped turn is refused as recording_gap when its call ends before dispatch", async () => {
  const f = await fixture(false, OUTWARD, undefined, true);
  const troy = untrustedOrigin();
  const original = f.writes.firstTaint;
  try {
    gappedTurn(f);
    classifiedRead(f);
    // The covering call returns its result while the connection's occurrence commits.
    f.writes.firstTaint = async (...args) => { const result = await original(...args);
      if (args[0].payload.source === "egress_connection") f.proxy.bridge.emit({ type: "tool_result", toolUseId: "toolu-odysseus-read", content: "", isError: false } as never);
      return result; };
    expect(await get(f.proxy.socketPath, troy.url).catch(() => 0), "COVER_LOST_BEFORE_DISPATCH_NEVER_DISPATCHES").toBe(403);
    await f.proxy.settled();
    expect(f.asks()).toBe(0);
    expect(troy.hits()).toBe(0);
    expect(lastConnection(f), "COVER_LOST_ON_A_GAPPED_TURN_IS_A_GAP_REFUSAL").toMatchObject({ reason: "recording_gap", dispatched: false });
  } finally { troy.stop(); await f.close(); }
});
test("#4351: covered outward traffic keeps connecting when its own occurrence write is lost on a gapped turn", async () => {
  const f = await fixture(false, OUTWARD, undefined, true);
  const troy = untrustedOrigin();
  try {
    permanentGap(f.db, "source");
    classifiedRead(f);
    expect(await get(f.proxy.socketPath, troy.url).catch(() => 0), "COVERED_OUTWARD_BINDS_TO_NO_CARD_MARKER").toBe(200);
    expect(f.asks()).toBe(0);
    expect(troy.hits()).toBe(1);
    expect(f.controller.signal.aborted).toBe(false);
  } finally { f.db.exec("DROP TRIGGER IF EXISTS ithaca_permanent_gap"); troy.stop(); await f.close(); }
});
// #4351: only the writer's exact {id:0, recorded:false} acknowledges a
// tolerated loss on a gapped turn; any other negative reply is no acknowledgment.
for (const reply of ["exact", "no id", "negative id", "text id", "recorded null", "bare false"] as const) for (const lost of ["taint", "taint_exposure"] as const)
  test(`#4351: a gapped turn's ${lost} reply (${reply}) is tolerated only when it is the exact acknowledgment`, async () => {
    const f = await fixture(false, { schema_version: 1, taint: { egress: { allow: ["127.0.0.1"] } } }, undefined, false, "127.0.0.1", true);
    const troy = untrustedOrigin();
    const original = f.writes.record;
    const answer = reply === "exact" ? { id: 0, recorded: false } : reply === "no id" ? { recorded: false } : reply === "negative id" ? { id: -1, recorded: false }
      : reply === "text id" ? { id: "0", recorded: false } : reply === "recorded null" ? { id: 0, recorded: null } : false;
    try {
      gappedTurn(f);
      f.writes.record = async (...args) => args[0].kind === lost && (lost === "taint_exposure" || (args[0].payload as { source?: string }).source === "egress_connection") ? answer as never : original(...args);
      const status = await get(f.proxy.socketPath, troy.url).catch(() => 0);
      await f.proxy.settled();
      if (reply === "exact") {
        expect(status, "EXACT_ACKNOWLEDGMENT_IS_TOLERATED").toBe(200);
        expect(f.controller.signal.aborted).toBe(false);
      } else if (lost === "taint") {
        // No occurrence acknowledgment: the connection refuses as before.
        expect(status, "MALFORMED_OCCURRENCE_REPLY_REFUSES").toBe(503);
        expect(troy.hits()).toBe(0);
      } else expect(f.controller.signal.aborted, "MALFORMED_TERMINAL_REPLY_STOPS_THE_TURN").toBe(true);
    } finally { troy.stop(); await f.close(); }
  });

// #4351: an unreadable gap is unknown, not a gap: a card path fails closed as
// unavailable, with no new-turn advice.
test("#4351: an unreadable gap refuses a card-needing destination as egress_unavailable, not recording_gap", async () => {
  const f = await fixture(false, { schema_version: 1 }, undefined, true);
  const troy = untrustedOrigin();
  try {
    await f.taint();
    f.decide(async () => ({ behavior: "allow" }));
    const query = f.db.query.bind(f.db);
    const unreadable = spyOn(f.db, "query").mockImplementation(((sql: string) => {
      // Only turn egress reads the gap with this statement.
      if (sql === "SELECT restricted_begin FROM safety_collections WHERE turn_id=?") throw new Error("Odysseus ledger unreadable");
      return query(sql);
    }) as never);
    let status: number;
    try { status = await get(f.proxy.socketPath, troy.url).catch(() => 0); } finally { unreadable.mockRestore(); }
    await f.proxy.settled();
    expect(status, "UNKNOWN_GAP_IS_UNAVAILABLE").toBe(503);
    expect(f.asks(), "UNKNOWN_GAP_RAISES_NO_CARD").toBe(0);
    expect(troy.hits()).toBe(0);
    expect(lastConnection(f), "UNKNOWN_GAP_IS_NOT_A_GAP_REFUSAL").toMatchObject({ reason: "egress_unavailable", dispatched: false });
  } finally { troy.stop(); await f.close(); }
});
// #4351: a positive id is a durable replay. It keeps its evidence on a
// gapped turn: never a tolerated loss.
for (const source of ["untrusted", "trusted"] as const) test(`#4351: a replayed ${source} occurrence on a gapped turn keeps its durable evidence`, async () => {
  const f = await fixture(true, { schema_version: 1, taint: { egress: { allow: ["127.0.0.1"] } } }, undefined, false, "127.0.0.1", true);
  const troy = untrustedOrigin();
  const original = f.writes.record;
  try {
    gappedTurn(f);
    f.writes.record = async (...args) => {
      if (args[0].kind === "taint" && (args[0].payload as { source?: string }).source === "egress_connection") { await original(...args); return { id: 7, recorded: false }; }
      return original(...args);
    };
    const status = await get(f.proxy.socketPath, source === "trusted" ? f.origin.url.href : troy.url).catch(() => 0);
    await f.proxy.settled();
    expect(status, "REPLAY_KEEPS_ITS_DURABLE_EVIDENCE").toBe(200);
    expect(queryGovernanceEvents(f.db, { kinds: ["taint_exposure"], limit: 10 }), "REPLAY_RECORDS_ITS_TERMINAL_STATE").toHaveLength(1);
    expect(f.controller.signal.aborted).toBe(false);
  } finally { troy.stop(); await f.close(); }
});
// #4351: restricted_begin is exactly 0 or 1; any other value is unknown.
test("#4351: a malformed restricted_begin is unknown and refuses a card-needing destination as egress_unavailable", async () => {
  const f = await fixture(false, { schema_version: 1 }, undefined, true);
  const troy = untrustedOrigin();
  try {
    await f.taint();
    f.db.query("UPDATE safety_collections SET restricted_begin=2 WHERE turn_id='turn-voyage'").run();
    f.decide(async () => ({ behavior: "allow" }));
    expect(await get(f.proxy.socketPath, troy.url).catch(() => 0), "MALFORMED_GAP_IS_UNAVAILABLE").toBe(503);
    await f.proxy.settled();
    expect(f.asks()).toBe(0);
    expect(troy.hits()).toBe(0);
    expect(lastConnection(f)).toMatchObject({ reason: "egress_unavailable", dispatched: false });
  } finally { troy.stop(); await f.close(); }
});
