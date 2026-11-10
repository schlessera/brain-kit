/** A tool result that reaches the host already exists in the runtime's own
 * session: the installed Claude runtime replays it on resume. So its record
 * must be written whatever happened to the turn, and a record that cannot be
 * written leaves its chat a permanent gap; the chat never looks clean
 * (#3812). A turn stopped while the tool runs reaches neither result hook,
 * so a call admitted by `begin()` owes its record until it is written, and
 * still owing it when the collection ends is a gap. Installed Claude, a
 * scripted loopback model and the real host ledger; no key, no network. */
import {expect,test} from "bun:test";
import {chmodSync,existsSync,mkdirSync,mkdtempSync,rmSync,symlinkSync,writeFileSync} from "node:fs";
import {createRequire} from "node:module";
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

/** The installed runtime is also its own ripgrep: run as `rg`, the binary
 * the SDK spawns searches instead of starting a session. */
function installedRipgrep(root:string):string {
 const sdk=createRequire(createRequire(import.meta.url).resolve("@anthropic-ai/claude-agent-sdk"));
 const real=join(root,"runtime-rg");mkdirSync(real);
 symlinkSync(sdk.resolve("@anthropic-ai/claude-agent-sdk-linux-x64/claude"),join(real,"rg"));
 return join(real,"rg");
}

/** `refused`: the result's reservation fails. `cancelled`: the turn is
 * stopped after the tool ran, just before its result is recorded.
 * `running`: the turn is stopped once the search has printed its matches but
 * before its process exits, so the runtime dispatches neither result hook. */
