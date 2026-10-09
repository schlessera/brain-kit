/** Real installed SDK/native CLI with a scripted Messages endpoint. Namespace-only fixture; no live entry. */
import { mkdirSync, mkdtempSync, readlinkSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { NativeEvidence } from "./native-evidence";
import { ownedClosure, closureDigest } from "./closure";
import { CORPUS } from "./corpus";
import { parseRows } from "../score";
const MODEL="claude-sonnet-5-5";
export async function offlineNative() {
 const root=join(import.meta.dir,"../../../../..");
 if(process.env.BRAIN_TRIAGE_OFFLINE!=="1" || !process.env.BRAIN_TRIAGE_PARENT_NET || readlinkSync("/proc/self/ns/net")===process.env.BRAIN_TRIAGE_PARENT_NET)
  throw Error("Require owned offline launcher and separate network namespace");
 const closure=ownedClosure(root);
 const sdkEntry=Bun.resolveSync("@anthropic-ai/claude-agent-sdk",join(root,"packages/ui-backend-claude/src"));
 const {query}=await import(sdkEntry) as typeof import("@anthropic-ai/claude-agent-sdk");
 const home=mkdtempSync(join(tmpdir(),"triage-native-"));mkdirSync(join(home,".claude"));
 const evidence=new NativeEvidence(),physical:any[]=[];
 const rows=CORPUS.slice(0,8).map(i=>({id:i.id,route:i.gold.route,stakes:1,summary:""})),text=JSON.stringify(rows);
 const server=Bun.serve({hostname:"127.0.0.1",port:0,async fetch(request){
  const path=new URL(request.url).pathname,bytes=Buffer.from(await request.arrayBuffer());
  const call:any={path,requestBase64:bytes.toString("base64"),responseBase64:null,status:null};physical.push(call);
  if(path!=="/v1/messages"){const text=JSON.stringify({error:"fixture rejects non-Messages path"});call.status=404;call.responseBase64=Buffer.from(text).toString("base64");return new Response(text,{status:404});}
  const body=JSON.parse(bytes.toString("utf8"));
  if(body.model!==MODEL)throw Error("Fixture refuses unexpected auxiliary model");
  const id="msg_"+crypto.randomUUID(),events=[
   {type:"message_start",message:{id,type:"message",role:"assistant",model:MODEL,content:[],stop_reason:null,stop_sequence:null,usage:{input_tokens:17,output_tokens:1,cache_creation_input_tokens:0,cache_read_input_tokens:0}}},
   {type:"content_block_start",index:0,content_block:{type:"text",text:""}},
   {type:"content_block_delta",index:0,delta:{type:"text_delta",text}},
   {type:"content_block_stop",index:0},
   {type:"message_delta",delta:{stop_reason:"end_turn",stop_sequence:null},usage:{output_tokens:23}},
   {type:"message_stop"},
  ];
  const response=events.map(event=>`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
  Object.assign(call,{responseBase64:Buffer.from(response).toString("base64"),status:200,servedModel:MODEL,terminalUsage:{input:17,output:23,cacheRead:0,cacheWrite:0}});
  return new Response(response,{headers:{"content-type":"text/event-stream"}});
 }});
 const controller=new AbortController();const timeout=setTimeout(()=>controller.abort(),30000);
 const rubric=readFileSync(join(root,"packages/ui-server/evals/triage/prompt.txt"),"utf8");
 const user=JSON.stringify(CORPUS.slice(0,8).map(({id,source,title,body})=>({id,source,title,body})),null,1);
 let result:any=null,failure:string|null=null,q:any;
 try {
  q=query({prompt:user,options:{cwd:home,model:MODEL,systemPrompt:rubric,permissionMode:"default",tools:[],allowedTools:[],mcpServers:{},
    settingSources:[],settings:{autoMemoryEnabled:false},persistSession:false,maxTurns:1,effort:"low",abortController:controller,spawnClaudeCodeProcess:evidence.spawn,
    env:{HOME:home,CLAUDE_CONFIG_DIR:join(home,".claude"),PATH:`${process.execPath.slice(0,process.execPath.lastIndexOf("/"))}:/usr/bin:/bin`,
      ANTHROPIC_API_KEY:"offline-fixture",ANTHROPIC_BASE_URL:`http://127.0.0.1:${server.port}`,ANTHROPIC_DEFAULT_HAIKU_MODEL:MODEL,ANTHROPIC_SMALL_FAST_MODEL:MODEL,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:"1",CLAUDE_CODE_DISABLE_BACKGROUND_TASKS:"1"}}});
  for await(const frame of q)if(frame.type==="result")result=frame;
 }catch(error){failure=String(error);}finally{clearTimeout(timeout);try{q?.close();}catch(error){failure ??= String(error);}}
 const drained=await evidence.drain();server.stop(true);
 const parsed=parseRows(result?.result ?? ""),accounting=evidence.accounting();
 const observed={mode:"scripted offline SDK fixture, not current donor/core performance",sourceEntries:Object.keys(closure).length,ownedClosureSha:closureDigest(closure),
  sdk:JSON.parse(readFileSync(join(sdkEntry,"../package.json"),"utf8")).version,result,failure,drained,physical,
  rawStdoutBase64:evidence.rawBytes().toString("base64"),rawStderrBase64:evidence.rawStderr().toString("base64"),frames:evidence.frames,
  processes:evidence.native.processes,accounting,parsedRows:parsed};
 if(failure || !drained || !accounting.complete || !parsed || JSON.stringify(parsed)!==JSON.stringify(rows) || physical.length!==1 || accounting.rows[0]?.output!==23)
  throw Object.assign(Error("Native triage fixture failed"),{observed});
 return observed;
}
if(import.meta.main) {
 try {console.log(JSON.stringify(await offlineNative()));}catch(error){console.log(JSON.stringify((error as any).observed ?? {failure:String(error)}));process.exitCode=1;}
}
