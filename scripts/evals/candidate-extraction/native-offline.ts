/** Actual SDK/native parser/tools against a kernel-networkless scripted endpoint. Not core-auto baseline. */
import { mkdtempSync,mkdirSync,readFileSync,readlinkSync } from "node:fs";
import { join,dirname } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { NativeEvidence } from "./native-evidence";
import { ownedClosure,closureDigest } from "./closure";
import { ROOT,stage,observe } from "./disk-fixture";
import { workload } from "./workload";
import { physicalAccounting } from "./native-accounting";
const MODEL="claude-sonnet-5-5",sha=(v:Buffer)=>createHash("sha256").update(v).digest("hex");
export async function offlineNative(){
 if(process.env.BRAIN_EXTRACTION_OFFLINE!=="1"||!process.env.BRAIN_EXTRACTION_PARENT_NET||readlinkSync("/proc/self/ns/net")===process.env.BRAIN_EXTRACTION_PARENT_NET)throw Error("Require separate owned network namespace");
 const closure=ownedClosure(ROOT),entry=Bun.resolveSync("@anthropic-ai/claude-agent-sdk",join(ROOT,"packages/ui-backend-claude/src"));
 const {query}=await import(entry) as typeof import("@anthropic-ai/claude-agent-sdk");
 const runs:any[]=[];let failure:string|null=null;
 for(const mode of ["cfp-tools","job-tools","no-tools","review"]){
  const c=mode==="job-tools"?workload.find(c=>c.id==="tune-pay")!:workload.find(c=>c.id==="held-html-time")!;
  const brain=stage(c),before=observe(brain.root),home=mkdtempSync(join(tmpdir(),"candidate-native-home-"));mkdirSync(join(home,".claude"));
  const evidence=new NativeEvidence(),physical:any[]=[],hooks:any[]=[],withTools=mode.endsWith("tools")&&mode!=="no-tools";
  const scripted=withTools?[
   {name:"Read",input:{file_path:join(brain.root,"sources/notice.txt")}},
   {name:"Read",input:{file_path:"/etc/passwd"}},
   {name:"Write",input:{file_path:join(brain.root,"owner/letter.md"),content:"attempted overwrite"}},
  ]:[];
  const output=mode==="review"?"APPROVED\nSCRIPTED OFFLINE CONTROL ONLY":JSON.stringify({reportOnly:true,sourceSha:sha(Buffer.from(c.source)),noWriteAuthority:true});
  const server=Bun.serve({hostname:"127.0.0.1",port:0,async fetch(request){
   const bytes=Buffer.from(await request.arrayBuffer()),path=new URL(request.url).pathname,call:any={path,requestBase64:bytes.toString("base64"),requestSha:sha(bytes),status:null,responseBase64:null};physical.push(call);
   if(path!=="/v1/messages"){call.status=404;const raw=Buffer.from("unexpected path");call.responseBase64=raw.toString("base64");return new Response(raw,{status:404});}
   const body=JSON.parse(bytes.toString("utf8"));if(body.model!==MODEL)throw Error("unexpected auxiliary model");
   const step=physical.length-1,tool=scripted[step],id=`msg_${mode}_${step}`;
   const events:any[]=[{type:"message_start",message:{id,type:"message",role:"assistant",model:MODEL,content:[],stop_reason:null,stop_sequence:null,usage:{input_tokens:17,output_tokens:1,cache_creation_input_tokens:0,cache_read_input_tokens:0}}},
    {type:"content_block_start",index:0,content_block:tool?{type:"tool_use",id:`tool_${mode}_${step}`,name:tool.name,input:{}}:{type:"text",text:""}},
    {type:"content_block_delta",index:0,delta:tool?{type:"input_json_delta",partial_json:JSON.stringify(tool.input)}:{type:"text_delta",text:output}},
    {type:"content_block_stop",index:0},{type:"message_delta",delta:{stop_reason:tool?"tool_use":"end_turn",stop_sequence:null},usage:{output_tokens:23}},{type:"message_stop"}];
   const raw=Buffer.from(events.map(e=>`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""));
   Object.assign(call,{status:200,responseBase64:raw.toString("base64"),responseSha:sha(raw),servedModel:MODEL,terminalUsage:{input:17,output:23,cacheRead:0,cacheWrite:0},naturalEof:true});
   return new Response(raw,{headers:{"content-type":"text/event-stream"}});
  }});
  const abortController=new AbortController(),timer=setTimeout(()=>abortController.abort(),30000);let q:any,result:any=null,error:string|null=null;
  try{q=query({prompt:JSON.stringify(brain.request),options:{cwd:brain.root,model:MODEL,systemPrompt:"Report only from the supplied complete source. No write, approval or external-fetch authority. Scripted offline fixture.",
   tools:withTools?["Read","Write"]:[],allowedTools:withTools?["Read"]:[],permissionMode:"default",settingSources:[],settings:{autoMemoryEnabled:false},persistSession:false,mcpServers:{},effort:"low",maxTurns:8,abortController,spawnClaudeCodeProcess:evidence.spawn,
   hooks:{PreToolUse:[{hooks:[async(input:any)=>{const permit=input.tool_name==="Read"&&input.tool_input?.file_path===join(brain.root,"sources/notice.txt");hooks.push({name:input.tool_name,path:input.tool_input?.file_path,permit});return {hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:permit?"allow":"deny",permissionDecisionReason:permit?"Owned exact source":"Report-only fixture denies writes and outside reads"}};}]}]},
   env:{HOME:home,CLAUDE_CONFIG_DIR:join(home,".claude"),PATH:`${dirname(process.execPath)}:/usr/bin:/bin`,ANTHROPIC_API_KEY:"offline-fixture",ANTHROPIC_BASE_URL:`http://127.0.0.1:${server.port}`,ANTHROPIC_DEFAULT_HAIKU_MODEL:MODEL,ANTHROPIC_SMALL_FAST_MODEL:MODEL,CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:"1",CLAUDE_CODE_DISABLE_BACKGROUND_TASKS:"1"}}});
   for await(const frame of q)if(frame.type==="result")result=frame;
  }catch(e){error=String(e);}finally{clearTimeout(timer);try{q?.close();}catch(e){error??=String(e);}}
  const drained=await evidence.drain();server.stop(true);const accounting=evidence.accounting(),after=observe(brain.root);
  const unchanged=JSON.stringify(before)===JSON.stringify(after),history=physical.slice(1).map(p=>JSON.parse(Buffer.from(p.requestBase64,"base64").toString("utf8")).messages);
  const physicalUsage=physicalAccounting(physical,accounting.rows);
  const control={mode,result,error,drained,physical,hooks,unchanged,history,accounting,physicalUsage,processes:evidence.native.processes,rawStdoutBase64:evidence.rawBytes().toString("base64"),rawStderrBase64:evidence.rawStderr().toString("base64"),before,after,
   semanticApproval:false,reviewAdmission:false,writeAuthority:false,coreAutoMeasured:false};runs.push(control);
  if(error||!drained||!accounting.complete||!physicalUsage.complete||!unchanged||result?.is_error!==false||result?.result!==output||physical.length!==scripted.length+1||accounting.rows[0]?.output!==23*physical.length||
   (withTools&&(hooks.length!==3||!hooks[0]?.permit||hooks[1]?.permit||hooks[2]?.permit||!history[0]?.flatMap((m:any)=>Array.isArray(m.content)?m.content:[]).some((b:any)=>b.type==="tool_result"&&typeof b.content==="string"&&b.content.includes(c.source))||!JSON.stringify(history.at(-1)).includes("denies writes")))){failure="Actual offline native extraction control failed";break;}
  brain.close();
 }
 const observed={mode:"scripted fixture permission policy, not installed core-auto performance",ownedClosureSha:closureDigest(closure),sourceEntries:Object.keys(closure).length,runs,failure,drained:runs.every(r=>r.drained),assertionsPassed:failure===null&&runs.length===4,
  sdk:JSON.parse(readFileSync(join(entry,"../package.json"),"utf8")).version,actualAdditionalBilledUsd:null};
 if(failure)throw Object.assign(Error(failure),{observed});return observed;
}
if(import.meta.main){try{console.log(JSON.stringify(await offlineNative()));}catch(e){console.log(JSON.stringify((e as any).observed??{failure:String(e)}));process.exitCode=1;}}
