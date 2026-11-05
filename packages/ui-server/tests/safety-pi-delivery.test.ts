/** Installed Pi execution, extension transforms and real SQLite commits before provider delivery. */
import {expect,test} from "bun:test";
import {mkdirSync,mkdtempSync,rmSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {DefaultResourceLoader,SettingsManager} from "@earendil-works/pi-coding-agent";
import {createBrainTools} from "../../ui-backend-pi/src/tools";
import {createBrainAccess} from "../../ui-backend-pi/src/brain-access";
import {createTurnContext} from "../../ui-backend-pi/src/turn-context";
import {nestedToolSafetyGate} from "../../ui-backend-pi/src/tool-safety";
import {Type} from "typebox";
import {createSessionRuntime} from "../../ui-backend-pi/src/native-session-runtime";
import {createUiDb} from "../src/db/client";
import {openSqliteWriter} from "../src/db/write-worker";
import {createGovernanceWrites} from "../src/governance/event-writes";
import {createSafetyCollector} from "../src/governance/safety-collector";
import {safetyCatalogCreated,safetyRecords} from "../src/governance/safety-store";
import * as probe from "./fixtures/write-worker-probe";

for(const mode of ["transformed","extension","writer-loss","nested","blocked"] as const)test(`installed Pi final delivery: ${mode}`,async()=>{
 const root=mkdtempSync(join(tmpdir(),"odysseus-pi-safety-")),agentDir=join(root,"agent");mkdirSync(agentDir);mkdirSync(join(root,"notes"));writeFileSync(join(root,"notes/raft.md"),"Odysseus repairs the raft.\n");
 const db=createUiDb(join(root,"ui.db")),writer=openSqliteWriter(db),writes=createGovernanceWrites(db,writer),controller=new AbortController();
 const bindingId=crypto.randomUUID(),toolName=["extension","nested"].includes(mode)?"mcp__voyage__fetch":"grep",requests:string[]=[];
 let admitted=false,admittedAtExecution=false,executed=false,nestedExecuted=false,finalBeforeRequest=false,session:Awaited<ReturnType<ReturnType<typeof createSessionRuntime>["newSession"]>>["session"]|undefined;
 const origin=Bun.serve({hostname:"127.0.0.1",port:0,async fetch(request){
  const raw=await request.text();requests.push(raw);
  if(requests.length>1)finalBeforeRequest=safetyRecords(db,"ithaca").some(r=>r.kind==="occurrence"&&(r.payload as {source:string}).source===(["extension","nested"].includes(mode)?"mcp_document":"workspace_read"));
  const output=requests.length===1?[{type:"function_call",id:"fc_raft",call_id:"call_raft",name:toolName,arguments:JSON.stringify(toolName==="grep"?{pattern:"Odysseus",path:"notes"}:{})}]:[{type:"message",role:"assistant",id:"msg_raft",status:"completed",content:[{type:"output_text",text:"Ithaca",annotations:[]}]}];
  const response={id:`resp_${requests.length}`,object:"response",status:"completed",model:"gpt-4o-mini",output,usage:{input_tokens:3,output_tokens:5,total_tokens:8,input_tokens_details:{cached_tokens:0}}};
  return new Response([{type:"response.created",response:{...response,status:"in_progress",output:[]}},...output.flatMap(item=>[{type:"response.output_item.added",output_index:0,item},{type:"response.output_item.done",output_index:0,item}]),{type:"response.completed",response}].map(e=>`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""),{headers:{"content-type":"text/event-stream"}});
 }});
 try{
 await writes.safetyBegin({turnId:"voyage",bindingId,sessionId:null,principalId:"odysseus",backendId:"pi",at:0});
 db.exec("INSERT INTO sessions(id,created_at,last_active_at) VALUES('ithaca',0,0); INSERT INTO chat_session_owners VALUES('ithaca','odysseus',0)");safetyCatalogCreated(db,"ithaca","odysseus","voyage");await writes.bind("voyage","ithaca");
 const collector=createSafetyCollector(db,writes,{turnId:"voyage",bindingId,sessionId:()=>"ithaca",backendId:"pi",brainPath:root,shellProxied:()=>false,signal:controller.signal,stop:()=>controller.abort()});await collector.ready("pi",1);
 const hold=writer.channel(probe,{table:"odysseus_log"});await hold.ready;
 const realGrep=createBrainTools({brain:createBrainAccess(root),turn:createTurnContext(),lock:{withKey:async(_key,body)=>body()}}).find(tool=>tool.name==="grep")!;
 const tool={name:toolName,label:"Voyage",description:"Inspect the raft",parameters:Type.Object({}),async execute(){executed=true;admittedAtExecution=admitted;return {content:[{type:"text" as const,text:"notes/raft.md:1: clean"}],details:{}};}};
 const settingsManager=SettingsManager.inMemory({compaction:{enabled:false},transport:"sse"});
 const loader=new DefaultResourceLoader({cwd:root,agentDir,settingsManager,noSkills:true,noPromptTemplates:true,noThemes:true,noExtensions:true,extensionFactories:[nestedToolSafetyGate(),{name:"voyage-result-transform",factory:pi=>{
  if(mode==="extension")pi.registerTool(tool);
  if(mode==="nested"){
   pi.registerTool({...tool,async execute(_id,_args,_signal,_update,ctx){executed=true;admittedAtExecution=admitted;const outcome=await ctx.executeTool("grep",{});return outcome.result;}});
   pi.registerTool({...tool,name:"grep",async execute(){nestedExecuted=true;return {content:[{type:"text",text:"unrecorded nested bytes"}],details:{}};}});
  }
  if(mode==="blocked")pi.on("tool_call",()=>({block:true,reason:"workspaces/voyage/raft.md:1: External instructions"}));
  pi.on("tool_result",event=>{if(["transformed","writer-loss"].includes(mode))expect(JSON.stringify(event.content),"SAFETY_PI_CURATED_GREP_EXECUTED_REAL_COMMAND").toContain("Odysseus repairs the raft.");return mode==="nested"?undefined:({content:[{type:"text",text:"workspaces/voyage/raft.md:1: External instructions"}]});});
 }}]});await loader.reload();
 const modelsPath=join(agentDir,"models.json");writeFileSync(modelsPath,JSON.stringify({providers:{openai:{baseUrl:origin.url.origin+"/v1",api:"openai-responses",apiKey:"odysseus-offline-only",models:[{id:"gpt-4o-mini",name:"Voyage",reasoning:false,input:["text"],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:32000,maxTokens:1000}]}}}));
 const runtime=createSessionRuntime({backend:{brainPath:root,model:"openai/gpt-4o-mini"},sessionDir:root,sessionId:crypto.randomUUID(),observeManager(){},modelRuntimeOptions:{authPath:join(agentDir,"auth.json"),modelsPath,modelsStorePath:join(agentDir,"models-cache.json")},resources:{buildToolkit:()=>({tools:["extension","nested"].includes(mode)?[]:[{...realGrep,execute:(...args:Parameters<typeof realGrep.execute>)=>{executed=true;admittedAtExecution=admitted;return realGrep.execute(...args);}}],turnContext:{}}),build:async()=>({loader,settingsManager})},toolSafety:{
  async permission(name:string,id:string,input:Record<string,unknown>){await collector.begin(id,name,input);admitted=true;return {behavior:"allow"};},
  async result(name:string,id:string,content:{type:string;text?:string}[]){if(mode==="writer-loss")await writer.close();const slow=mode==="writer-loss"?Promise.resolve():hold.call("slow","Ithaca",100);await collector.result(id,name,content.filter(p=>p.type==="text").map(p=>p.text).join("\n"),false);await slow;},
  stop(){controller.abort();},
 }} as unknown as Parameters<typeof createSessionRuntime>[0]);
 session=(await runtime.newSession(undefined,{caps:{}} as never)).session;
 await session.prompt("Inspect the raft.");
 if(mode==="nested")await session.prompt("Continue to Ithaca.");
 expect(executed,"SAFETY_PI_REAL_INSTALLED_TOOL_EXECUTED").toBe(mode!=="blocked");
 if(mode!=="blocked")expect(admittedAtExecution,"SAFETY_PI_EXTENSION_ADMITTED_BEFORE_EXECUTION").toBe(true);
 if(mode==="nested")expect(nestedExecuted,"SAFETY_PI_UNQUALIFIED_NESTED_TOOL_NEVER_EXECUTES").toBe(false);
 if(mode==="writer-loss"){
 expect(requests,"SAFETY_PI_RECORDING_LOSS_STOPS_NEXT_PROVIDER_REQUEST").toHaveLength(1);
 expect(writes.recordingAvailable("voyage","ithaca")).toBe(false);
 }else{
 expect(requests).toHaveLength(2);expect(finalBeforeRequest,"SAFETY_PI_FINAL_TRANSFORM_DURABLE_BEFORE_PROVIDER").toBe(true);
 expect(requests[1]).toContain(mode==="nested"?"Nested tool execution has no qualified final host safety fence":"External instructions");
 const records=safetyRecords(db,"ithaca").filter(r=>r.kind==="occurrence");
 expect(records.length,"SAFETY_PI_FINAL_EXTENSION_OUTPUT_RECORDED").toBeGreaterThan(0);
 expect(writes.safety(null,"ithaca").restriction).toBe("restricted");
 }
 }finally{controller.abort();await session?.abort();session?.dispose();origin.stop(true);await writer.close();db.close();rmSync(root,{recursive:true,force:true});}
},30000);
