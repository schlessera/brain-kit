import {test,expect} from 'bun:test';
import {createStore} from 'zustand/vanilla';
import {safetyHistoryFixture} from '../../ui-server/tests/helpers/safety-history-fixture';
import {createSafetyStore} from '../src/stores/safety-state';
import {createBrainApi} from '../src/lib/api-client';
import {createSafetyReviewer,type SafetyReviewProgress} from '../src/lib/safety-reviewer';
import type {BrainUiServices} from '../src/root';

async function fixture(future=false){
 const host=await safetyHistoryFixture(true,true);
 const add=async(name:string)=>{
  if(!future)return host.add(name);
  const {occurrence}=await import('../../ui-server/src/governance/occurrence');
  const o=occurrence(host.bindingId,'proxy_input',name,'finalized');o.provenance={kind:'web_origin',origin:{scheme:'https',host:'ithaca.invalid',port:443},verifiedBy:'host_transport'};
  await host.writes.record({kind:'taint',turnId:'voyage',sessionId:'ithaca',actor:'interactive',model:null,profile:'governed',payload:{source:'egress_connection',tool:'shell',detail:null,occurrence:o}});return o;
 };
 const a=await add('A'),b=await add('B'),c=await add('C');
 let futureServer:ReturnType<typeof Bun.serve>|undefined;
 let futureSettings:ReturnType<typeof import('../../ui-server/src/brain/trust-settings').createTrustSettings>|undefined;
 if(future){
  const {Hono}=await import('hono'),{createKeyedLock}=await import('@schlessera/brain-ui-sdk/server'),{createTrustSettings}=await import('../../ui-server/src/brain/trust-settings'),{CombinedSafetyReviews}=await import('../../ui-server/src/governance/combined-safety-reviews'),{createOwnerSafetyReviewRoutes}=await import('../../ui-server/src/routes/owner-safety-review'),{authGuard}=await import('../../ui-server/src/middleware/auth');
  futureSettings=createTrustSettings({root:host.root,db:host.db,writer:host.writer,lock:createKeyedLock(),originEnforcement:true,authority:id=>id===host.principal.id&&host.reviews!.authorized(host.principal)?'owner-epoch':null,observe:async(_id,write)=>{await write();}});
  const app=new Hono<import('../../ui-server/src/app-env').AppEnv>();app.use('/api/*',authGuard('password',host.auth,host.db));app.route('/api',createOwnerSafetyReviewRoutes(host.reviews!,false,new CombinedSafetyReviews(host.db,host.reviews!,futureSettings)));
  futureServer=Bun.serve({hostname:'127.0.0.1',port:0,fetch:app.fetch});
 }
 const safety=createSafetyStore(),chat=createStore(()=>({activeSessionId:'ithaca' as string|null})),auth=createStore(()=>({phase:'active' as 'active'|'locked'}));
 safety.getState().reset(true,{...host.reviews!.capabilities(host.principal),...(future?{originRules:true,recipientRules:true}:{})});
 const page=await host.history.read(host.principal,{sessionId:'ithaca'});
 safety.getState().begin('snapshot');safety.getState().page('snapshot',page);
 const origin=futureServer?`http://127.0.0.1:${futureServer.port}`:host.url.replace('ws:','http:').replace('/ws',''),requests:string[]=[],progress:SafetyReviewProgress[]=[];
 let epoch=0,transport:(url:string,init:RequestInit)=>Promise<Response>=(url,init)=>fetch(url,init);
 const api=createBrainApi(()=>origin+'/api',(url,init)=>{requests.push(url);return transport(url,{...init,headers:{...init?.headers,cookie:host.cookie,origin}});});
 const root={api,stores:{safety,chat},authLock:{state:auth,epoch:()=>epoch}} as unknown as BrainUiServices;
 const reviewer=createSafetyReviewer(root,p=>progress.push(p));
 return {host,a,b,c,safety,chat,auth,requests,progress,root,reviewer,futureSettings,setTransport(next:typeof transport){transport=next;},revoke(){epoch++;auth.setState({phase:'locked'});},async close(){reviewer.dispose();futureServer?.stop(true);await host.close();}};
}
const gate=()=>{let release!:(v:Response)=>void;const promise=new Promise<Response>(r=>{release=r;});let entered!:()=>void;const arrived=new Promise<void>(r=>{entered=r;});return {release,promise,entered,arrived};};

