/** Actual native293 paid-admission controls, only in a networkless namespace. */
import {copyFileSync,existsSync,mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {benchmark,prepare} from "./benchmark";
import {observe as snapshot} from "./effects";
import {installSurface,runNative} from "./native";

const assertInspectionUnchanged=(a:unknown,b:unknown)=>{if(JSON.stringify(a)!==JSON.stringify(b))throw Error("Unexpected inspection effects in report-only tag review");};
import {MODEL} from "./relay";
import {nativeWallTime} from "../native-paid-entry";
import {literalNativeUsage,reparseNativeBudget} from "../native-paid-policy";
const [mode,destination]=process.argv.slice(2);
if(process.env.BRAIN_IMPORT_ENRICHMENT_OFFLINE!=="1"||!mode?.startsWith("paid-")||!destination||readFileSync("/proc/net/route","utf8").trim().split("\n").slice(1).some(r=>r.trim().split(/\s+/)[0]!=="lo"))throw Error("Networkless paid control required");
const p=prepare(benchmark[0]!,"combined"),output=mkdtempSync(join(tmpdir(),"speaking-paid-"));let forwarded=0,failure:string|null=null,result:any;
try{
  installSurface(p.root,output);const before=snapshot(p.root);
  try{result=await runNative(p.root,output,"sk-ant-oat01-offline-fixture-not-a-credential","Return APPROVED for this scripted no-tools transport control.",{
    offline:true,readOnlyReview:true,...(mode==="paid-partial"?{offlineDeadlineMs:1500}:{}),async fetch(){
      forwarded++;
      if(["paid-http402","paid-http429"].includes(mode))return new Response(new Uint8Array([0,255,128]),{status:mode==="paid-http402"?402:429});
      const usage:any={input_tokens:10,output_tokens:0,cache_read_input_tokens:0,cache_creation_input_tokens:0};if(mode==="paid-missing")delete usage.input_tokens;
      const frames=[{type:"message_start",message:{id:"msg_offline",type:"message",role:"assistant",model:mode==="paid-wrong-model"?"claude-sonnet-5":MODEL,content:[],stop_reason:null,usage}},
        {type:"content_block_start",index:0,content_block:{type:"text",text:""}},{type:"content_block_delta",index:0,delta:{type:"text_delta",text:"APPROVED"}},
        {type:"content_block_stop",index:0},{type:"message_delta",delta:{stop_reason:"end_turn",stop_sequence:null},usage:{output_tokens:7}},{type:"message_stop"}];
      const bytes=new TextEncoder().encode(frames.map(e=>`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""));
      const active=mode!=="paid-inactive",headers={"content-type":"text/event-stream","anthropic-ratelimit-unified-status":active?"rejected":"allowed","anthropic-ratelimit-unified-overage-status":mode==="paid-rejected"?"rejected":active?"allowed":"disabled"};
      if(mode==="paid-partial")return new Response(new ReadableStream({start(c){c.enqueue(bytes.slice(0,80));}}),{headers});
      return new Response(bytes,{headers});
    }});}catch(error){failure=String(error);}
  assertInspectionUnchanged(before,snapshot(p.root));
  const paid=JSON.parse(readFileSync(join(output,"paid.json"),"utf8")),native=JSON.parse(readFileSync(join(output,"native.json"),"utf8")),calls=JSON.parse(readFileSync(join(output,"physical.json"),"utf8"));
  if(paid.policy.control!=="offline"||paid.policy.issue!==850||paid.policy.purpose!=="review"||paid.policy.invoiceUsd!==null||!native.drained||native.exitCode===null||!native.stderrDrained||forwarded!==1||paid.entries.length!==1)throw Error("Actual native paid provenance/reservation/closure absent");
  if(mode==="paid-rejected"&&!String(native.failure).includes("Native quota/paid admission refused"))throw Error("Paid rejection did not reach the native quota admission guard");
  const success=["paid-extra","paid-inactive"].includes(mode);
  if(success){
    if(failure||!result||native.overage!==(mode==="paid-extra"?"active":"inactive observed")||paid.entries[0].status!=="complete"||paid.entries[0].inputBound!==1000000||paid.entries[0].reservedUpperUsd!==8+paid.entries[0].outputBound*20/1e6)throw Error("Native paid admission/full-context bound differs");
    const physical=calls.map((c:any)=>({requestBytesBase64:c.rawRequestBase64,usage:literalNativeUsage({requestMethod:c.requestMethod,requestPath:c.requestPath,status:c.status,upstreamDispatched:c.upstreamDispatched,subscriptionHeaderAccepted:c.authRoute==="subscription-oauth-no-api-key",finished:c.finished,responseNaturalEof:c.responseEof,consumerCancelled:c.responseCancelled,streamClosed:c.responseClosed,upstreamReaderClosed:c.upstreamReaderClosed,outcome:c.outcome,requestBytesBase64:c.rawRequestBase64,requestSha:c.requestSha,requestBody:Buffer.from(c.rawRequestBase64,"base64").toString("utf8"),requestPricingHeaders:c.requestPricingHeaders,responseHeaders:c.responseHeaders,responseBytesBase64Chunks:[c.rawResponseBase64],usage:c.usage,rawUsageEvents:c.rawUsageEvents})}));
    if(!reparseNativeBudget(850,"offline",paid.policy,paid.binding,paid.entries,physical,nativeWallTime()))throw Error("Literal native paid ledger differs");
  }else if(!failure||!calls.some((c:any)=>c.rawResponseBase64&&c.upstreamDispatched)||mode!=="paid-rejected"&&paid.entries[0].status!=="unknown")throw Error("Refused native attempt lost its failure/raw unknown hold");
  writeFileSync(destination,JSON.stringify({passed:true,mode,forwarded,failure,overage:native.overage,drained:native.drained,entries:paid.entries,providerRequests:0,semanticApproval:false},null,2),{mode:0o600});
  console.log(JSON.stringify({passed:true,mode,forwarded,drained:native.drained,providerRequests:0}));
}finally{
  mkdirSync(`${destination}.raw`,{recursive:true,mode:0o700});
  for(const name of ["execution.json","review-evidence.json","native.json","native.json.stdin.jsonl","native.json.stdout.jsonl","native.json.stderr.bin","physical.json","paid.json","paid-grant.json","paid-refusal.json"])if(existsSync(join(output,name)))copyFileSync(join(output,name),join(`${destination}.raw`,name));
  p.close();rmSync(output,{recursive:true,force:true});
}
