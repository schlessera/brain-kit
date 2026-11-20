import {test,expect} from 'bun:test';
import {safetyHistoryFixture} from './helpers/safety-history-fixture';
import {createSafetyCollector} from '../src/governance/safety-collector';
import {SafetyHistory} from '../src/governance/safety-history';
import {pruneSafetyDetail} from '../src/governance/safety-store';

test('explicit tool entry survives real collection, opt-in paging, pruning and restart',async()=>{
 const f=await safetyHistoryFixture();
 try{
  const collector=createSafetyCollector(f.db,f.writes,{turnId:'voyage',bindingId:f.bindingId,backendId:'claude',sessionId:()=> 'ithaca',shellProxied:()=>true,signal:new AbortController().signal});
  await collector.begin('toolu_odysseus_read','WebFetch',{url:'https://example.com/voyage'});
  await collector.result('toolu_odysseus_read','WebFetch','Odysseus sailing notes',true);
  const old=await f.history.read(f.principal,{sessionId:'ithaca'});
  expect(old.records.find(r=>r.kind==='occurrence'),'DEFAULT_READERS_RETAIN_STRICT_SHAPE').not.toHaveProperty('entry');
  const opted=await f.history.read(f.principal,{sessionId:'ithaca'},null,50,true);
  expect(opted.records.find(r=>r.kind==='occurrence'),'EXACT_HOST_TOOL_CORRELATION').toHaveProperty('entry',{kind:'tool',toolUseId:'toolu_odysseus_read'});
  pruneSafetyDetail(f.db,Number.MAX_SAFE_INTEGER);
  const pruned=await f.history.read(f.principal,{sessionId:'ithaca'},null,50,true);
  expect(pruned.records.find(r=>r.kind==='occurrence'),'PRUNING_RETAINS_MINIMAL_ENTRY_ID').toHaveProperty('entry',{kind:'tool',toolUseId:'toolu_odysseus_read'});
  const restarted=new SafetyHistory(f.db,p=>p.id===f.principal.id,()=>f.writer.idle());try{
   const recovered=await restarted.read(f.principal,{sessionId:'ithaca'},null,50,true);
   expect(recovered.records.find(r=>r.kind==='occurrence'),'RESTART_RETAINS_MINIMAL_ENTRY_ID').toHaveProperty('entry',{kind:'tool',toolUseId:'toolu_odysseus_read'});
  }finally{restarted.close();}
 }finally{await f.close();}
});

test('old WS readers retain their strict shape; opting in pins entry correlation through live deltas',async()=>{
 const f=await safetyHistoryFixture(true,true);
 try{
  const collector=createSafetyCollector(f.db,f.writes,{turnId:'voyage',bindingId:f.bindingId,backendId:'claude',sessionId:()=> 'ithaca',shellProxied:()=>true,signal:new AbortController().signal});
  await collector.begin('tool_a','WebFetch',{url:'https://example.com/odyssey'});await collector.result('tool_a','WebFetch','Voyage notes',true);
  const old=await f.connect();expect(old.hello.type==='server_hello'&&old.hello.capabilities?.sessionSafetyEntryCorrelation).toBe(true);
  expect(old.hello.type==='server_hello'&&old.hello.safetyCapabilities).not.toHaveProperty('entryCorrelation');
  old.send({type:'safety_read',version:1,requestId:'old',target:{sessionId:'ithaca'}});
  const original=await old.until(m=>m.type==='safety_history');if(original.type!=='safety_history')throw new Error('Missing page');
  expect(original.page.records.find(r=>r.kind==='occurrence'),'OLD_READER_SHAPE_REMAINS_STRICT').not.toHaveProperty('entry');
  const next=await f.connect();next.send({type:'safety_read',version:1,requestId:'new',target:{sessionId:'ithaca'},includeEntries:true});
  const frame=await next.until(m=>m.type==='safety_history');if(frame.type!=='safety_history')throw new Error('Missing page');
  expect(frame.page.records.find(r=>r.kind==='occurrence')).toHaveProperty('entry',{kind:'tool',toolUseId:'tool_a'});
  next.send({type:'safety_subscribe',version:1,requestId:'new',identity:frame.page.identity,afterRevision:frame.page.highWater,snapshotId:frame.page.snapshotId});
  await collector.begin('tool_c','WebFetch',{url:'https://example.com/odyssey'});await collector.result('tool_c','WebFetch','Penelope notes',true);f.history.poll();
  const update=await next.until(m=>m.type==='safety_update'&&m.update.records.some(r=>r.kind==='occurrence'&&r.entry?.toolUseId==='tool_c'));
  expect(update.type,'OPTED_SUBSCRIPTION_RETAINS_HOST_TOOL_ID').toBe('safety_update');
  const paged=await f.history.read(f.principal,{sessionId:'ithaca'},null,1,true);expect(paged.nextCursor).not.toBeNull();
  // Await the worker normally: Bun's native rejects matcher does not
  // service worker messages while awaiting this otherwise pending idle.
  let refusal:unknown;try{await f.history.read(f.principal,{sessionId:'ithaca'},paged.nextCursor,1,false);}catch(error){refusal=error;}
  expect(refusal,'CURSOR_CANNOT_CHANGE_NEGOTIATED_SHAPE').toHaveProperty('reason','expired');
 }finally{await f.close();}
});