test('an explicit real owner review affects only A and never installs a receipt projection',async()=>{
 const f=await fixture();try{
  await f.reviewer.markSafe(f.a.id);
  expect(f.requests.map(u=>u.split('/reviews/')[1])).toHaveLength(2);
  expect(f.progress.at(-1)?.stage,'ONLY_HOST_COMMITTED_VERDICT_REPORTS_SUCCESS').toBe('committed');
  const current=await f.host.history.read(f.host.principal,{sessionId:'ithaca'});
  expect(current.projection.unresolvedCount,'B_AND_C_STAY_UNRESOLVED').toBe(2);
  expect(current.records.filter(r=>r.kind==='safe_decision').map(r=>r.occurrenceId)).toEqual([f.a.id]);
  expect(f.safety.getState().projection?.unresolvedCount,'RECEIPT_CANNOT_OVERWRITE_LIVE_AGGREGATE').toBe(3);
  expect(f.safety.getState().normal).toBe(false);expect(f.safety.getState().refreshTick).toBe(1);
  f.safety.getState().refresh();expect(f.requests,'REFRESH_NEVER_REPLAYS_A_VERDICT').toHaveLength(2);
 }finally{await f.close();}
});

test('owner loss while prepare is returning cancels commit and settles the pending state',async()=>{
 const f=await fixture(),hold=gate();let prepared:Response;try{
  f.setTransport(async(url,init)=>{const response=await fetch(url,init);prepared=Response.json(await response.json(),{status:response.status});hold.entered();return hold.promise;});
  const pending=f.reviewer.markSafe(f.a.id);await hold.arrived;f.revoke();hold.release(prepared!);await pending;
  expect(f.requests,'AUTH_LOSS_CANNOT_COMMIT_PREPARED_AUTHORITY').toHaveLength(1);
  expect(f.host.db.query('SELECT COUNT(*) n FROM safety_decisions').get()).toEqual({n:0});
  expect(f.progress.at(-1)?.stage,'CANCELLED_REVIEW_IS_NOT_FOREVER_PENDING').not.toBe('pending');
 }finally{await f.close();}
});

test('a new trigger while prepare waits is refused by real commit and cannot clear any trigger',async()=>{
 const f=await fixture();try{
  f.setTransport(async(url,init)=>{const response=await fetch(url,init);if(url.endsWith('/prepare'))await f.host.add('D');return response;});
  await f.reviewer.markSafe(f.a.id);
  expect(f.requests).toHaveLength(2);expect(f.progress.at(-1)?.stage).toBe('refused');
  expect(f.host.db.query('SELECT COUNT(*) n FROM safety_decisions').get(),'STALE_HOST_REVISION_CANNOT_COMMIT').toEqual({n:0});
  expect((await f.host.history.read(f.host.principal,{sessionId:'ithaca'})).projection.unresolvedCount).toBe(4);
 }finally{await f.close();}
});

test('late commit receipts do not replace a newer live B/C/D projection',async()=>{
 const f=await fixture();try{
  f.setTransport(async(url,init)=>{
   const response=await fetch(url,init);
   if(url.endsWith('/commit')){
    await f.host.add('D');const next=await f.host.history.read(f.host.principal,{sessionId:'ithaca'});
    const old=f.safety.getState();expect(old.update({version:1,identity:next.identity,fromRevision:old.revision,toRevision:next.highWater,projection:next.projection,records:next.records.filter(r=>BigInt(r.sequence)>BigInt(old.revision))})).toBe(true);
   }
   return response;
  });
  await f.reviewer.markSafe(f.a.id);
  expect(f.safety.getState().projection?.unresolvedCount,'LATE_RECEIPT_RETAINS_NEWER_B_C_D').toBe(3);
  expect(f.safety.getState().normal).toBe(false);
  expect(Object.values(f.safety.getState().records).filter(r=>r.kind==='safe_decision').map(r=>r.occurrenceId)).toEqual([f.a.id]);
 }finally{await f.close();}
});

