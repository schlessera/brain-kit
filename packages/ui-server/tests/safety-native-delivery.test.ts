/** Installed Claude file tools against a scripted loopback model and the real host ledger. */
import {expect,test} from "bun:test";
import {request as httpRequest} from "node:http";
import {startInferenceRelay,ANTHROPIC_INFERENCE_ROUTES} from "@schlessera/brain-ui-sdk/internal";
import {resolveGovernancePolicy} from "@schlessera/brain-common/internal/governance-policy";
import {prepareTurnEgress} from "../src/brain/turn-egress";
import {query} from "@anthropic-ai/claude-agent-sdk";
import {mkdirSync,mkdtempSync,rmSync,writeFileSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {createUiDb} from "../src/db/client";
import {openSqliteWriter} from "../src/db/write-worker";
import {createGovernanceWrites} from "../src/governance/event-writes";
import {createSafetyCollector} from "../src/governance/safety-collector";
import {safetyCatalogCreated,safetyRecords} from "../src/governance/safety-store";
import {createPermissionWiring} from "../../ui-backend-claude/src/permission-hooks";
import {MEASURED_RUNTIME} from "../../ui-backend-claude/src/measured-runtime";
import {nativeModelReply} from "../../ui-backend-claude/tests/helpers/native-model-reply";

for(const mode of ["complete","writer-loss"] as const)test(`installed Claude ${mode} preserves the recorder delivery boundary`,async()=>{
 const root=mkdtempSync(join(tmpdir(),"odysseus-safety-native-")),brain=join(root,"brain"),home=join(root,"home");
 mkdirSync(join(brain,"workspaces","voyage"),{recursive:true});mkdirSync(home);
 const path=join(brain,"workspaces","voyage","raft.md");writeFileSync(path,"Odysseus repairs the raft.\n");
 const db=createUiDb(join(root,"ui.db")),writer=openSqliteWriter(db),writes=createGovernanceWrites(db,writer),controller=new AbortController();
 const bindingId=crypto.randomUUID();let version:string|undefined,requests=0,postReached=false,finalizedBeforeProvider=false;
 const trace:string[]=[];
 const timer=setTimeout(()=>controller.abort(),20000);
 const origin=Bun.serve({hostname:"127.0.0.1",port:0,async fetch(request){
  if(new URL(request.url).pathname!=="/v1/messages")return Response.json({});
  const body=JSON.stringify(await request.json());requests++;trace.push(`provider-${requests}:${body.includes("Odysseus repairs the raft")}`);
  if(requests===1)return nativeModelReply({name:"Read",input:{file_path:path},id:"toolu_raft"});
  finalizedBeforeProvider=safetyRecords(db,"ithaca").some(r=>r.kind==="exposure"&&r.state==="finalized");
  return nativeModelReply();
 }});
 const proxy=await prepareTurnEgress({policy:resolveGovernancePolicy({schema_version:1}),bridge:{emit(){},requestPermission:async()=>({behavior:"allow"})},controller:new AbortController(),turnId:"voyage",sessionId:()=>"ithaca",model:()=>null,profile:"governed",origin:"interactive",governanceDb:db,governanceWrites:writes,record:event=>writes.record(event)});
 const relay=startInferenceRelay({upstream:origin.url.origin,routes:ANTHROPIC_INFERENCE_ROUTES,credentials:{"x-api-key":"odysseus-offline-only-key"},egress:proxy});
 // A loopback adapter stands in for the isolated worker's socket transport.
 // Dispatch, credentials and refusal still run through the actual host relay.
 const ingress=Bun.serve({hostname:"127.0.0.1",port:0,async fetch(request){
  if(new URL(request.url).pathname!=="/v1/messages")return Response.json({});
  const body=await request.text();return await new Promise<Response>((resolve,reject)=>{
   const outgoing=httpRequest({socketPath:relay.socketPath,path:new URL(request.url).pathname,method:request.method,headers:{"content-length":String(Buffer.byteLength(body)),"content-type":"application/json","x-brain-provider":"anthropic","x-brain-provider-key":"ANTHROPIC_API_KEY","x-brain-provider-origin":origin.url.origin}},incoming=>{
    const parts:Buffer[]=[];incoming.on("data",chunk=>parts.push(chunk));incoming.on("end",()=>{trace.push(`relay-${incoming.statusCode}:${incoming.statusCode===200?"ok":Buffer.concat(parts).toString()}`);resolve(new Response(Buffer.concat(parts),{status:incoming.statusCode,headers:{"content-type":String(incoming.headers["content-type"]??"application/json")}}));});incoming.on("error",reject);
   });outgoing.on("error",reject);outgoing.end(body);
  });
 }});
 try{
  await writes.safetyBegin({turnId:"voyage",bindingId,sessionId:null,principalId:"odysseus",backendId:"claude",at:0});
  db.exec("INSERT INTO sessions(id,created_at,last_active_at) VALUES('ithaca',0,0); INSERT INTO chat_session_owners VALUES('ithaca','odysseus',0)");
  safetyCatalogCreated(db,"ithaca","odysseus","voyage");await writes.bind("voyage","ithaca");
  const collector=createSafetyCollector(db,writes,{turnId:"voyage",bindingId,backendId:"claude",sessionId:()=>"ithaca",brainPath:brain,shellProxied:()=>false,signal:controller.signal,stop:error=>controller.abort(error)});
  await collector.ready("claude",1);
  const wiring=createPermissionWiring({req:{prompt:"Read the raft plan.",signal:controller.signal,bridge:{emit(){},requestPermission:async()=>({behavior:"allow"}),inputSafety:collector}},allowedTools:["Read"],confirmPatterns:[],brainPath:brain,turnLock:{acquireForTool:async()=>({ok:true}),releaseForTool(){}} as never,childEnv:{PATH:"/usr/bin:/bin"},log(){}});
  const post=wiring.hooks!.PostToolUse!.find(group=>!group.matcher)!.hooks[0]!;
  wiring.hooks!.PostToolUse!.find(group=>!group.matcher)!.hooks=[async(...args)=>{
   postReached=true;trace.push("post-start");
   expect(safetyRecords(db,"ithaca").filter(r=>r.kind==="occurrence"),"SAFETY_INSTALLED_TOOL_ADMITTED_BEFORE_READ").toHaveLength(1);
   if(mode==="writer-loss"){await writer.close();trace.push("writer-closed");}
   const response=await post(...args);trace.push(`post-response:${JSON.stringify(response)}`);return response;
  }];
  let failure:unknown;
  try{for await(const message of query({prompt:"Read the raft plan.",options:{cwd:brain,settingSources:[],model:"claude-sonnet-4-6",maxTurns:2,permissionMode:"default",allowedTools:["Read"],...wiring,abortController:controller,
   env:{HOME:home,CLAUDE_CONFIG_DIR:join(home,".claude"),PATH:process.env.PATH??"/usr/bin:/bin",ANTHROPIC_BASE_URL:ingress.url.origin,ANTHROPIC_API_KEY:"odysseus-offline-only-key",ANTHROPIC_AUTH_TOKEN:undefined,CLAUDE_CODE_OAUTH_TOKEN:undefined,CLAUDE_CODE_USE_BEDROCK:"",CLAUDE_CODE_USE_VERTEX:"",CLAUDE_CODE_USE_FOUNDRY:"",CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:"1"}}})){
    if(message.type==="system"&&message.subtype==="init")version=message.claude_code_version;
   }}catch(error){failure=error;}
  expect(version,"SAFETY_ACTUAL_INSTALLED_RUNTIME").toBe(MEASURED_RUNTIME.claudeCode);
  expect(postReached,`SAFETY_ACTUAL_RESULT_HOOK_EXECUTED ${JSON.stringify(trace)} ${String(failure)}`).toBe(true);
  if(mode==="complete"){
   expect(failure).toBeUndefined();expect(requests).toBe(2);
   expect(finalizedBeforeProvider,"SAFETY_INSTALLED_RESULT_COMMITS_BEFORE_NEXT_PROVIDER_REQUEST").toBe(true);
  }else{
   expect(controller.signal.aborted,"SAFETY_WRITER_LOSS_ABORTS_PROVIDER_DELIVERY").toBe(true);
   expect(requests,`SAFETY_UNRECORDED_RESULT_NEVER_REACHES_PROVIDER ${JSON.stringify(trace)}`).toBe(1);
   expect(writes.safety(null,"ithaca").restriction).toBe("restricted");
  }
 }finally{clearTimeout(timer);controller.abort();ingress.stop(true);relay.stop();proxy.stop();await proxy.settled();origin.stop(true);await writer.close();db.close();rmSync(root,{recursive:true,force:true});}
},30000);