type Interruption="refused"|"cancelled"|"running";
async function voyageHome(interruption:Interruption,check:(f:{db:ReturnType<typeof createUiDb>;writes:ReturnType<typeof createGovernanceWrites>;
 first:{results:number;failures:number;aborted:boolean};searched:boolean;replayed:string[]})=>void){
 const root=mkdtempSync(join(tmpdir(),"odysseus-safety-retention-")),brain=join(root,"brain"),home=join(root,"home");
 // A note: reading it records nothing before the tool runs, so only the
 // search output's own record stands between it and a complete chat.
 mkdirSync(join(brain,"notes"),{recursive:true});mkdirSync(home);
 const path=join(brain,"notes","sirens.md");writeFileSync(path,`${SONG}\n`);
 // The runtime searches with the `rg` on its PATH. This one is the
 // installed runtime's own ripgrep; it marks when the matches are out and
 // then holds its exit, the window a stop lands in.
 const bin=join(root,"bin"),searched=join(root,"sirens-heard"),rg=installedRipgrep(root);mkdirSync(bin);
 writeFileSync(join(bin,"rg"),`#!/bin/sh
case " $* " in
  *" sirens "*) '${rg}' "$@"; code=$?; : > '${searched}'; sleep 3; exit "$code";;
  *) exec '${rg}' "$@";;
esac
`);chmodSync(join(bin,"rg"),0o755);
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
 async function voyage(turnId:string,sessionId:string|null,interrupt:boolean,resume?:string){
  const controller=new AbortController(),bindingId=crypto.randomUUID();
  await writes.safetyBegin({turnId,bindingId,sessionId,principalId:"odysseus",backendId:"claude",at:turn});
  if(!sessionId){
   db.exec("INSERT INTO sessions(id,created_at,last_active_at) VALUES('ithaca',0,0); INSERT INTO chat_session_owners VALUES('ithaca','odysseus',0)");
   safetyCatalogCreated(db,"ithaca","odysseus",turnId);await writes.bind(turnId,"ithaca");
  }
  const collector=createSafetyCollector(db,writes,{turnId,bindingId,backendId:"claude",sessionId:()=>"ithaca",brainPath:brain,shellProxied:()=>false,signal:controller.signal,stop:error=>controller.abort(error)});
  await collector.ready("claude",1);
  const wiring=createPermissionWiring({req:{prompt:"Listen for the sirens.",signal:controller.signal,bridge:{emit(){},requestPermission:async()=>({behavior:"allow"}),inputSafety:collector}},allowedTools:["Grep"],confirmPatterns:[],brainPath:brain,turnLock:{acquireForTool:async()=>({ok:true}),releaseForTool(){}} as never,childEnv:{PATH:"/usr/bin:/bin"},log(){}});
  let results=0,failures=0;
  if(interrupt){
   // The Grep result exists and the runtime holds it; only its record is at risk.
   const group=wiring.hooks!.PostToolUse!.find(group=>!group.matcher)!,record=group.hooks[0]!;
   group.hooks=[async(...args)=>{
    results++;
    if(interruption==="refused")db.exec("CREATE TRIGGER refuse_result BEFORE INSERT ON safety_pending BEGIN SELECT RAISE(ABORT,'forced result reservation failure'); END");
    else if(interruption==="cancelled")controller.abort(new Error("Odysseus stopped the turn as the result arrived"));
    return record(...args);
   }];
   const failureGroup=wiring.hooks!.PostToolUseFailure!.find(group=>!group.matcher)!,failed=failureGroup.hooks[0]!;
   failureGroup.hooks=[async(...args)=>{failures++;return failed(...args);}];
  }
  // Stop the turn the moment the search has printed its matches.
  const watching=interrupt&&interruption==="running"?setInterval(()=>{if(existsSync(searched))controller.abort(new Error("Odysseus stopped the turn while the search ran"));},5):undefined;
  const timer=setTimeout(()=>controller.abort(),20000);
  try{for await(const message of query({prompt:"Listen for the sirens.",options:{cwd:brain,settingSources:[],model:"claude-sonnet-4-6",maxTurns:2,permissionMode:"default",allowedTools:["Grep"],...wiring,abortController:controller,
   ...(resume?{resume}:{}),
   env:{HOME:home,CLAUDE_CONFIG_DIR:join(home,".claude"),...(interruption==="running"?{PATH:`${bin}:${process.env.PATH??"/usr/bin:/bin"}`,USE_BUILTIN_RIPGREP:"0"}:{PATH:process.env.PATH??"/usr/bin:/bin"}),ANTHROPIC_BASE_URL:origin.url.origin,ANTHROPIC_API_KEY:"odysseus-offline-only-key",ANTHROPIC_AUTH_TOKEN:undefined,CLAUDE_CODE_OAUTH_TOKEN:undefined,CLAUDE_CODE_USE_BEDROCK:"",CLAUDE_CODE_USE_VERTEX:"",CLAUDE_CODE_USE_FOUNDRY:"",CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:"1"}}})){
    if(message.type==="system"&&message.subtype==="init")version=message.claude_code_version;
    if("session_id" in message&&typeof message.session_id==="string")runtimeSession=message.session_id;
   }}catch{/* The interrupted turn is stopped. */}
  finally{clearInterval(watching);clearTimeout(timer);db.exec("DROP TRIGGER IF EXISTS refuse_result");await writes.safetyEnd(turnId);}
  return {results,failures,aborted:controller.signal.aborted};
 }
 try{
  const first=await voyage("voyage",null,true);
  expect(version,"SAFETY_ACTUAL_INSTALLED_RUNTIME").toBe(MEASURED_RUNTIME.claudeCode);
  if(interruption==="running")expect(existsSync(searched),"SAFETY_ACTUAL_SEARCH_RAN").toBe(true);
  expect(first.aborted,"SAFETY_INTERRUPTED_RESULT_STOPS_ITS_TURN").toBe(true);
  expect(runtimeSession,"SAFETY_RUNTIME_SESSION_TO_RESUME").toBeDefined();
  turn=1;
  await voyage("homeward","ithaca",false,runtimeSession);
  const resumed=requests.filter(r=>r.turn===1);
  expect(resumed.length,"SAFETY_ACTUAL_NATIVE_RESUME").toBeGreaterThan(0);
  // What the resumed session carries for the search call: its matches, or
  // the runtime's own "interrupted" note when the stop beat its bookkeeping.
  const replayed=resumed.flatMap(r=>(JSON.parse(r.raw).messages as {content:unknown}[]).flatMap(m=>Array.isArray(m.content)?m.content as {type?:string;tool_use_id?:string;content?:unknown}[]:[]))
   .filter(block=>block.type==="tool_result"&&block.tool_use_id==="toolu_sirens").map(block=>typeof block.content==="string"?block.content:JSON.stringify(block.content));
  expect(replayed.length,"SAFETY_RUNTIME_RESUMES_THE_INTERRUPTED_CALL").toBeGreaterThan(0);
  // The premise: interrupting the record did not keep the result out of the model's context.
  if(interruption!=="running")expect(resumed.some(r=>r.raw.includes(SONG)),"SAFETY_RUNTIME_REPLAYS_THE_INTERRUPTED_RESULT").toBe(true);
  check({db,writes,first,searched:existsSync(searched),replayed});
  // Contained to its chat: the brain-wide recorder is untouched, and a
  // recovery has nothing to clear, so the chat stays restricted.
  expect(db.query("SELECT failed FROM safety_meta").get(),"SAFETY_INTERRUPTED_RESULT_NEVER_LATCHES_THE_BRAIN").toEqual({failed:0});
  recoverSafetyRecording(db,{trigger:"owner",actor:"penelope"});
  expect(writes.safety(null,"ithaca").restriction,"SAFETY_INTERRUPTED_RESULT_SURVIVES_RECOVERY").toBe("restricted");
 }finally{origin.stop(true);await writer.close();db.close();rmSync(root,{recursive:true,force:true});}
}

