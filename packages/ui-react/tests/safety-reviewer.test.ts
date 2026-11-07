import {test,expect} from 'bun:test';
import {createStore} from 'zustand/vanilla';
import {safetyHistoryFixture} from '../../ui-server/tests/helpers/safety-history-fixture';
import {createSafetyStore} from '../src/stores/safety-state';
import {createBrainApi} from '../src/lib/api-client';
import {createSafetyReviewer,type SafetyReviewProgress} from '../src/lib/safety-reviewer';
import type {BrainUiServices} from '../src/root';

async function fixture(){
 const host=await safetyHistoryFixture(true,true),a=await host.add('A'),b=await host.add('B'),c=await host.add('C');
 const safety=createSafetyStore(),chat=createStore(()=>({activeSessionId:'ithaca' as string|null})),auth=createStore(()=>({phase:'active' as 'active'|'locked'}));
 safety.getState().reset(true,host.reviews!.capabilities(host.principal));
 const page=await host.history.read(host.principal,{sessionId:'ithaca'});
 safety.getState().begin('snapshot');safety.getState().page('snapshot',page);
 const origin=host.url.replace('ws:','http:').replace('/ws',''),requests:string[]=[],progress:SafetyReviewProgress[]=[];
 let epoch=0,transport:(url:string,init:RequestInit)=>Promise<Response>=(url,init)=>fetch(url,init);
 const api=createBrainApi(()=>origin+'/api',(url,init)=>{requests.push(url);return transport(url,{...init,headers:{...init?.headers,cookie:host.cookie,origin}});});
 const root={api,stores:{safety,chat},authLock:{state:auth,epoch:()=>epoch}} as unknown as BrainUiServices;
 const reviewer=createSafetyReviewer(root,p=>progress.push(p));
 return {host,a,b,c,safety,chat,auth,requests,progress,root,reviewer,setTransport(next:typeof transport){transport=next;},revoke(){epoch++;auth.setState({phase:'locked'});},async close(){reviewer.dispose();await host.close();}};
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