test('a lost commit response remains unknown and no refresh replays it',async()=>{
 const f=await fixture();try{
  f.setTransport(async(url,init)=>{const result=await fetch(url,init);if(url.endsWith('/commit'))throw new Error('Controlled receipt loss');return result;});
  await f.reviewer.markSafe(f.a.id);expect(f.progress.at(-1)?.stage,'LOST_RECEIPT_IS_UNKNOWN').toBe('unknown');
  expect(f.host.db.query('SELECT COUNT(*) n FROM safety_decisions').get()).toEqual({n:1});
  f.safety.getState().refresh();expect(f.requests,'NO_AUTOMATIC_REPLAY_AFTER_UNKNOWN_RESULT').toHaveLength(2);expect(f.safety.getState().normal).toBe(false);
 }finally{await f.close();}
});

test('read-only capability and changed chat selection never send a verdict',async()=>{
 const f=await fixture();try{
  f.safety.setState({capabilities:{...f.safety.getState().capabilities!,review:false}});await f.reviewer.markSafe(f.a.id);
  expect(f.requests,'READ_ONLY_CAPABILITY_CANNOT_REVIEW').toHaveLength(0);
  f.safety.setState({capabilities:f.host.reviews!.capabilities(f.host.principal)});
  const hold=gate();let response:Response;
  f.setTransport(async(url,init)=>{const raw=await fetch(url,init);response=Response.json(await raw.json(),{status:raw.status});hold.entered();return hold.promise;});
  const pending=f.reviewer.markSafe(f.a.id);await hold.arrived;f.chat.setState({activeSessionId:'troy'});hold.release(response!);await pending;
  expect(f.requests,'SELECTING_ANOTHER_CHAT_WITHDRAWS_PREPARED_AUTHORITY').toHaveLength(1);
  expect(f.host.db.query('SELECT COUNT(*) n FROM safety_decisions').get()).toEqual({n:0});
 }finally{await f.close();}
});

test('disconnect after preparation discards authority and a fresh read never resumes the review',async()=>{
 const f=await fixture(),hold=gate();let prepared:Response;try{
  f.setTransport(async(url,init)=>{const response=await fetch(url,init);prepared=Response.json(await response.json(),{status:response.status});hold.entered();return hold.promise;});
  const pending=f.reviewer.markSafe(f.a.id);await hold.arrived;f.safety.getState().disconnected();hold.release(prepared!);await pending;
  expect(f.requests,'DISCONNECT_CANNOT_RESUME_PREPARED_REVIEW').toHaveLength(1);
  const page=await f.host.history.read(f.host.principal,{sessionId:'ithaca'});f.safety.getState().reset(true,f.host.reviews!.capabilities(f.host.principal));f.safety.getState().begin('reconnected');f.safety.getState().page('reconnected',page);
  expect(f.requests,'FRESH_READ_NEVER_REPLAYS_A_DECISION').toHaveLength(1);expect(f.host.db.query('SELECT COUNT(*) n FROM safety_decisions').get()).toEqual({n:0});
 }finally{await f.close();}
});

for(const field of ['occurrenceId','sessionId','historyOwnerId','historyGeneration'] as const)test(`matrix CP-M ${field}: prepared response must match the requested target`,async()=>{
 const f=await fixture(true);try{
 f.setTransport(async(url,init)=>{
  if(!url.endsWith('/future/prepare'))return fetch(url,init);
  const body=JSON.parse(String(init.body));
  // The important same-session case uses a real, valid prepared B response.
  const response=await fetch(url,{...init,body:JSON.stringify({...body,occurrenceId:f.b.id})});const value=await response.json();
  if(field!=='occurrenceId'){value.occurrenceId=f.a.id;value.session={...value.session,[field]:field==='historyGeneration'?'999':'wrong_target'};}
  return Response.json(value,{status:response.status});
 });
 const result=await f.reviewer.prepareFuture(f.a.id,false);
 expect(result,'R3F2_PREPARED_RESPONSE_MUST_MATCH_REQUEST').toBeNull();
 await f.reviewer.commitFuture();expect(f.requests.filter(url=>url.endsWith('/commit'))).toHaveLength(0);
 expect(f.progress.at(-1)?.stage).toBe('refused');expect(f.host.db.query('SELECT count(*) n FROM safety_decisions').get()).toEqual({n:0});
 }finally{await f.close();}
});