test("a result refused by the recorder is replayed on resume, so its chat keeps a permanent gap",()=>voyageHome("refused",({db,writes,first})=>{
 expect(first.results,"SAFETY_ACTUAL_RESULT_HOOK_EXECUTED").toBe(1);
 const chat=writes.safety("homeward","ithaca");
 expect(chat.restriction,"SAFETY_REFUSED_RESULT_RESTRICTS_ITS_CHAT").toBe("restricted");
 expect(chat.coverage.state,"SAFETY_REFUSED_RESULT_NEVER_LOOKS_COMPLETE").toBe("incomplete");
 expect(chat.coverage.epochs.find(e=>e.reason==="recording_failed"),"SAFETY_REFUSED_RESULT_IS_A_RECORDING_GAP").toBeDefined();
 expect(db.query("SELECT failure FROM safety_collections WHERE turn_id='voyage'").get(),"SAFETY_REFUSED_RESULT_GAP_IS_DURABLE").toEqual({failure:"recording_failed"});
}),60000);

test("a turn stopped as its result arrives still records the result the runtime replays",()=>voyageHome("cancelled",({db,writes,first})=>{
 expect(first.results,"SAFETY_ACTUAL_RESULT_HOOK_EXECUTED").toBe(1);
 // Stopping a turn stops new tools, never the record of one that already ran.
 const recorded=db.query(`SELECT r.detector FROM safety_records r JOIN safety_collections c ON c.id=r.collection_id
   WHERE c.turn_id='voyage' AND r.kind='occurrence'`).all();
 expect(recorded,"SAFETY_CANCELLED_RESULT_IS_RECORDED").toEqual([{detector:"tool_search_output"}]);
 const chat=writes.safety("homeward","ithaca");
 expect(chat.restriction,"SAFETY_CANCELLED_RESULT_RESTRICTS_ITS_CHAT").toBe("restricted");
 expect(chat.unresolvedCount,"SAFETY_CANCELLED_RESULT_IS_UNRESOLVED").toBe(1);
 expect(chat.reasons,"SAFETY_CANCELLED_RESULT_AWAITS_REVIEW").toContain("unresolved");
 // Recorded, so reviewable: the stop leaves no permanent gap of its own.
 expect(db.query("SELECT failure,gap FROM safety_collections WHERE turn_id='voyage'").get(),"SAFETY_CANCELLED_RECORDED_RESULT_IS_NO_GAP").toEqual({failure:null,gap:null});
 expect(chat.coverage.state,"SAFETY_CANCELLED_RECORDED_RESULT_KEEPS_COVERAGE").toBe("complete");
}),60000);

test("a turn stopped while its search runs reaches neither result hook, and its chat keeps a permanent gap",()=>voyageHome("running",({db,writes,first,replayed})=>{
 // The runtime skips both result hooks for a stopped turn, so the host never
 // sees this result: only the call's admission stands for it.
 expect(first.results+first.failures,"SAFETY_RUNTIME_SKIPPED_BOTH_RESULT_HOOKS").toBe(0);
 // Whether the session kept the matches or only noted the interruption, the
 // call ran and its outcome stayed in the runtime's session.
 expect(replayed.every(text=>text.includes(SONG)||/interrupted/i.test(text)),"SAFETY_RUNTIME_KEEPS_THE_CALL_IN_ITS_SESSION").toBe(true);
 const chat=writes.safety("homeward","ithaca");
 expect(chat.restriction,"SAFETY_UNRECORDED_RESULT_RESTRICTS_ITS_CHAT").toBe("restricted");
 expect(chat.coverage.state,"SAFETY_UNRECORDED_RESULT_NEVER_LOOKS_COMPLETE").toBe("incomplete");
 expect(chat.coverage.epochs.find(e=>e.reason==="recording_failed"),"SAFETY_UNRECORDED_RESULT_IS_A_RECORDING_GAP").toBeDefined();
 const voyage=db.query("SELECT failure,failure_cause FROM safety_collections WHERE turn_id='voyage'").get() as {failure:string|null;failure_cause:string|null};
 expect(voyage.failure,"SAFETY_UNRECORDED_RESULT_GAP_IS_DURABLE").toBe("recording_failed");
 // The gap names the call that still owed its record.
 expect(JSON.parse(voyage.failure_cause??"{}"),"SAFETY_UNRECORDED_RESULT_NAMES_ITS_CALL").toMatchObject({site:"safetyEnd",turnId:"voyage",message:expect.stringContaining("Grep (toolu_sirens)")});
}),60000);
