/** Protected networkless native control. Ephemeral policy is never a live root admission. */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sourceBinding, sha } from "./admission";
import { AUTHORIZATION_URL, type PaidPolicy } from "./paid-policy";
import { installBrainSurface } from "./brain-fixture";
import { fixtures, prepare } from "./pipeline";
import { native } from "./live";
import { inspectReviewEvidence, validateReviewEvidence } from "./review-evidence";
const MODEL = "claude-sonnet-5-5";
async function main() {
  const out=process.argv[2], mode=process.argv[3] ?? "paid-allowed";
  if (!out || process.env.BRAIN_SMART_OFFLINE !== "1" || !["paid-allowed","paid-rejected","paid-current"].includes(mode) || readFileSync("/proc/net/route","utf8").trim().split("\n").slice(1).some(row=>row.trim().split(/\s+/)[0]!=="lo")) throw Error("Protected offline control only");
  mkdirSync(out,{mode:0o700});
  const f=fixtures.find(f=>f.id===(mode==="paid-current"?"t-module":"t-none"))!;
  const prompt=mode==="paid-current"?`/add ${f.content}`:"Independently inspect this fictional Odysseus control and return APPROVED. This is scripted transport evidence, never semantic approval.";
  const proofSha=sha("offline-only scripted transport control; never live authorization"), exact=sourceBinding(sha(prompt),proofSha);
  const grantNonce=sha(`${out}:offline-only grant`),grantParent=join(out,".offline-grants");mkdirSync(grantParent,{mode:0o700});
  const policy:PaidPolicy={...exact.binding,purpose:mode==="paid-current"?"current":"review",grantNonce,consumedMarkerPath:join(grantParent,`${grantNonce}.json`),version:1,issue:839,authorizationUrl:AUTHORIZATION_URL,allowOverage:true,basis:"actual additional billed charges",perIssueCapUsd:15,aggregateCapUsd:150,remainingUpperUsd:15,issuedAt:new Date(Date.now()-1000).toISOString(),expiresAt:new Date(Date.now()+60000).toISOString(),canonicalModel:MODEL,maxPhysicalRequests:24,maxInputBytes:3000000,maxInputTokens:1000000,contextWindowTokens:1000000,maxOutputTokens:128000,inputUsdPerMillionUpper:8,outputUsdPerMillionUpper:20,invoiceUsd:null};
  const p=await prepare(f); let dispatched=0, failed:string|null=null;
  try {
    installBrainSurface(p.root,new URL("../../../",import.meta.url).pathname);
    const result=await native(f,p.root,out,mode==="paid-current"?"current":"review","sk-ant-oat01-offline-fixture-not-a-credential",undefined,mode==="paid-current"?undefined:prompt,proofSha,undefined,{offline:true,policy,async fetch(_url,init){
      dispatched++; const body=JSON.parse(new TextDecoder().decode(init.body as Uint8Array));
      if(body.model!==MODEL || (mode!=="paid-current" && (body.tools?.length || body.output_config?.effort!=="low")))throw Error("Actual native readonly request differs");
      const tool=mode==="paid-current" && !body.messages.some((m:any)=>m.role==="assistant"&&Array.isArray(m.content)&&m.content.some((b:any)=>b.type==="tool_use"));
      const command=`brain add ${JSON.stringify(f.content)} --type study`;
      const usage={input_tokens:10,output_tokens:0,cache_read_input_tokens:0,cache_creation_input_tokens:0,service_tier:"standard",inference_geo:"not_available"};
      const events=[{type:"message_start",message:{id:"offline_message",type:"message",role:"assistant",model:MODEL,content:[],stop_reason:null,usage}},
        {type:"content_block_start",index:0,content_block:tool?{type:"tool_use",id:"offline_tool",name:"Bash",input:{}}:{type:"text",text:""}},
        {type:"content_block_delta",index:0,delta:tool?{type:"input_json_delta",partial_json:JSON.stringify({command})}:{type:"text_delta",text:"APPROVED"}},
        {type:"content_block_stop",index:0},{type:"message_delta",delta:{stop_reason:tool?"tool_use":"end_turn",stop_sequence:null},usage:{output_tokens:7}},{type:"message_stop"}];
      return new Response(events.map(e=>`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""),{headers:{"content-type":"text/event-stream","anthropic-ratelimit-unified-status":"rejected","anthropic-ratelimit-unified-overage-status":mode!=="paid-rejected"?"allowed":"rejected","anthropic-ratelimit-unified-overage-in-use":mode!=="paid-rejected"?"true":"false"}});
    }});
    if(mode==="paid-current"){
      const paths=[...new Bun.Glob("studies/*.md").scanSync({cwd:p.root})];
      if(paths.length!==1 || !readFileSync(join(p.root,paths[0]!),"utf8").includes(f.content) || dispatched!==2 || !result.receipt.drained || result.receipt.init.permissionMode!=="default" || result.calls.some(c=>c.outcome!=="completed" || c.observedAdditionalBilledUsd!==null))throw Error("Actual core current/tool/physical/default control differs");
      writeFileSync(join(out,"current-effect.md"),readFileSync(join(p.root,paths[0]!),"utf8"),{mode:0o600});
      const report={passed:true,mode,actualCli:result.receipt.init.claude_code_version,permissionMode:result.receipt.init.permissionMode,model:result.receipt.init.model,physicalRequests:dispatched,actualToolWrite:true,drained:true,semanticAdmission:false,invoiceUsd:null,evidence:result.evidence,expected:result.expected,externalRequests:0};writeFileSync(join(out,"control.json"),JSON.stringify(report,null,2),{mode:0o600});console.log(JSON.stringify(report));return;
    }
    let replayRefused=false;
    try{await native(f,p.root,out,"review-replay","sk-ant-oat01-offline-fixture-not-a-credential",undefined,prompt,proofSha,undefined,{offline:true,policy,async fetch(){dispatched++;throw Error("Replayed grant reached physical dispatch");}});}catch(error){replayRefused=String(error).includes("EEXIST");}
    if(!replayRefused || dispatched!==1)throw Error("Single-use grant replay was not refused before prompt/physical dispatch");
    const inspected=inspectReviewEvidence(result.expected,result.evidence);
    if(mode!=="paid-allowed" || !inspected.complete || inspected.semanticEligible || validateReviewEvidence(result.expected,result.evidence) || result.receipt.additionalBilledUsd!==null || !result.receipt.rates.some((r:any)=>r.rate_limit_info.status==="rejected"&&r.rate_limit_info.overageStatus==="allowed"&&r.rate_limit_info.isUsingOverage===true))throw Error("Actual paid-allowed/raw/fake-admission control differs");
    const report={passed:true,mode,actualCli:result.receipt.init.claude_code_version,model:result.receipt.init.model,physicalRequests:dispatched,drained:result.receipt.drained,rawComplete:inspected.complete,replayRefusedBeforePrompt:true,semanticAdmission:false,invoiceUsd:null,evidence:result.evidence,expected:result.expected,externalRequests:0};
    writeFileSync(join(out,"control.json"),JSON.stringify(report,null,2),{mode:0o600});console.log(JSON.stringify(report));
  }catch(error){failed=String(error);if(mode!=="paid-rejected")throw error;
    const receipt=JSON.parse(readFileSync(join(out,"review-native.json"),"utf8"));
    if(!receipt.failure?.includes("Rate/paid-policy refusal") || !receipt.drained || receipt.additionalBilledUsd!==null || !receipt.rates.some((r:any)=>r.rate_limit_info.overageStatus==="rejected"))throw Error("Actual genuinely rejected native did not fail/close for intended reason");
    const report={passed:true,mode,physicalRequests:dispatched,drained:receipt.drained,nativeFailure:receipt.failure,failure:failed,semanticAdmission:false,invoiceUsd:null,externalRequests:0};writeFileSync(join(out,"control.json"),JSON.stringify(report,null,2),{mode:0o600});console.log(JSON.stringify(report));
  }finally{p.close();}
}
if(import.meta.main)await main();
