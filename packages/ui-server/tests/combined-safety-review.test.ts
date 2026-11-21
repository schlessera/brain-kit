import { expect, test } from "bun:test";
import { createKeyedLock } from "@schlessera/brain-ui-sdk/server";
import { createTrustSettings } from "../src/brain/trust-settings";
import { CombinedSafetyReviews } from "../src/governance/combined-safety-reviews";
import { safetyHistoryFixture } from "./helpers/safety-history-fixture";
import { occurrence } from "../src/governance/occurrence";

async function fixture(checkpoint?: (stage: string) => void | Promise<void>) {
  const f = await safetyHistoryFixture(true, true);
  const options = {root:f.root,db:f.db,writer:f.writer,lock:createKeyedLock(),originEnforcement:true as const,
    authority:(id:string)=>id===f.principal.id&&f.reviews!.authorized(f.principal)?"owner-epoch":null,
    observe:async (_id:string, write:()=>void|Promise<void>)=>{await write();},checkpoint};
  const settings=createTrustSettings(options),combined=new CombinedSafetyReviews(f.db,f.reviews!,settings);
  const add=async (name:string,verified=true,state:"finalized"|"open"|"interrupted_unknown"="finalized")=>{
    const o=occurrence(f.bindingId,"proxy_input",name,state);
    if(verified)o.provenance={kind:"web_origin",origin:{scheme:"https",host:"ithaca.invalid",port:443},verifiedBy:"host_transport"};
    await f.writes.record({kind:"taint",turnId:"voyage",sessionId:"ithaca",actor:"interactive",model:null,profile:"governed",payload:{source:"egress_connection",tool:"shell",detail:null,occurrence:o}});return o;
  };
  const body=(id:string)=>({version:1 as const,session:f.writes.safety(null,"ithaca").session!,occurrenceId:id,expectedEvidenceRevision:f.writes.safety(null,"ithaca").evidenceRevision,verdict:"safe" as const, future:{incomingContent:true as const,recipientWhileRestricted:false}});
  return {...f,settings,options,combined,add,body};
}
test("combined review publishes exact future rule then resolves only A; replay observes removal",async()=>{
  const f=await fixture();try{
    const a=await f.add("A");await f.add("B");await f.add("C");
    const body=f.body(a.id),p=await f.combined.prepare(f.principal,body);
    expect(p.review.proposed).toContain("ithaca.invalid");
    expect(f.writes.safety(null,"ithaca").unresolvedCount).toBe(3);
    const input={version:1 as const,requestId:p.requestId,reviewId:p.review.reviewId,reviewedBytesHash:p.review.reviewedBytesHash};
    const saved=await f.combined.commit(f.principal,input);
    expect(saved.stage,"COMBINED_VERDICT_AFTER_PROVED_PUBLICATION").toBe("verdict_committed");
    expect(saved.currentProjection.unresolvedCount,"COMBINED_A_NEVER_CLEARS_B_C").toBe(2);
    expect(saved.rule.currentRule).toBe("present");expect((await f.settings.list(f.principal.id)).rules[0]!.recipientWhileRestricted).toBe(false);
    const current=await f.settings.list(f.principal.id),remove=await f.settings.prepare(f.principal.id,{version:1,expectedTrustRevision:current.revision,expectedPolicyHash:current.policyHash,change:{action:"remove",ruleId:saved.rule.ruleId}});
    await f.settings.commit(f.principal.id,{version:1,requestId:remove.receipt.requestId,reviewId:remove.review.reviewId,reviewedBytesHash:remove.review.reviewedBytesHash});
    const restarted=new CombinedSafetyReviews(f.db,f.reviews!,createTrustSettings(f.options));
    const replay=await restarted.commit(f.principal,input);
    expect((await restarted.status(f.principal,{version:1,session:body.session,occurrenceId:a.id}))?.rule.currentRule,"COMBINED_RESTART_READ_WITHOUT_MUTATION").toBe("removed");
    expect(replay.rule.currentRule,"COMBINED_RETRY_NEVER_REPUBLISHES_REMOVED_RULE").toBe("removed");
    expect(replay.currentProjection.unresolvedCount).toBe(2);
  }finally{await f.close();}
});
for(const state of ["open","interrupted_unknown"] as const)test(`combined review refuses ${state} and unverified provenance`,async()=>{
 const f=await fixture();try{const a=await f.add("A",true,state);await expect(f.combined.prepare(f.principal,f.body(a.id))).rejects.toThrow();
 const b=await f.add("B",false);await expect(f.combined.prepare(f.principal,f.body(b.id))).rejects.toThrow("provenance_unavailable");
 expect((await f.settings.list(f.principal.id)).rules).toEqual([]);}finally{await f.close();}
});
test("publication proof survives partial failure; retry cannot publish twice or clear stale evidence",async()=>{
 const f=await fixture();try{
 const a=await f.add("A"),p=await f.combined.prepare(f.principal,f.body(a.id));await f.add("B");
 const result=await f.combined.commit(f.principal,{version:1,requestId:p.requestId,reviewId:p.review.reviewId,reviewedBytesHash:p.review.reviewedBytesHash});
 expect(result.stage).toBe("refused");expect(result.rule.publication).toBe("not_published");expect(f.writes.safety(null,"ithaca").unresolvedCount).toBe(2);
 }finally{await f.close();}
});

