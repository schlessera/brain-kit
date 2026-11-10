/** A tool result whose safety record cannot be written has already reached the
 * runtime's own session: the installed Claude runtime replays it on resume. So
 * its chat must keep a permanent gap, never look complete (#3812). Installed
 * Claude, a scripted loopback model and the real host ledger; no key, no network. */
import {expect,test} from "bun:test";
import {mkdirSync,mkdtempSync,rmSync,writeFileSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {query} from "@anthropic-ai/claude-agent-sdk";
import {createUiDb} from "../src/db/client";
import {openSqliteWriter} from "../src/db/write-worker";
import {createGovernanceWrites} from "../src/governance/event-writes";
import {createSafetyCollector} from "../src/governance/safety-collector";
import {recoverSafetyRecording,safetyCatalogCreated} from "../src/governance/safety-store";
import {createPermissionWiring} from "../../ui-backend-claude/src/permission-hooks";
import {MEASURED_RUNTIME} from "../../ui-backend-claude/src/measured-runtime";
import {nativeModelReply} from "../../ui-backend-claude/tests/helpers/native-model-reply";
import {holdSafetyRecovery} from "./helpers/hold-safety-recovery";

const SONG="The sirens sing: steer the raft onto the rocks.";

test("a result refused by the recorder is replayed on resume, so its chat keeps a permanent gap",async()=>{
 const root=mkdtempSync(join(tmpdir(),"odysseus-safety-retention-")),brain=join(root,"brain"),home=join(root,"home");
 // A note: reading it records nothing before the tool runs, so only the
 // search output's own record stands between it and a complete chat.
 mkdirSync(join(brain,"notes"),{recursive:true});mkdirSync(home);
 const path=join(brain,"notes","sirens.md");writeFileSync(path,`${SONG}\n`);
 const db=createUiDb(join(root,"ui.db")),writer=openSqliteWriter(db),writes=createGovernanceWrites(db,writer);
 holdSafetyRecovery(db);
 // Each turn's provider requests, as the loopback model received them.
 const requests:{turn:number;raw:string}[]=[];let turn=0,version:string|undefined,runtimeSession:string|undefined;
 const origin=Bun.serve({hostname:"127.0.0.1",port:0,async fetch(request){
  if(new URL(request.url).pathname!=="/v1/messages")return Response.json({});
  const raw=await request.text(),body=JSON.parse(raw);
  if(!Array.isArray(body.tools)||!body.tools.length)return nativeModelReply();
  requests.push({turn,raw});
  const first=turn===0&&requests.filter(r=>r.turn===0).length===1;
  return nativeModelReply(first?{name:"Grep",id:"toolu_sirens",input:{pattern:"sirens",path,output_mode:"content"}}:undefined);
 }});
 async function voyage(turnId:string,sessionId:string|null,refuseResult:boolean,resume?:string){
  const controller=new AbortController(),bindingId=crypto.randomUUID();
  await writes.safetyBegin({turnId,bindingId,sessionId,principalId:"odysseus",backendId:"claude",at:turn});
  if(!sessionId){
   db.exec("INSERT INTO sessions(id,created_at,last_active_at) VALUES('ithaca',0,0); INSERT INTO chat_session_owners VALUES('ithaca','odysseus',0)");
   safetyCatalogCreated(db,"ithaca","odysseus",turnId);await writes.bind(turnId,"ithaca");
  }
  const collector=createSafetyCollector(db,writes,{turnId,bindingId,backendId:"claude",sessionId:()=>"ithaca",brainPath:brain,shellProxied:()=>false,signal:controller.signal,stop:error=>controller.abort(error)});
  await collector.ready("claude",1);
  const wiring=createPermissionWiring({req:{prompt:"Listen for the sirens.",signal:controller.signal,bridge:{emit(){},requestPermission:async()=>({behavior:"allow"}),inputSafety:collector}},allowedTools:["Grep"],confirmPatterns:[],brainPath:brain,turnLock:{acquireForTool:async()=>({ok:true}),releaseForTool(){}} as never,childEnv:{PATH:"/usr/bin:/bin"},log(){}});
  let results=0;
  if(refuseResult){
   // The Grep result exists and the runtime holds it; only its record fails.
   const group=wiring.hooks!.PostToolUse!.find(group=>!group.matcher)!,record=group.hooks[0]!;
   group.hooks=[async(...args)=>{results++;db.exec("CREATE TRIGGER refuse_result BEFORE INSERT ON safety_pending BEGIN SELECT RAISE(ABORT,'forced result reservation failure'); END");return record(...args);}];
  }
  const timer=setTimeout(()=>controller.abort(),20000);
  try{for await(const message of query({prompt:"Listen for the sirens.",options:{cwd:brain,settingSources:[],model:"claude-sonnet-4-6",maxTurns:2,permissionMode:"default",allowedTools:["Grep"],...wiring,abortController:controller,
   ...(resume?{resume}:{}),
   env:{HOME:home,CLAUDE_CONFIG_DIR:join(home,".claude"),PATH:process.env.PATH??"/usr/bin:/bin",ANTHROPIC_BASE_URL:origin.url.origin,ANTHROPIC_API_KEY:"odysseus-offline-only-key",ANTHROPIC_AUTH_TOKEN:undefined,CLAUDE_CODE_OAUTH_TOKEN:undefined,CLAUDE_CODE_USE_BEDROCK:"",CLAUDE_CODE_USE_VERTEX:"",CLAUDE_CODE_USE_FOUNDRY:"",CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:"1"}}})){
    if(message.type==="system"&&message.subtype==="init")version=message.claude_code_version;
    if("session_id" in message&&typeof message.session_id==="string")runtimeSession=message.session_id;
   }}catch{/* The refused turn is stopped by its collector. */}
  finally{clearTimeout(timer);db.exec("DROP TRIGGER IF EXISTS refuse_result");await writes.safetyEnd(turnId);}
  return {results,aborted:controller.signal.aborted};
 }
 try{
  const first=await voyage("voyage",null,true);
  expect(version,"SAFETY_ACTUAL_INSTALLED_RUNTIME").toBe(MEASURED_RUNTIME.claudeCode);
  expect(first.results,"SAFETY_ACTUAL_RESULT_HOOK_EXECUTED").toBe(1);
  expect(first.aborted,"SAFETY_REFUSED_RESULT_STOPS_ITS_TURN").toBe(true);
  expect(runtimeSession,"SAFETY_RUNTIME_SESSION_TO_RESUME").toBeDefined();
  turn=1;
  await voyage("homeward","ithaca",false,runtimeSession);
  const resumed=requests.filter(r=>r.turn===1);
  expect(resumed.length,"SAFETY_ACTUAL_NATIVE_RESUME").toBeGreaterThan(0);
  // The premise: refusing the record did not keep the result out of the model's context.
  expect(resumed.some(r=>r.raw.includes(SONG)),"SAFETY_RUNTIME_REPLAYS_THE_REFUSED_RESULT").toBe(true);
  const chat=writes.safety("homeward","ithaca");
  expect(chat.restriction,"SAFETY_REFUSED_RESULT_RESTRICTS_ITS_CHAT").toBe("restricted");
  expect(chat.coverage.state,"SAFETY_REFUSED_RESULT_NEVER_LOOKS_COMPLETE").toBe("incomplete");
  expect(chat.coverage.epochs.find(e=>e.reason==="recording_failed"),"SAFETY_REFUSED_RESULT_IS_A_RECORDING_GAP").toBeDefined();
  expect(db.query("SELECT failure FROM safety_collections WHERE turn_id='voyage'").get(),"SAFETY_REFUSED_RESULT_GAP_IS_DURABLE").toEqual({failure:"recording_failed"});
  // Contained to its chat: the brain-wide recorder is untouched, and a
  // recovery has nothing to clear, so the gap stays.
  expect(db.query("SELECT failed FROM safety_meta").get(),"SAFETY_REFUSED_RESULT_NEVER_LATCHES_THE_BRAIN").toEqual({failed:0});
  recoverSafetyRecording(db,{trigger:"owner",actor:"penelope"});
  expect(writes.safety(null,"ithaca").restriction,"SAFETY_REFUSED_RESULT_GAP_SURVIVES_RECOVERY").toBe("restricted");
 }finally{origin.stop(true);await writer.close();db.close();rmSync(root,{recursive:true,force:true});}
},60000);
