/** Keyless loopback browser fixture: real writer, owner HTTP and WS sidecars. */
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
await tool('tool_a');await f.add('B',true);await tool('tool_c');
const app=new Hono<AppEnv>();
// Test-only bootstrap supplies the fixture principal to a real WS host. HTTP
// mutations below still traverse the actual cookie/Origin/owner route stack.
app.get('/ws',async(c,next)=>{c.set('principal',f.principal);return next();},createWsUpgrade(f.host));
const inner=f.url.replace('ws:','http:').replace('/ws','');let commits=0,prepares=0;
app.post('/fixture',async c=>{
 const input=await c.req.json();
 if(input.action==='request'){
  if(typeof input.path!=='string'||!/^\/api\/sessions\/ithaca\/safety\/reviews\/(prepare|[A-Za-z0-9_-]+\/commit)$/.test(input.path))return c.json({error:'invalid fixture route'},400);
  if(input.path.endsWith('/commit'))commits++;else prepares++;
  const response=await fetch(inner+input.path,{method:'POST',headers:{cookie:f.cookie,origin:inner,'content-type':'application/json'},body:input.body});
  return c.json({status:response.status,body:await response.json()});
 }
 if(input.action==='retire'){
  const result=retireChat(f.db,{operationId:'odysseus-retire',principalId:f.principal.id,target:{sessionId:'ithaca'},expected:{backendId:'claude',generation:1},removableBackends:['claude'],at:Date.now()});
  if(result.status!=='retired')throw new Error('Fixture retirement failed');f.host.chatRetired(f.principal.id,result);return c.json({retired:true,commits,prepares});
 }
 if(input.action==='add')await tool(input.id??'tool_d',input.finalized!==false);
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