test("proved publication with verdict failure stays restrictive; durable binding resumes without republishing",async()=>{
 const f=await fixture();try{
 const a=await f.add("A"),p=await f.combined.prepare(f.principal,f.body(a.id));
 const input={version:1 as const,requestId:p.requestId,reviewId:p.review.reviewId,reviewedBytesHash:p.review.reviewedBytesHash};
 const original=f.reviews!.review.bind(f.reviews!);
 f.reviews!.review=async()=>{throw new Error("simulated verdict outage");};
 const partial=await f.combined.commit(f.principal,input);
 expect((await new CombinedSafetyReviews(f.db,f.reviews!,createTrustSettings(f.options)).status(f.principal,{version:1,session:f.body(a.id).session,occurrenceId:a.id}))?.stage,"COMBINED_PARTIAL_SURVIVES_SERVICE_RESTART_READ").toBe("partial");
 expect(partial.stage,"COMBINED_VERDICT_OUTAGE_RETURNS_PARTIAL_RECEIPT").toBe("partial");
 expect(f.writes.safety(null,"ithaca").unresolvedCount,"COMBINED_PUBLICATION_ALONE_NEVER_CLEARS_A").toBe(1);
 expect((await f.settings.read(f.principal.id,p.requestId)).receipt.publication).toBe("proved");
 f.reviews!.review=original;
 const result=await new CombinedSafetyReviews(f.db,f.reviews!,createTrustSettings(f.options)).commit(f.principal,input);
 expect(result.stage).toBe("verdict_committed");
 expect(f.db.query('SELECT count(*) n FROM trust_settings_operations').get()).toEqual({n:1});
 }finally{await f.close();}
});
test("unproved rename crash requires fresh review and never commits the verdict on retry",async()=>{
 let publications=0;const f=await fixture(stage=>{if(stage==="renamed"){publications++;throw new Error("crash before proof");}});try{
 const a=await f.add("A"),p=await f.combined.prepare(f.principal,f.body(a.id));
 const input={version:1 as const,requestId:p.requestId,reviewId:p.review.reviewId,reviewedBytesHash:p.review.reviewedBytesHash};
 for(let i=0;i<2;i++){
 const result=await new CombinedSafetyReviews(f.db,f.reviews!,createTrustSettings(f.options)).commit(f.principal,input);
 expect(result.stage,"COMBINED_UNKNOWN_PUBLICATION_NEVER_BLESSED_BY_EQUAL_BYTES").toBe("unknown");expect(result.verdict).toBeNull();
 }
 expect(publications).toBe(1);expect(f.writes.safety(null,"ithaca").unresolvedCount).toBe(1);
 }finally{await f.close();}
});
test("rule removed between authorities does not return; the selected verdict can still commit",async()=>{
 const f=await fixture();try{
 const a=await f.add("A"),p=await f.combined.prepare(f.principal,f.body(a.id));
 const original=f.reviews!.review.bind(f.reviews!);f.reviews!.review=async(...args)=>{
 const policy=await f.settings.list(f.principal.id),remove=await f.settings.prepare(f.principal.id,{version:1,expectedTrustRevision:policy.revision,expectedPolicyHash:policy.policyHash,change:{action:"remove",ruleId:p.rule.ruleId}});
 await f.settings.commit(f.principal.id,{version:1,requestId:remove.receipt.requestId,reviewId:remove.review.reviewId,reviewedBytesHash:remove.review.reviewedBytesHash});return original(...args);};
 const result=await f.combined.commit(f.principal,{version:1,requestId:p.requestId,reviewId:p.review.reviewId,reviewedBytesHash:p.review.reviewedBytesHash});
 expect(result.stage).toBe("verdict_committed");expect(result.rule.currentRule,"COMBINED_CURRENT_RULE_ABSENCE_IS_HONEST").toBe("removed");expect((await f.settings.list(f.principal.id)).rules).toEqual([]);
 }finally{await f.close();}
});
test("generic Settings commit and wrong-session route cannot consume a combined binding",async()=>{
 const f=await fixture();try{const a=await f.add("A"),p=await f.combined.prepare(f.principal,f.body(a.id));
 const input={version:1 as const,requestId:p.requestId,reviewId:p.review.reviewId,reviewedBytesHash:p.review.reviewedBytesHash};
 expect(await f.settings.commit(f.principal.id,input).then(()=>"published",error=>error.message),"COMBINED_GENERIC_SETTINGS_CANNOT_PUBLISH_BOUND_REVIEW").toBe("request_conflict");
 await expect(f.combined.commit(f.principal,input,undefined,"troy")).rejects.toThrow("request_conflict");
 expect((await f.settings.list(f.principal.id)).rules).toEqual([]);
 }finally{await f.close();}
});

