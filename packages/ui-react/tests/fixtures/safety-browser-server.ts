import {createTrustSettings} from '../../../ui-server/src/brain/trust-settings.js';
import {createKeyedLock} from '@schlessera/brain-ui-sdk/server';
import {CombinedSafetyReviews} from '../../../ui-server/src/governance/combined-safety-reviews.js';
import {createOwnerSafetyReviewRoutes} from '../../../ui-server/src/routes/owner-safety-review.js';
/** Keyless loopback browser fixture: real writer, owner HTTP and WS sidecars. */
import {occurrence} from '../../../ui-server/src/governance/occurrence.js';
import {retireChat} from '../../../ui-server/src/ws/chat-lifecycle.js';
import {Hono} from 'hono';
import {safetyHistoryFixture} from '../../../ui-server/tests/helpers/safety-history-fixture.js';
import {createSafetyCollector} from '../../../ui-server/src/governance/safety-collector.js';
import {createWsUpgrade,websocket} from '../../../ui-server/src/ws/connection.js';
import {pruneSafetyDetail} from '../../../ui-server/src/governance/safety-store.js';
import type {AppEnv} from '../../../ui-server/src/app-env.js';
const f=await safetyHistoryFixture(true,true),at=Date.UTC(2026,6,12,10);
const observedWrites={...f.writes,firstTaint:(input:Parameters<typeof f.writes.firstTaint>[0])=>f.writes.firstTaint({...input,at}),record:(input:Parameters<typeof f.writes.record>[0])=>f.writes.record({...input,at})};
const collector=createSafetyCollector(f.db,observedWrites,{turnId:'voyage',bindingId:f.bindingId,backendId:'claude',sessionId:()=> 'ithaca',shellProxied:()=>true,signal:new AbortController().signal});
async function tool(id:string,finalized=true){await collector.begin(id,'WebFetch',{url:'https://example.com/odyssey'});if(finalized)await collector.result(id,'WebFetch','Odysseus reviews voyage notes.',true);}
await tool('tool_a');await f.add('B',true);
const workspace=occurrence(f.bindingId,'tool_file_input','tool_c','finalized');
workspace.entry={kind:'tool',toolUseId:'tool_c'};
await observedWrites.record({kind:'taint',sessionId:'ithaca',turnId:'voyage',actor:'interactive',model:null,profile:'governed',
 payload:{source:'workspace_read',tool:'Read',detail:'Odysseus voyage notes',occurrence:workspace}});
const app=new Hono<AppEnv>();
// Test-only bootstrap supplies the fixture principal to a real WS host. HTTP
// mutations below still traverse the actual cookie/Origin/owner route stack.
app.get('/ws',async(c,next)=>{c.set('principal',f.principal);return next();},createWsUpgrade(f.host));
const trust=createTrustSettings({root:f.root,db:f.db,writer:f.writer,lock:createKeyedLock(),originEnforcement:true,
 authority:id=>id===f.principal.id&&f.reviews!.authorized(f.principal)?'owner-epoch':null,observe:async(_id,write)=>{await write();}});