const futureBody=(f:Awaited<ReturnType<typeof fixture>>)=>({version:1 as const,session:f.safety.getState().identity as import('@schlessera/brain-ui-sdk/protocol').SafetyReviewBody['session'],occurrenceId:f.a.id,expectedEvidenceRevision:f.safety.getState().revision,verdict:'safe' as const});
test('matrix CP-R: explicit retry replaces the prepared handle; CB-R dispatch consumes it once',async()=>{
 const f=await fixture(true);try{
 const one=await f.reviewer.prepareFuture(f.a.id,false),two=await f.reviewer.prepareFuture(f.a.id,false);expect(two?.requestId).not.toBe(one?.requestId);
 let sent:string|undefined;f.setTransport(async(url,init)=>{if(url.endsWith('/future/commit'))sent=JSON.parse(String(init.body)).requestId;return fetch(url,init);});
 await f.reviewer.commitFuture();await f.reviewer.commitFuture();expect(sent).toBe(two?.requestId);expect(f.requests.filter(u=>u.endsWith('/future/commit'))).toHaveLength(1);expect(f.progress.at(-1)?.stage).toBe('committed');
 }finally{await f.close();}
});
for(const kind of ['pending','quota'] as const)test(`matrix CP-L ${kind}: no parallel preparation or quota bypass`,async()=>{
 const f=await fixture(true);let pressure:{close():Promise<void>}|undefined;const hold=gate();try{
 if(kind==='quota'){const {holdOwnerReviews}=await import('../../ui-server/tests/helpers/held-owner-reviews');pressure=await holdOwnerReviews({...f.host,reviews:f.host.reviews!},futureBody(f));expect(await f.reviewer.prepareFuture(f.a.id,false)).toBeNull();expect(f.progress.at(-1)?.stage).toBe('refused');}
 else{f.setTransport(async(url,init)=>{const response=await fetch(url,init);hold.entered();await hold.promise;return response;});const pending=f.reviewer.prepareFuture(f.a.id,false);await hold.arrived;expect(await f.reviewer.prepareFuture(f.a.id,false)).toBeNull();hold.release(new Response());await pending;expect(f.requests).toHaveLength(1);}
 await f.reviewer.commitFuture();if(kind==='quota')expect(f.requests.filter(u=>u.endsWith('/future/commit'))).toHaveLength(0);
 }finally{hold.release(new Response());await pressure?.close();await f.close();}
});
for(const timing of ['pending','idle'] as const)for(const change of ['owner','evidence','selection','disconnect','capability'] as const)test(`matrix CP-E ${timing} ${change}: withdrawn context cannot commit`,async()=>{
 const f=await fixture(true),hold=gate();try{
 if(timing==='pending')f.setTransport(async(url,init)=>{const response=await fetch(url,init);hold.entered();await hold.promise;return response;});
 const pending=f.reviewer.prepareFuture(f.a.id,false);if(timing==='pending')await hold.arrived;else await pending;
 if(change==='owner')f.revoke();else if(change==='selection')f.chat.setState({activeSessionId:'troy'});else if(change==='evidence')f.safety.setState({revision:'999'});else if(change==='disconnect')f.safety.setState({status:'unavailable'});else f.safety.setState({capabilities:{...f.safety.getState().capabilities!,review:false}});
 hold.release(new Response());await pending;await f.reviewer.commitFuture();expect(f.requests.filter(u=>u.endsWith('/future/commit'))).toHaveLength(0);expect(f.progress.at(-1)?.stage).toBe('refused');
 }finally{hold.release(new Response());await f.close();}
});
test('matrix CP-F: failed explicit retry cannot reuse the old prepared handle',async()=>{
 const f=await fixture(true);try{expect(await f.reviewer.prepareFuture(f.a.id,false)).not.toBeNull();f.setTransport(async()=>{throw new Error('Prepare response lost');});expect(await f.reviewer.prepareFuture(f.a.id,false)).toBeNull();await f.reviewer.commitFuture();expect(f.requests.filter(u=>u.endsWith('/future/commit'))).toHaveLength(0);expect(f.progress.at(-1)?.stage).toBe('refused');}finally{await f.close();}
});
test('matrix CB-L: real review quota yields partial without optimistic ledger replacement',async()=>{
 const f=await fixture(true);let pressure:{close():Promise<void>}|undefined;try{await f.reviewer.prepareFuture(f.a.id,false);const {holdOwnerReviews}=await import('../../ui-server/tests/helpers/held-owner-reviews');pressure=await holdOwnerReviews({...f.host,reviews:f.host.reviews!},futureBody(f));await f.reviewer.commitFuture();expect(f.progress.at(-1)?.stage).toBe('partial');expect(f.safety.getState().projection?.unresolvedCount).toBe(3);}finally{await pressure?.close();await f.close();}
});
test('matrix CB-E: expired publication review is unknown to the client and never replayed',async()=>{
 const f=await fixture(true);try{const p=await f.reviewer.prepareFuture(f.a.id,false);f.host.db.query('UPDATE trust_settings_operations SET expires_at=0 WHERE request_id=?').run(p!.requestId);await f.reviewer.commitFuture();await f.reviewer.commitFuture();expect(f.progress.at(-1)?.stage).toBe('unknown');expect(f.requests.filter(u=>u.endsWith('/future/commit'))).toHaveLength(1);expect(f.safety.getState().projection?.unresolvedCount).toBe(3);}finally{await f.close();}
});
for(const field of ['requestId','session','occurrenceId','nestedSession','nestedOccurrence'] as const)test(`matrix CB-M ${field}: foreign commit receipt is never acknowledged`,async()=>{
 const f=await fixture(true);try{await f.reviewer.prepareFuture(f.a.id,false);f.setTransport(async(url,init)=>{const response=await fetch(url,init);if(!url.endsWith('/future/commit'))return response;const result=await response.json();if(field==='requestId')result.requestId='different_request';else if(field==='session')result.session.sessionId='troy';else if(field==='occurrenceId')result.occurrenceId=f.b.id;else if(field==='nestedSession')result.verdict.session.sessionId='troy';else result.verdict.occurrenceId=f.b.id;return Response.json(result);});await f.reviewer.commitFuture();expect(f.progress.at(-1)?.stage).toBe('unknown');expect(f.safety.getState().projection?.unresolvedCount).toBe(3);}finally{await f.close();}
});
for(const boundary of ['before','after'] as const)test(`matrix CB-F ${boundary}: lost commit response is unknown with no replay`,async()=>{
 const f=await fixture(true);try{await f.reviewer.prepareFuture(f.a.id,false);f.setTransport(async(url,init)=>{if(boundary==='after')await fetch(url,init);throw new Error('Commit response lost');});await f.reviewer.commitFuture();await f.reviewer.commitFuture();expect(f.progress.at(-1)?.stage).toBe('unknown');expect(f.requests.filter(u=>u.endsWith('/future/commit'))).toHaveLength(1);expect(f.safety.getState().projection?.unresolvedCount).toBe(3);expect(f.host.db.query('SELECT count(*) n FROM safety_decisions').get()).toEqual({n:boundary==='after'?1:0});}finally{await f.close();}
});

