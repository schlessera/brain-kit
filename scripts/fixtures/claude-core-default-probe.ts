/** Actual core factory, actual bundled CLI, networkless fictional control only. */
import { mkdirSync,writeFileSync,readFileSync,existsSync,appendFileSync } from "node:fs";
import { join } from "node:path";

const [output]=process.argv.slice(2);
if(!output||process.env.BRAIN_CORE_DEFAULT_OFFLINE!=="1")throw Error("Require networkless launcher");
const MODEL="claude-sonnet-5-5",OAUTH=`sk-ant-oat01-${"o".repeat(95)}AA`,world="Odysseus inspects the raft on 2026-07-12.\n";
const sdkManifest=JSON.parse(readFileSync(Bun.resolveSync("@anthropic-ai/claude-agent-sdk/package.json",import.meta.dir),"utf8"));if(sdkManifest.version!=="0.3.293")throw Error("Require actual installedSDK293");
const observations:any[]=[];let physical:any[]=[];
const nativeSpawn=Bun.spawn;let observedSpawn:any;Bun.spawn=((...args:any[])=>observedSpawn(...args)) as typeof Bun.spawn;
const {claudeRunner}=await import("../../packages/core/src/providers/agents/cli-runners");
function reply(content:any[],stop:string){
 const frames=[{type:"message_start",message:{id:"msg_"+crypto.randomUUID(),type:"message",role:"assistant",model:MODEL,content:[],stop_reason:null,stop_sequence:null,usage:{input_tokens:10,output_tokens:0,cache_read_input_tokens:0,cache_creation_input_tokens:0}}},...content.flatMap((block,index)=>block.type==="tool_use"?[{type:"content_block_start",index,content_block:{...block,input:{}}},{type:"content_block_delta",index,delta:{type:"input_json_delta",partial_json:JSON.stringify(block.input)}},{type:"content_block_stop",index}]:[{type:"content_block_start",index,content_block:block},{type:"content_block_stop",index}]),{type:"message_delta",delta:{stop_reason:stop,stop_sequence:null},usage:{output_tokens:8}},{type:"message_stop"}];
 return frames.map(f=>`event: ${f.type}\ndata: ${JSON.stringify(f)}\n\n`).join("");
}
for(const arm of ["allow","deny"]){
 const cwd=join(output,arm),home=join(output,arm+"-home");mkdirSync(cwd,{recursive:true});mkdirSync(home,{recursive:true});
 writeFileSync(join(cwd,"raft.md"),world);mkdirSync(join(cwd,".claude"));
 if(arm==="deny")writeFileSync(join(cwd,".claude/settings.json"),JSON.stringify({permissions:{deny:["Write"]}}));
 const plans=arm==="allow"?[{name:"Read",input:{file_path:join(cwd,"raft.md")}},{name:"Bash",input:{command:process.execPath+" -e 'await Bun.write(\"bash-marker.txt\",\"Odysseus 2026-07-12\")'",description:"Write fictional scratch witness"}},{name:"Write",input:{file_path:join(cwd,"allowed.md"),content:world}}]:[{name:"Write",input:{file_path:join(cwd,"denied.md"),content:world}}];
 let turn=0;physical=[];
 const server=Bun.serve({hostname:"127.0.0.1",port:0,async fetch(req){
  const path=new URL(req.url).pathname;if(path!=="/v1/messages")return Response.json({});
  const raw=await req.text(),body=JSON.parse(raw),entry:any={request:body,rawRequest:raw,requestedModel:body.model,authRoute:req.headers.get("authorization")===`Bearer ${OAUTH}`&&!req.headers.has("x-api-key")?"synthetic-oauth":"refused",servedModel:null,status:200};physical.push(entry);
  if(body.model!==MODEL || !Array.isArray(body.tools) || body.tools.length===0){entry.status=403;entry.forwarded=false;writeFileSync(join(output,arm+"-physical.json"),JSON.stringify(physical,null,2));return Response.json({type:"error",error:{type:"permission_error",message:"Noncanonical auxiliary refused offline"}},{status:403});}
  entry.forwarded=true;entry.servedModel=MODEL;const call=plans[turn++];const bytes=call?reply([{type:"tool_use",id:"tool_"+arm+"_"+turn,name:call.name,input:call.input}],"tool_use"):reply([{type:"text",text:"Odysseus controlled turn complete."}],"end_turn");entry.rawResponse=bytes;writeFileSync(join(output,arm+"-physical.json"),JSON.stringify(physical,null,2));
  return new Response(bytes,{headers:{"content-type":"text/event-stream","anthropic-ratelimit-unified-status":"allowed","anthropic-ratelimit-unified-overage-status":"disabled"}});
 }});
 Object.assign(process.env,{HOME:home,CLAUDE_CONFIG_DIR:join(home,".claude"),CLAUDE_CODE_OAUTH_TOKEN:OAUTH,ANTHROPIC_BASE_URL:`http://127.0.0.1:${server.port}`,ANTHROPIC_MODEL:MODEL,ANTHROPIC_DEFAULT_SONNET_MODEL:MODEL,ANTHROPIC_DEFAULT_OPUS_MODEL:MODEL,ANTHROPIC_DEFAULT_HAIKU_MODEL:MODEL,ANTHROPIC_SMALL_FAST_MODEL:MODEL,CLAUDE_CODE_SUBAGENT_MODEL:MODEL,CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:"1"});
 const original=nativeSpawn;let close:Promise<any>|undefined,stdout:Promise<string>|undefined,stderr:Promise<string>|undefined,args:any,stdin="",forcedKill=false;
 observedSpawn=(command:any,options:any)=>{
  args=command;writeFileSync(join(output,arm+"-args.json"),JSON.stringify(command));const child:any=Reflect.apply(original,Bun,[command,options]);const [out,copy]=child.stdout.tee(),[err,errcopy]=child.stderr!.tee();
  const collect=async(stream:any,path:string)=>{let text="",reader=stream.getReader(),decoder=new TextDecoder();for(;;){const {done,value}=await reader.read();if(done)break;appendFileSync(path,value);text+=decoder.decode(value,{stream:true});}return text+decoder.decode();};stdout=collect(copy,join(output,arm+"-stdout.jsonl"));stderr=collect(errcopy,join(output,arm+"-stderr.bin"));close=child.exited;
  const watchdog=setTimeout(()=>{forcedKill=true;child.kill("SIGKILL");},20000);void child.exited.then(()=>clearTimeout(watchdog));
  const sink=child.stdin!;
  return {stdout:out,stderr:err,exited:child.exited,kill:child.kill.bind(child),stdin:{write(chunk:any){stdin+=typeof chunk==="string"?chunk:Buffer.from(chunk).toString("utf8");writeFileSync(join(output,arm+"-stdin.jsonl"),stdin);return sink.write(chunk);},flush:sink.flush.bind(sink),end:sink.end.bind(sink)}};

 };
 let result:string|null=null,error:string|null=null;const events:any[]=[],runtimes:any[]=[];
 try{const runner=claudeRunner();result=arm==="allow"?await runner.runStreaming!("Inspect and maintain the fictional raft.",{cwd,onEvent:e=>events.push(e),onRuntime:r=>runtimes.push(r)}):await runner.run("Respect the operator's denied Write.",{cwd,timeoutMs:25000,onRuntime:r=>runtimes.push(r)});}catch(e){error=String(e);}
 const [exitCode,rawStdout,rawStderr]=await Promise.all([close,stdout,stderr]);await server.stop(true);
 const record={arm,args,stdin,forcedKill,rawStdout,rawStderr,exitCode,result,error,events,runtimes,physical,bashMarker:existsSync(join(cwd,"bash-marker.txt")),bashContent:existsSync(join(cwd,"bash-marker.txt"))?readFileSync(join(cwd,"bash-marker.txt"),"utf8"):null,allowedContent:existsSync(join(cwd,"allowed.md"))?readFileSync(join(cwd,"allowed.md"),"utf8"):null,deniedWritten:existsSync(join(cwd,"denied.md")),ownedDrained:exitCode!==undefined&&rawStdout!==undefined&&rawStderr!==undefined};observations.push(record);
}
writeFileSync(join(output,"receipt.json"),JSON.stringify({executionKind:"offline-actual-core-native",expectedPair:{sdk:sdkManifest.version,cli:"2.1.293"},observations},null,2),{mode:0o600});