test('opaque and unsupported tool identities never acquire a guessed entry',async()=>{
 const f=await safetyHistoryFixture();try{
  await f.add('network',true);
  const collector=createSafetyCollector(f.db,f.writes,{turnId:'voyage',bindingId:f.bindingId,backendId:'claude',sessionId:()=> 'ithaca',shellProxied:()=>true,signal:new AbortController().signal});
  await collector.begin('opaque|tool','WebFetch',{url:'https://example.com/odyssey'});await collector.result('opaque|tool','WebFetch','Odysseus notes',true);
  const page=await f.history.read(f.principal,{sessionId:'ithaca'},null,50,true);
  for(const r of page.records.filter(r=>r.kind==='occurrence'))expect(r,'NO_NAME_OR_TIMING_ATTRIBUTION').not.toHaveProperty('entry');
 }finally{await f.close();}
});

test('admission evidence is independently negotiated and pinned across pages, deltas and pruning',async()=>{
 const f=await safetyHistoryFixture(true,true);try{
  const {occurrence}=await import('../src/governance/occurrence');
  const add=async()=>{const o=occurrence(f.bindingId,'proxy_input',crypto.randomUUID(),'finalized');o.provenance={kind:'web_origin',origin:{scheme:'http',host:'127.0.0.1',port:80},verifiedBy:'host_transport'};o.admission={trusted:true,ruleId:'ithaca-source',policyHash:'a'.repeat(64),trustRevision:'7',collectionRevision:'3'};
   await f.writes.record({kind:'taint',sessionId:'ithaca',turnId:'voyage',at:0,actor:'interactive',model:null,profile:'governed',payload:{source:'egress_connection',tool:null,detail:null,occurrence:o}});return o.id;};
  await add();await add();
  const old=await f.history.read(f.principal,{sessionId:'ithaca'},null,50,true);
  expect(old.records.every(r=>!('admission' in r)),'OLD_READERS_RETAIN_STRICT_ADMISSION_SHAPE').toBe(true);
  const opted=await f.history.read(f.principal,{sessionId:'ithaca'},null,1,false,true);expect(opted.records[0]).toHaveProperty('admission.trusted',true);expect(opted.nextCursor).not.toBeNull();
  let refused:unknown;try{await f.history.read(f.principal,{sessionId:'ithaca'},opted.nextCursor,1,false,false);}catch(error){refused=error;}expect(refused,'CURSOR_PINS_ADMISSION_SHAPE').toHaveProperty('reason','expired');
  const ws=await f.connect();expect(ws.hello.type==='server_hello'&&ws.hello.capabilities?.sessionSafetyAdmissionEvidence).toBe(true);
  ws.send({type:'safety_read',version:1,requestId:'admissions',target:{sessionId:'ithaca'},includeAdmissions:true});const frame=await ws.until(m=>m.type==='safety_history');if(frame.type!=='safety_history')throw new Error('Missing page');
  expect(frame.page.records[0]).toHaveProperty('admission.ruleId','ithaca-source');ws.send({type:'safety_subscribe',version:1,requestId:'admissions',identity:frame.page.identity,afterRevision:frame.page.highWater,snapshotId:frame.page.snapshotId});
  const id=await add();f.history.poll();const update=await ws.until(m=>m.type==='safety_update'&&m.update.records.some(r=>r.id===id));expect(update.type==='safety_update'&&update.update.records.some(r=>r.kind==='occurrence'&&r.admission?.trusted),'SUBSCRIPTION_PINS_ADMISSION_EVIDENCE').toBe(true);
  pruneSafetyDetail(f.db,Number.MAX_SAFE_INTEGER);const page=await f.history.read(f.principal,{sessionId:'ithaca'},null,50,false,true);expect(page.records[0]).toHaveProperty('admission.ruleId','ithaca-source');
  const http=await f.get('?admissions=1');expect(http.status).toBe(200);expect((await http.json() as any).records[0]).toHaveProperty('admission.trusted',true);expect((await f.get('?admissions=0')).status).toBe(400);
 }finally{await f.close();}
});
