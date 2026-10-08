/** Actual native293 paid transport controls. No external network or semantic approval. */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join,dirname } from "node:path";
import { strict as assert } from "node:assert";
import { sha } from "./adapter";
import { runtimeIdentity } from "./binding";
import { runReview } from "./review-run";
import { EXTRA_USAGE_AUTHORIZATION, type RootPaidPolicy } from "./paid-policy";
import { validateReviewEvidence } from "./review-evidence";
if (process.env.BRAIN_TRIAGE_REVIEW_OFFLINE !== "1" || readFileSync("/proc/net/route", "utf8").trim().split("\n").slice(1).some(r=>r.trim().split(/\s+/)[0]!=="lo")) throw Error("Actual offline namespace required");
const [mode,output]=process.argv.slice(2);if(!mode||!output)throw Error("Mode/fresh output required");
const modes=["paid","inactive","paid-rejected","http402","http429","missing-usage","wrong-model","partial"];
if(!modes.includes(mode))throw Error("Unknown controlled mode");
const prompt="Independently review this complete fictional Odysseus transport fixture. Return APPROVED only for the scripted transport format; this is no semantic approval.";
const runtime=runtimeIdentity(),binding={freezeSha:sha("offline-only-freeze"),inputSha:sha("offline-only-input"),protocolSha:sha("offline-only-protocol"),proofSha:sha("offline-only-proof"),runtimeSha:sha(JSON.stringify(runtime)),promptSha:sha(prompt)};
const grantNonce=sha(`offline-${mode}-${output}`);
const policy:RootPaidPolicy={...binding,grantNonce,consumedMarkerPath:join(dirname(output),`${grantNonce}.json`),version:1,issue:848,authorizationUrl:EXTRA_USAGE_AUTHORIZATION,allowOverage:true,basis:"actual additional billed charges",perIssueCapUsd:15,aggregateCapUsd:150,remainingUpperUsd:15,issuedAt:new Date(Date.now()-1000).toISOString(),expiresAt:new Date(Date.now()+60000).toISOString(),canonicalModel:"claude-sonnet-5-5",maxPhysicalRequests:24,maxInputBytes:5_000_000,maxInputTokens:1_000_000,contextWindowTokens:1_000_000,maxOutputTokens:128000,inputUsdPerMillionUpper:8,outputUsdPerMillionUpper:20,invoiceUsd:null};
let requests=0;
const options:Parameters<typeof runReview>[0]={output,prompt,policy,policySha:sha(JSON.stringify(policy)),binding,token:"sk-ant-oat01-offline-848-not-a-credential",offline:true,offlineDeadlineMs:5000,
 offlineFetch:async(_url,init)=>{
  requests++;const request=JSON.parse(new TextDecoder().decode(init.body as Uint8Array));assert.equal(request.model,"claude-sonnet-5-5");assert.equal(request.tools?.length??0,0);assert.equal(request.output_config.effort,"low");
  const usage:any={input_tokens:17,output_tokens:0,cache_read_input_tokens:0,cache_creation_input_tokens:0,service_tier:"standard",inference_geo:"not_available"};if(mode==="missing-usage")delete usage.cache_read_input_tokens;
  const events=[{type:"message_start",message:{id:"msg_offline_1296",type:"message",role:"assistant",model:mode==="wrong-model"?"unexpected-model":"claude-sonnet-5-5",content:[],stop_reason:null,usage}},
   {type:"content_block_start",index:0,content_block:{type:"text",text:""}},{type:"content_block_delta",index:0,delta:{type:"text_delta",text:"APPROVED offline transport format only"}},
   {type:"content_block_stop",index:0},{type:"message_delta",delta:{stop_reason:"end_turn",stop_sequence:null},usage:{output_tokens:23}},{type:"message_stop"}];
  const headers:Record<string,string>={"content-type":"text/event-stream","anthropic-ratelimit-unified-status":mode==="inactive"?"allowed":"rejected","anthropic-ratelimit-unified-overage-status":mode==="paid-rejected"?"rejected":"allowed"};
  if(mode==="http402"||mode==="http429")return Response.json({error:{type:"rate_limit_error",message:"Authored offline paid request refusal"}},{status:mode==="http402"?402:429,headers});
  const bytes=Buffer.from(events.map(e=>`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""));
  if(mode==="partial")return new Response(new ReadableStream<Uint8Array>({start(c){c.enqueue(bytes.subarray(0,80));},cancel(){}}),{headers});
  return new Response(bytes,{headers});
 }};
const observed=await runReview(options);
const successful=mode==="paid"||mode==="inactive";
const beforeReuse=requests;
await assert.rejects(runReview({...options,output:output+"-reuse"}),/EEXIST/);
assert.equal(requests,beforeReuse,"consumed grant reuse must not forward even with a fresh output");
assert.equal(existsSync(output+"-reuse"),false);
for(const [kind,change] of Object.entries({future:{policy:{...policy,grantNonce:sha(output+"future"),consumedMarkerPath:join(dirname(output),sha(output+"future")+".json"),issuedAt:new Date(Date.now()+10000).toISOString()}},prompt:{prompt:"changed prompt"},runtime:{binding:{...binding,runtimeSha:sha("wrong runtime")}},hash:{policySha:sha("wrong policy")}})){
 const negative={...options,...change,output:output+"-"+kind};if(kind==="future")negative.policySha=sha(JSON.stringify(negative.policy));
 await assert.rejects(runReview(negative));assert.equal(requests,beforeReuse,"wrong issued-time/prompt/runtime/policy must refuse before forwarding");assert.equal(existsSync(negative.output),false);
}

assert.equal(observed.native.drained,true);assert.equal(observed.native.finished,true);assert.equal(observed.execution.relayClosed,true);
assert.equal(observed.callsComplete,successful||mode==="paid-rejected");assert.ok(requests>=1);assert.ok(requests<=1,"priorfailed physical must block every retry forward");
if(successful){assert.equal(observed.native.exitCode,0);assert.equal(observed.native.failure,null);assert.equal(observed.native.stdoutComplete,true);assert.equal(observed.budget[0]!.status,"complete");assert.equal(observed.budget[0]!.rawUsage!.output_tokens,23);
 if(mode==="paid"){assert.equal(observed.native.overage,"active");assert.ok(observed.native.rates.some((r:any)=>r.rate_limit_info.status==="rejected"&&r.rate_limit_info.overageStatus==="allowed"&&r.rate_limit_info.isUsingOverage===true));}}
else{assert.ok(observed.native.failure||observed.execution.runnerFailure);if(mode!=="paid-rejected")assert.equal(observed.callsComplete,false);assert.ok(observed.budget[0]!.status!=="reserved"||observed.native.failure);}
assert.equal(validateReviewEvidence({freezeSha:binding.freezeSha,promptSha:binding.promptSha,runtime,binding,paidPolicySha:sha(JSON.stringify(policy))},observed.evidence),false,"offline/scripted APPROVED never gets semantic admission");
const result={passed:true,mode,actualCli:observed.native.init?.claude_code_version??null,model:"claude-sonnet-5-5",runtime,requests,externalRequests:0,policySha:sha(JSON.stringify(policy)),nativeExit:observed.native.exitCode,nativeSignal:observed.native.signalCode,nativeDrained:observed.native.drained,overage:observed.native.overage,callsComplete:observed.callsComplete,budget:observed.budget,semanticApproval:false,invoiceUsd:null};
writeFileSync(join(output,"control.json"),JSON.stringify(result,null,2),{mode:0o600});console.log(JSON.stringify(result));
