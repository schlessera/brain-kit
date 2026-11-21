/** Installed ordinary Pi backend, confined by the parent network namespace. */
import {cpSync,mkdirSync,readFileSync,readlinkSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import type {BackendBridge,ServerMessage} from '@schlessera/brain-ui-sdk/server';
import {createPiBackend} from '../../packages/ui-backend-pi/src/backend';
import {createUiDb} from '../../packages/ui-server/src/db/client';
import {openSqliteWriter} from '../../packages/ui-server/src/db/write-worker';
import {createGovernanceWrites} from '../../packages/ui-server/src/governance/event-writes';
import {createSafetyCollector} from '../../packages/ui-server/src/governance/safety-collector';
import {createEffectiveSafety} from '../../packages/ui-server/src/governance/effective-safety';
import {safetyCatalogCreated} from '../../packages/ui-server/src/governance/safety-store';
import {holdSafetyRecovery} from '../../packages/ui-server/tests/helpers/hold-safety-recovery';
import {createFixtureTurnHost} from './turn-host-fixture';
import {startFixtureTurn} from './worker-input-fixture';
import {watchdogMs} from '../../scripts/test-deadlines';
import {prepareWorkerSandbox} from '../../packages/ui-sdk/src/server/worker-launcher';

const [mode,root,parentNetwork]=process.argv.slice(2) as [string,string,string];
const isolatedNetwork=readlinkSync('/proc/self/ns/net')!==parentNetwork;
if(!isolatedNetwork)throw new Error('Installed Pi proof requires an isolated network namespace');
const brain=join(root,'brain'),agent=join(root,'agent');
cpSync(resolve('packages/core/fixtures/corpus'),brain,{recursive:true});mkdirSync(agent);
const config=join(brain,'brain.config.ts');writeFileSync(config,readFileSync(config,'utf8').replace('"@schlessera/brain"',JSON.stringify(resolve('packages/core/src/index.ts'))));
mkdirSync(join(brain,'notes/bin'),{recursive:true});
const marker=join(brain,'.brain/scratch/causal-dispatch');mkdirSync(join(brain,'.brain/scratch'),{recursive:true});
writeFileSync(join(brain,'notes/bin/git'),`#!/bin/sh\nprintf 'Ithaca\\n' > '${marker}'\n`,{mode:0o755});
process.env.PI_CODING_AGENT_DIR=agent;
writeFileSync(join(agent,'settings.json'),JSON.stringify({retry:{enabled:false},compaction:{enabled:false},cacheWarming:'off'}));
let requests=0,approvals=0;const frames:ServerMessage[]=[],order:string[]=[];
const command='PATH=notes/bin:$PATH git push https://github.com/odysseus/voyage.git main';
const origin=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(request){
 const body=await request.json() as {tools?:{name:string}[]};requests++;
 if(!body.tools?.some(tool=>tool.name==='bash'))throw new Error('Installed backend did not advertise bash');
 const events:Record<string,unknown>[]=[{type:'message_start',message:{id:'voyage_reply',type:'message',role:'assistant',model:'claude-sonnet-4-6',content:[],stop_reason:null,stop_sequence:null,usage:{input_tokens:3,output_tokens:0,cache_read_input_tokens:0,cache_creation_input_tokens:0}}}];
 if(requests===1)events.push({type:'content_block_start',index:0,content_block:{type:'tool_use',id:'call_causal',name:'bash',input:{}}},{type:'content_block_delta',index:0,delta:{type:'input_json_delta',partial_json:JSON.stringify({command})}},{type:'content_block_stop',index:0});
 else events.push({type:'content_block_start',index:0,content_block:{type:'text',text:''}},{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'Odysseus returns to Ithaca.'}},{type:'content_block_stop',index:0});
 events.push({type:'message_delta',delta:{stop_reason:requests===1?'tool_use':'end_turn',stop_sequence:null},usage:{output_tokens:5}},{type:'message_stop'});
 return new Response(events.map(event=>`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''),{headers:{'content-type':'text/event-stream'}});
}});
writeFileSync(join(agent,'models.json'),JSON.stringify({providers:{anthropic:{baseUrl:origin.url.origin,apiKey:'odysseus-offline-only-key'}}}));
const db=createUiDb(join(root,'ui.db')),writer=openSqliteWriter(db),writes=createGovernanceWrites(db,writer);holdSafetyRecovery(db);
const host=createFixtureTurnHost(brain,db),controller=new AbortController(),bindingId=crypto.randomUUID();
await writes.safetyBegin({turnId:'voyage',bindingId,sessionId:null,principalId:'odysseus',backendId:'pi',at:0});
db.exec("INSERT INTO sessions(id,created_at,last_active_at,backend_id) VALUES('ithaca',0,0,'pi');INSERT INTO chat_session_owners(session_id,principal_id,created_at) VALUES('ithaca','odysseus',0)");
safetyCatalogCreated(db,'ithaca','odysseus','voyage');await writes.bind('voyage','ithaca');
const collector=createSafetyCollector(db,writes,{turnId:'voyage',bindingId,sessionId:()=> 'ithaca',backendId:'pi',brainPath:brain,shellProxied:()=>false,signal:controller.signal});await collector.ready('pi',1);
const safety=createEffectiveSafety(db,{turnId:'voyage',sessionId:()=> 'ithaca',policyHash:null,writes,authority:()=>({current:true,epoch:'0'}),trust:{revision:()=> '0',subscribe:()=>()=>{}}});
if(mode==='evidence-blind'){
 const original=collector.forAdmission!;collector.forAdmission=(id,tool,root)=>{const view=original(id,tool,root);return {read:()=>({...view.read(),evidenceRevision:'0'}),subscribe:changed=>view.subscribe(changed)};};
}
const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();let held=false;
const bridge:BackendBridge={emit(frame){if(mode==='evidence-blind'&&frame.type==='tool_result')return;frames.push(frame);},admissionSafety:safety,activity(){},requestPermission:async()=>{approvals++;order.push('approved');return {behavior:'allow'};},inputSafety:{...collector,async begin(id,tool,input){
 await collector.begin(id,tool,input);
 if(tool==='bash'&&!held){held=true;order.push('input-held');entered.resolve();await release.promise;order.push('input-released');}
}}};
const backend=createPiBackend({brainPath:brain,sessionDir:join(root,'sessions'),loadExtensions:false,profiles:[{id:'fixture',label:'Voyage',vendor:'anthropic',model:'claude-sonnet-4-6',thinkingLevel:'off'}],confirmBashPatterns:[]});
const before=safety.read().evidenceRevision;
const timer=setTimeout(()=>controller.abort(),watchdogMs(90000));
let running:Promise<void>|undefined;
try{
 const sandbox={...prepareWorkerSandbox(brain,{profile:'governed',areas:['scratch'],maintenance:host.maintenance}),commandPolicy:{hash:null,deny:[],confirm:[],outwardAllow:[],taint:()=>writes.taint('voyage','ithaca')}};
 if(sandbox.profile!=='governed')throw new Error('Installed Pi proof requires the governed data-tree profile');
 running=startFixtureTurn(backend,brain,{prompt:'Return to Ithaca.',profileId:'fixture',signal:controller.signal,bridge,workerSandbox:sandbox});
 await Promise.race([entered.promise,running.then(()=>{throw new Error('Installed backend never reached the held input wait');})]);
 if(approvals===0)throw new Error('The held input was not preceded by an outward approval');
 if(mode!=='healthy'){
  await collector.begin('independent','WebFetch',{url:'https://ithaca.invalid/notice'});
  await collector.result('independent','WebFetch','The harbour is open.',true);order.push('independent-committed');
 }
 release.resolve();await running;
 console.log(JSON.stringify({isolatedNetwork,held,approvals,requests,order,frames,ownInputs:(db.query("SELECT COUNT(*) n FROM safety_records WHERE kind='occurrence' AND detector='unproxied_shell_input'").get() as {n:number}).n,before,after:safety.read().evidenceRevision,owed:db.query('SELECT COUNT(*) n FROM safety_obligations').get(),failure:db.query("SELECT failure FROM safety_collections WHERE turn_id='voyage'").get()}));
}finally{release.resolve();controller.abort();await running?.catch(()=>{});clearTimeout(timer);origin.stop(true);try{await host.close();}finally{try{await writer.close();}finally{db.close();}}}