f.reviews!.enableFutureRules(trust);
let failVerdict=false,verifiedId:string|null=null;
const originalReview=f.reviews!.review.bind(f.reviews!);
f.reviews!.review=async(...args)=>{if(failVerdict&&args[2]!==null)throw new Error('fixture verdict unavailable');return originalReview(...args);};
const combined=new CombinedSafetyReviews(f.db,f.reviews!,trust);
const futureApp=new Hono<AppEnv>();futureApp.use('*',async(c,next)=>{c.set('principal',f.principal);await next();});
futureApp.route('/api',createOwnerSafetyReviewRoutes(f.reviews!,false,combined));
const inner=f.url.replace('ws:','http:').replace('/ws','');let commits=0,prepares=0;
app.post('/fixture',async c=>{
 const input=await c.req.json();
 if(input.action==='request'){
  if(typeof input.path!=='string'||!/^\/api\/sessions\/ithaca\/safety\/reviews\/(prepare|future\/(prepare|commit|status)|[A-Za-z0-9_-]+\/commit)$/.test(input.path))return c.json({error:'invalid fixture route'},400);
  if(input.path.endsWith('/commit'))commits++;else if(input.path.endsWith('/prepare'))prepares++;
  const response=input.path.includes('/future/')?await futureApp.request(inner+input.path,{method:'POST',headers:{origin:inner,'content-type':'application/json'},body:input.body}):await fetch(inner+input.path,{method:'POST',headers:{cookie:f.cookie,origin:inner,'content-type':'application/json'},body:input.body});
  return c.json({status:response.status,body:await response.json()});
 }
 if(input.action==='expire_future_receipts')f.db.query('UPDATE trust_settings_operations SET retain_until=0').run();
 if(input.action==='fail_combined_verdict')failVerdict=true;
 if(input.action==='remove_future_rule'){
 const p=await trust.list(f.principal.id),rule=p.rules[0];if(!rule)throw new Error('Missing future rule');
 const prepared=await trust.prepare(f.principal.id,{version:1,expectedTrustRevision:p.revision,expectedPolicyHash:p.policyHash,change:{action:'remove',ruleId:rule.id}});
 await trust.commit(f.principal.id,{version:1,requestId:prepared.receipt.requestId,reviewId:prepared.review.reviewId,reviewedBytesHash:prepared.review.reviewedBytesHash});
 }
 if(input.action==='individual_safe'){
 if(!verifiedId)throw new Error('Missing verified occurrence');failVerdict=false;
 const p=f.writes.safety(null,'ithaca'),body={version:1 as const,session:p.session!,occurrenceId:verifiedId,expectedEvidenceRevision:p.evidenceRevision,verdict:'safe' as const};
 const prepared=await originalReview(f.principal,body,null);await originalReview(f.principal,body,prepared.receipt.requestId!);
 }
 if(input.action==='retire'){
  const result=retireChat(f.db,{operationId:'odysseus-retire',principalId:f.principal.id,target:{sessionId:'ithaca'},expected:{backendId:'claude',generation:1},removableBackends:['claude'],at:Date.now()});
  if(result.status!=='retired')throw new Error('Fixture retirement failed');f.host.chatRetired(f.principal.id,result);return c.json({retired:true,commits,prepares});
 }
 if(input.action==='add_verified'){
 const o=occurrence(f.bindingId,'proxy_input',null,'finalized');verifiedId=o.id;o.provenance={kind:'web_origin',origin:{scheme:'https',host:'ithaca.invalid',port:443},verifiedBy:'host_transport'};
 await observedWrites.record({kind:'taint',sessionId:'ithaca',turnId:'voyage',actor:'interactive',model:null,profile:'governed',payload:{source:'egress_connection',tool:'shell',detail:null,occurrence:o}});
 }
 if(input.action==='add')await tool(input.id??'tool_d',input.finalized!==false);
 // The real collector sees two names under one ID (#4513): the host decides attribution.
 if(input.action==='reuse'){collector.admitting?.(input.id??'tool_c','Grep');collector.admitting?.(input.id??'tool_c','Bash');}
 // Nine reused IDs exceed what the host tracks one by one: the whole turn is unknown.
 if(input.action==='reuse-turn')for(let i=0;i<9;i++){collector.admitting?.(`oar_${i}`,'Grep');collector.admitting?.(`oar_${i}`,'Bash');}
 if(input.action==='prune')pruneSafetyDetail(f.db,Number.MAX_SAFE_INTEGER);
 if(input.action==='loss')await f.writes.safetyFail('voyage');
 f.history.poll();
 const page=await f.history.read(f.principal,{sessionId:'ithaca'},null,100,true);
 return c.json({page,commits,prepares,decisions:f.db.query('SELECT occurrence_id FROM safety_decisions').all()});
});
const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch:app.fetch,websocket});
console.log(JSON.stringify({url:`http://127.0.0.1:${server.port}`}));
let closing=false;async function close(){if(closing)return;closing=true;try{server.stop(true);await f.close();process.exit(0);}catch(error){console.error(error);process.exit(1);}}
process.on('SIGTERM',()=>void close());process.on('SIGINT',()=>void close());