test("combined real HTTP/WS owner, Origin, provenance and session fences",async()=>{
 const {Hono}=await import('hono'),{authGuard}=await import('../src/middleware/auth'),{createOwnerSafetyReviewRoutes}=await import('../src/routes/owner-safety-review');
 const f=await fixture(),app=new Hono<import('../src/app-env').AppEnv>();
 f.reviews!.enableFutureRules(f.settings);
 app.use('/api/*',authGuard('password',f.auth,f.db));app.route('/api',createOwnerSafetyReviewRoutes(f.reviews!,false,f.combined));
 const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch:app.fetch}),origin=`http://127.0.0.1:${server.port}`;
 const post=(action:string,body:unknown,headers:Record<string,string>={})=>fetch(`${origin}/api/sessions/ithaca/safety/reviews/future/${action}`,{method:'POST',headers:{cookie:f.cookie,origin,'content-type':'application/json',...headers},body:JSON.stringify(body)});
 try{
 const a=await f.add('A'),body=f.body(a.id);
 expect((await f.connect()).hello).toMatchObject({safetyCapabilities:{review:true,originRules:true,recipientRules:true,repositoryRules:false}});
 expect((await post('prepare',body,{origin:'https://troy.invalid'})).status).toBe(403);
 expect((await post('prepare',{...body,future:{...body.future,selector:{kind:'web_origin',host:'troy.invalid'}}})).status).toBe(400);
 const prepared=await post('prepare',body);expect(prepared.status,'COMBINED_HTTP_PREPARE_REQUIRES_IMPLEMENTED_ROUTE').toBe(200);
 const p=await prepared.json();
 const response=await post('commit',{version:1,requestId:p.requestId,reviewId:p.review.reviewId,reviewedBytesHash:p.review.reviewedBytesHash});
 expect(response.status).toBe(200);expect((await response.json()).stage).toBe('verdict_committed');
 expect(f.starts()).toBe(0);
 }finally{server.stop(true);await f.close();}
});

