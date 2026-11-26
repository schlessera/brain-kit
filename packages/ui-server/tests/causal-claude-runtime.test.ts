/** Installed Claude dispatch through the real permission hooks and host ledger. */
import {expect,test} from 'bun:test';
import {query} from '@anthropic-ai/claude-agent-sdk';
import {existsSync,mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {watchdogMs} from '../../../scripts/test-deadlines';
import {createPermissionWiring} from '../../ui-backend-claude/src/permission-hooks';
import {MEASURED_RUNTIME} from '../../ui-backend-claude/src/measured-runtime';
import {nativeModelReply} from '../../ui-backend-claude/tests/helpers/native-model-reply';
import {createUiDb} from '../src/db/client';
import {openSqliteWriter} from '../src/db/write-worker';
import {createGovernanceWrites} from '../src/governance/event-writes';
import {createSafetyCollector} from '../src/governance/safety-collector';
import {createEffectiveSafety} from '../src/governance/effective-safety';
import {safetyCatalogCreated} from '../src/governance/safety-store';
import {holdSafetyRecovery} from './helpers/hold-safety-recovery';

for(const mode of ['healthy','evidence','trust'] as const)test(`installed Claude fences held post-card input: ${mode}`,async()=>{
 const root=mkdtempSync(join(tmpdir(),'odysseus-causal-claude-')),brain=join(root,'brain'),home=join(root,'home');
 mkdirSync(join(brain,'notes/bin'),{recursive:true});mkdirSync(join(brain,'.brain/scratch'),{recursive:true});mkdirSync(home);
 const marker=join(brain,'.brain/scratch/causal-dispatch');
 writeFileSync(join(brain,'notes/bin/git'),`#!/bin/sh\nprintf 'Ithaca\\n' > '${marker}'\n`,{mode:0o755});
 const command='PATH=notes/bin:$PATH git push https://github.com/odysseus/voyage.git main';
 const db=createUiDb(join(root,'ui.db')),writer=openSqliteWriter(db),writes=createGovernanceWrites(db,writer),controller=new AbortController();
 holdSafetyRecovery(db);
 const bindingId=crypto.randomUUID(),entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();
 let held=false,approvals=0,requests=0,trust='0',version:string|undefined;
 const origin=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(request){
  if(new URL(request.url).pathname!=='/v1/messages')return Response.json({});
  const body=await request.json() as {tools?:unknown[]};if(!body.tools?.length)return nativeModelReply();
  requests++;return nativeModelReply(requests===1?{name:'Bash',id:'toolu_causal',input:{command}}:undefined);
 }});
 const timer=setTimeout(()=>controller.abort(),watchdogMs(30000));
 let running:Promise<void>|undefined;
 try{
  await writes.safetyBegin({turnId:'voyage',bindingId,sessionId:null,principalId:'odysseus',backendId:'claude',at:0});
  db.exec("INSERT INTO sessions(id,created_at,last_active_at) VALUES('ithaca',0,0);INSERT INTO chat_session_owners(session_id,principal_id,created_at) VALUES('ithaca','odysseus',0)");
  safetyCatalogCreated(db,'ithaca','odysseus','voyage');await writes.bind('voyage','ithaca');
  const collector=createSafetyCollector(db,writes,{turnId:'voyage',bindingId,backendId:'claude',sessionId:()=> 'ithaca',brainPath:brain,shellProxied:()=>false,signal:controller.signal});await collector.ready('claude',1);
  const safety=createEffectiveSafety(db,{turnId:'voyage',sessionId:()=> 'ithaca',policyHash:null,writes,authority:()=>({current:true,epoch:'0'}),trust:{revision:()=>trust,subscribe:()=>()=>{}}});
  const before=safety.read().evidenceRevision;
  const inputSafety={...collector,async begin(id:string,tool:string,input:Record<string,unknown>){
   await collector.begin(id,tool,input);
   if(tool==='Bash'&&!held){held=true;entered.resolve();await release.promise;}
  }};
  const wiring=createPermissionWiring({req:{prompt:'Return to Ithaca.',signal:controller.signal,bridge:{emit(){},admissionSafety:safety,inputSafety,requestPermission:async()=>{approvals++;return {behavior:'allow'};}}},allowedTools:['Bash'],confirmPatterns:[],brainPath:brain,turnLock:{acquireForTool:async()=>({ok:true}),releaseForTool(){}},childEnv:{PATH:'/usr/bin:/bin'},log(){}} as never);
  running=(async()=>{for await(const message of query({prompt:'Return to Ithaca.',options:{cwd:brain,settingSources:[],model:'claude-sonnet-4-6',maxTurns:2,permissionMode:'default',allowedTools:['Bash'],...wiring,abortController:controller,
   env:{HOME:home,CLAUDE_CONFIG_DIR:join(home,'.claude'),PATH:process.env.PATH??'/usr/bin:/bin',ANTHROPIC_BASE_URL:origin.url.origin,ANTHROPIC_API_KEY:'odysseus-offline-only-key',ANTHROPIC_AUTH_TOKEN:undefined,CLAUDE_CODE_OAUTH_TOKEN:undefined,CLAUDE_CODE_USE_BEDROCK:'',CLAUDE_CODE_USE_VERTEX:'',CLAUDE_CODE_USE_FOUNDRY:'',CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1'}}}))if(message.type==='system'&&message.subtype==='init')version=message.claude_code_version;})();
  await Promise.race([entered.promise,running.then(()=>{throw new Error('Installed Claude never reached the held input wait');})]);
  expect(approvals,'NATIVE_CLAUDE_ACTUALLY_APPROVED_BEFORE_INPUT_WAIT').toBeGreaterThan(0);
  expect(safety.read().evidenceRevision,'NATIVE_CLAUDE_OWN_INPUT_ADVANCES_ROOT_EVIDENCE').not.toBe(before);
  if(mode==='evidence'){await collector.begin('independent','WebFetch',{url:'https://ithaca.invalid/notice'});await collector.result('independent','WebFetch','The harbour is open.',true);}
  if(mode==='trust')trust='1';
  release.resolve();await running;
  expect(version,'NATIVE_CLAUDE_INSTALLED_RUNTIME_EXECUTED').toBe(MEASURED_RUNTIME.claudeCode);
  expect(requests,'NATIVE_CLAUDE_RESULT_REACHES_LOOPBACK_PROVIDER').toBe(2);
  expect(existsSync(marker),'NATIVE_CLAUDE_DISPATCHES_ONLY_WITH_CURRENT_APPROVAL').toBe(mode==='healthy');
  if(mode==='healthy')expect(readFileSync(marker,'utf8'),'NATIVE_CLAUDE_PROCESS_EFFECT_IS_INDEPENDENT_OF_RESULT_FRAMES').toBe('Ithaca\n');
  expect(db.query('SELECT COUNT(*) n FROM safety_obligations').get(),'NATIVE_CLAUDE_REFUSAL_LEAVES_NO_FALSE_RESULT_GAP').toEqual({n:0});
 }finally{release.resolve();controller.abort();await running?.catch(()=>{});clearTimeout(timer);origin.stop(true);await writer.close();db.close();rmSync(root,{recursive:true,force:true});}
},watchdogMs(40000));
