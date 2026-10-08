/** Explicitly offline native SDK283 probe; synthetic APPROVED is never semantic evidence. */
import { collectReviewArtifacts } from "./review-native";
import { runtimeFreeze,sha } from "./freeze";
import { validateReviewEvidence } from "./review-evidence";
import { mkdirSync,writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { RootPaidPolicy } from "./review-policy";
import { MODEL } from "./protocol";
const [directory,mode="normal"]=process.argv.slice(2);
if(process.env.BRAIN_AUDIT_REVIEW_OFFLINE!=="1"||!directory)throw Error("Require isolated offline launcher");
const text="APPROVED Odysseus π offline format control";
let attempt=0;
const frozen=runtimeFreeze();
const payload="Review fictional Odysseus fixture controls; no tools. π";
const runtime={sdk:frozen.binaries.claude.sdkVersion,nativeSha:frozen.binaries.claude.sha256,nativeMode:frozen.binaries.claude.mode,bunSha:frozen.binaries.bun.sha256,bunVersion:Bun.version,bunMode:frozen.binaries.bun.mode};
const grantNonce=sha("offline-grant"),markerParent=dirname(directory)+"/grants";mkdirSync(markerParent,{recursive:true,mode:0o700});
const paidPolicy:RootPaidPolicy|undefined=mode==="paid-extra"?{version:1,issue:841,grantNonce,consumedMarkerPath:markerParent+"/"+grantNonce+".json",authorizationUrl:"https://github.com/schlessera/brain-kit/issues/838#issuecomment-6065882737",allowOverage:true,basis:"actual additional billed charges",perIssueCapUsd:15,aggregateCapUsd:150,remainingUpperUsd:15,issuedAt:new Date(Date.now()-1000).toISOString(),expiresAt:new Date(Date.now()+60000).toISOString(),freezeSha:frozen.freezeSha,detectedSha:sha("offline-detected"),protocolSha:sha(JSON.stringify(frozen.protocol)),runtimeSha:sha(JSON.stringify(runtime)),promptSha:sha(payload),proofSha:sha("offline-proof"),canonicalModel:MODEL,maxPhysicalRequests:24,contextWindowTokens:1000000,maxInputTokens:1000000,maxInputBytes:1000000,maxOutputTokens:128000,inputUsdPerMillionUpper:8,outputUsdPerMillionUpper:20,invoiceUsd:null}:undefined;
const result=await collectReviewArtifacts({directory,payload,frozen,paidPolicy,proofSha:paidPolicy?.proofSha,detectedSha:paidPolicy?.detectedSha,token:"sk-ant-oat01-offline-fixture-only",
 kind:"offline-native-scripted",offlineInvalidArgument:mode==="native-error",deadlineMs:mode==="partial"?1500:20_000,fetch:(async(_url:any,init:any)=>{
 attempt++;const request=JSON.parse(typeof init.body==="string"?init.body:Buffer.from(init.body as Uint8Array).toString("utf8"));if(request.model!==MODEL)throw Error("Wrong requested model");
 const u:any={input_tokens:10,output_tokens:0,cache_read_input_tokens:0,cache_creation_input_tokens:0,service_tier:"standard",inference_geo:"not_available"};if(mode==="missing-usage")delete u.input_tokens;
 const frames=[{type:"message_start",message:{id:"msg_offline"+attempt,type:"message",role:"assistant",model:mode==="wrong-model"?"claude-sonnet-5":MODEL,content:[],stop_reason:null,usage:u}},
 {type:"content_block_start",index:0,content_block:{type:"text",text:""}},{type:"content_block_delta",index:0,delta:{type:"text_delta",text}},
 {type:"content_block_stop",index:0},{type:"message_delta",delta:{stop_reason:"end_turn",stop_sequence:null},usage:{output_tokens:8}},{type:"message_stop"}];
 const bytes=new TextEncoder().encode(frames.map(f=>`event: ${f.type}\ndata: ${JSON.stringify(f)}\n\n`).join(""));
 if(mode==="http-error")return new Response(new Uint8Array([0,255,128]),{status:503});
 const headers={"content-type":"text/event-stream","anthropic-ratelimit-unified-status":["extra-usage","paid-extra","rejected-overage"].includes(mode)?"rejected":"allowed","anthropic-ratelimit-unified-overage-status":["extra-usage","paid-extra"].includes(mode)?"allowed":mode==="rejected-overage"?"rejected":"disabled"};
 if(mode==="partial")return new Response(new ReadableStream({start(c){c.enqueue(bytes.slice(0,80));},cancel(){}}),{headers});
 return new Response(bytes,{headers});
 }) as typeof fetch});
if(paidPolicy)writeFileSync(directory+"/offline-synthetic-policy.json",JSON.stringify(paidPolicy),{mode:0o600});
const admitted=validateReviewEvidence({freezeSha:frozen.freezeSha,promptSha:result.execution.promptSha,runtime:result.execution.runtime},result.evidence);
if(admitted)throw Error("Offline scripted APPROVED became semantic approval");
console.log(JSON.stringify({mode,admitted,attempts:attempt,native:result.native,calls:result.calls,evidence:result.evidence}));
if(["normal","paid-extra"].includes(mode) && (!result.native.drained || result.native.exitCode!==0 || result.calls.filter(c=>c.forwarded).length!==1 || result.calls.filter(c=>c.forwarded)[0].outcome!=="completed"))process.exitCode=1;