test("closing and reopening both DB authorities recovers a partial combined operation without publication replay",async()=>{
 const {createUiDb}=await import('../src/db/client'),{openSqliteWriter}=await import('../src/db/write-worker'),{createGovernanceWrites}=await import('../src/governance/event-writes'),{OwnerSafetyReviews}=await import('../src/governance/owner-safety-reviews'),{rmSync}=await import('node:fs');
 const f=await fixture();let closed=false;
 try{
  const a=await f.add('A'),body=f.body(a.id),p=await f.combined.prepare(f.principal,body);
  const input={version:1 as const,requestId:p.requestId,reviewId:p.review.reviewId,reviewedBytesHash:p.review.reviewedBytesHash};
  f.reviews!.review=async()=>{throw new Error('verdict unavailable');};
  expect((await f.combined.commit(f.principal,input)).stage).toBe('partial');
  await f.close(true);closed=true;
  const db=createUiDb(f.path),writer=openSqliteWriter(db),writes=createGovernanceWrites(db,writer),reviews=new OwnerSafetyReviews(db,writes,'password',f.brainKey);
  let publications=0;
  const settings=createTrustSettings({...f.options,db,writer,lock:createKeyedLock(),authority:id=>id===f.principal.id&&reviews.authorized(f.principal)?'owner-epoch':null,observe:async(_id,write)=>{publications++;await write();}});
  const service=new CombinedSafetyReviews(db,reviews,settings);
  try{
   expect((await service.status(f.principal,{version:1,session:body.session,occurrenceId:a.id}))?.stage,'COMBINED_REOPENED_DB_READS_PARTIAL').toBe('partial');
   expect(writes.safety(null,'ithaca').unresolvedCount).toBe(1);
   const retried=await service.commit(f.principal,input);
   expect(retried.stage,'COMBINED_RESTART_RECOVERY_PRESERVES_LIFECYCLE_FENCE').toBe('partial');
   expect(retried.verdict?.reason).toBe('stale_revision');
   expect(writes.safety(null,'ithaca').unresolvedCount).toBe(1);
   expect(publications,'COMBINED_REOPENED_DB_NEVER_REPUBLISHES').toBe(0);
  }finally{await writer.close();db.close();}
 }finally{if(!closed)await f.close();else rmSync(f.root,{recursive:true,force:true});}
});

test("explicit tunnel provenance remains a tunnel and recipient permission is independently reviewed",async()=>{
 const f=await fixture();try{
 const a=occurrence(f.bindingId,'proxy_input',null,'finalized');a.provenance={kind:'tunnel_authority',authority:{host:'ithaca.invalid',port:8443},verifiedBy:'host_proxy'};
 await f.writes.record({kind:'taint',turnId:'voyage',sessionId:'ithaca',actor:'interactive',model:null,profile:'governed',payload:{source:'egress_connection',tool:'shell',detail:null,occurrence:a}});
 const p=await f.combined.prepare(f.principal,{...f.body(a.id),future:{incomingContent:true,recipientWhileRestricted:true}});
 const result=await f.combined.commit(f.principal,{version:1,requestId:p.requestId,reviewId:p.review.reviewId,reviewedBytesHash:p.review.reviewedBytesHash});
 expect(result.stage).toBe('verdict_committed');
 expect((await f.settings.list(f.principal.id)).rules[0]).toMatchObject({selector:{kind:'tunnel_authority',host:'ithaca.invalid',port:8443},incomingContent:true,recipientWhileRestricted:true});
 }finally{await f.close();}
});

test("historical JSON without the host provenance attestation cannot offer a standing rule",async()=>{
 const f=await fixture();try{
 const a=await f.add('A');
 const row=f.db.query('SELECT payload FROM safety_records WHERE id=?').get(a.id) as {payload:string};
 const payload=JSON.parse(row.payload);delete payload.occurrence.provenance.verifiedBy;
 f.db.query('UPDATE safety_records SET payload=? WHERE id=?').run(JSON.stringify(payload),a.id);
 expect(await f.combined.prepare(f.principal,f.body(a.id)).then(()=>"prepared",error=>error.message),'COMBINED_REQUIRES_HOST_ATTESTATION').toBe('provenance_unavailable');
 expect((await f.settings.list(f.principal.id)).rules).toEqual([]);
 }finally{await f.close();}
});