for(const future of [false,true])test(`fable F1: ${future?'combined':'individual'} own live verdict update before HTTP response still commits`,async()=>{
 const f=await fixture(future);try{
 f.setTransport(async(url,init)=>{const response=await fetch(url,init);if(url.endsWith('/commit')){const result=await response.clone().json();const projection=result.currentProjection;f.safety.setState({revision:projection.evidenceRevision,projection});}return response;});
 if(future){await f.reviewer.prepareFuture(f.a.id,false);await f.reviewer.commitFuture();}else await f.reviewer.markSafe(f.a.id);
 expect(f.progress.at(-1)?.stage,'OWN_LIVE_UPDATE_MUST_NOT_ABORT_COMMIT').toBe('committed');
 }finally{await f.close();}
});
for(const cancel of [false,true])test(`fable F2: prepared future ${cancel?'cancel then ':''}individual review stays recorded after refresh`,async()=>{
 const f=await fixture(true);try{
 await f.reviewer.prepareFuture(f.a.id,false);
 if(cancel)f.reviewer.cancelFuture();
 await f.reviewer.markSafe(f.a.id);expect(f.progress.at(-1)?.stage).toBe('committed');
 const page=await f.host.history.read(f.host.principal,{sessionId:'ithaca'});f.safety.setState({revision:page.highWater});
 expect(f.progress.at(-1)?.message,'UNUSED_FUTURE_HANDLE_CANNOT_RELABEL_COMMITTED_VERDICT').toContain('Decision recorded');
 }finally{await f.close();}
});
