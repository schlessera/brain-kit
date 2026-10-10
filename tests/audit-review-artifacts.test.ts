import { beforeAll,afterAll,test,expect } from "bun:test";
import { mkdtempSync,readFileSync,writeFileSync,cpSync,rmSync,mkdirSync,lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveEvidenceBundle,validateReviewEvidence,validateFormatControl } from "../scripts/evals/audit-capabilities/review-evidence";
import { rateAdmission,paidReservation,validPaidPolicy,claimPaidGrant,validGrantEvidence,type RootPaidPolicy } from "../scripts/evals/audit-capabilities/review-policy";
import { createReviewAdmission } from "../scripts/evals/audit-capabilities/review-native";
import { startRelay } from "../scripts/evals/audit-capabilities/review-relay";
import { runtimeFreeze,sha } from "../scripts/evals/audit-capabilities/freeze";
import { DETECTION_DAY } from "../scripts/evals/audit-capabilities/benchmark";
// The synthetic relay controls pin only the admission guard's local clock; the frozen live day is what they are about.
const onDetectionDay=()=>new Date(DETECTION_DAY+"T12:00:00.000Z");
const temp=mkdtempSync(join(tmpdir(),"1295-raw-controls-"));let reference:any,expected:any,errorDirectory:string,paidDirectory:string;
// A failed launch names the rejected guard: the collector's native/relay refusals lead, then the stdout/stderr tails
// (the full stdout receipt is long enough for the matcher to truncate its middle away).
function refusals(stdout:string){try{const r=JSON.parse(stdout.trim().split("\n").at(-1)!);return {nativeFailure:r.native?.failure??null,callFailures:(r.calls??[]).map((c:any)=>c.failure).filter(Boolean)};}catch{return null;}}
async function launch(out:string,mode:string){const child=Bun.spawn(["python3","scripts/evals/audit-capabilities/review-offline-launch.py","--bun",process.execPath,"--output",out,"--mode",mode],{cwd:process.cwd(),env:{PATH:process.env.PATH!,HOME:temp},stdout:"pipe",stderr:"pipe"});
 const [exit,stdout,stderr]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
 expect({mode,exit,refusals:exit===0?null:refusals(stdout),stdoutTail:stdout.slice(-2000),stderrTail:stderr.slice(-2000)}).toMatchObject({mode,exit:0});return join(out,"artifacts");}
beforeAll(async()=>{
 const dir=await launch(join(temp,"actual-native"),"normal"),execution=JSON.parse(readFileSync(join(dir,"execution.json"),"utf8"));
 expected={freezeSha:execution.freezeSha,promptSha:execution.promptSha,runtime:execution.runtime};reference=saveEvidenceBundle(dir);
 errorDirectory=await launch(join(temp,"actual-native-error"),"native-error");
 paidDirectory=await launch(join(temp,"actual-native-paid"),"paid-extra");
},30000);
afterAll(()=>rmSync(temp,{recursive:true,force:true}));
function formatControl(){const dir=mkdtempSync(join(temp,"format-"));cpSync(reference.directory,dir,{recursive:true});
 const exec=JSON.parse(readFileSync(join(dir,"execution.json"),"utf8"));exec.kind="subscription-native-direct";exec.transport="global-fetch";
 writeFileSync(join(dir,"execution.json"),JSON.stringify(exec));return saveEvidenceBundle(dir);}
function edit(ref:any,file:string,mutate:(v:any)=>any){const value=JSON.parse(readFileSync(join(ref.directory,file),"utf8"));writeFileSync(join(ref.directory,file),JSON.stringify(mutate(value)));return saveEvidenceBundle(ref.directory);}
test("actual pinned offline native APPROVED retains stdin stdout stderr physical bytes and remains inadmissible",()=>{
 const n=JSON.parse(readFileSync(join(reference.directory,"native.json"),"utf8"));
 expect(n.exitCode).toBe(0);expect(n.drained).toBe(true);expect(n.stdoutComplete).toBe(true);expect(n.stderrDrained).toBe(true);
 expect(n.result.result).toContain("APPROVED");expect(n.result.result).toContain("π");
 expect(readFileSync(join(reference.directory,"native.json.stdin.jsonl")).length).toBeGreaterThan(0);
 expect(readFileSync(join(reference.directory,"native.json.stdout.jsonl")).length).toBeGreaterThan(0);
 //293 legitimately emits no stderr on a successful turn; nonempty real native-error receipt proves the tee separately.
 expect(readFileSync(join(errorDirectory,"native.json.stderr.bin")).length).toBeGreaterThan(0);
 const calls=JSON.parse(readFileSync(join(reference.directory,"physical.json"),"utf8"));expect(calls.filter((c:any)=>c.forwarded)).toHaveLength(1);
 const c=calls.find((c:any)=>c.forwarded);expect(c.responseEof).toBe(true);expect(c.responseClosed).toBe(true);expect(c.actualInvoiceUsd).toBeNull();
 expect(sha(Buffer.from(c.rawResponseBase64,"base64"))).toBe(c.rawResponseSha);expect(validateReviewEvidence(expected,reference)).toBe(false);
});
test("raw format control independently reparses collected frames without claiming artifact-owner authenticity",()=>{
 expect(validateFormatControl(expected,formatControl())).toBe(true);
});
const invalidPhysical:Record<string,(c:any)=>void>={
 "physical missing usage":(c:any)=>{delete c.usage.output_tokens;},"wrong requested model":(c:any)=>c.requestedModel="claude-sonnet-5",
 "wrong served model":(c:any)=>c.servedModel="claude-sonnet-5","wrong physical auth":(c:any)=>c.authRoute="refused-auth",
 "partial physical EOF":(c:any)=>c.responseEof=false,"cancelled physical":(c:any)=>c.responseCancelled=true,
 "non2xx physical":(c:any)=>c.status=503,"extra auxiliary":(c:any)=>c.servedModel="claude-haiku-4-5",
 "contradictory usage":(c:any)=>c.usage.output_tokens=999,
};
for(const [name,change] of Object.entries(invalidPhysical))test(`${name} refuses hash-rebound raw bundle`,()=>{
 const ref=edit(formatControl(),"physical.json",(calls:any[])=>{change(calls.find(c=>c.forwarded));return calls;});expect(validateFormatControl(expected,ref)).toBe(false);
});
test("changed literal raw stdout fails original hash and contradicting reparsed result even after rebinding",()=>{
 let ref=formatControl();const p=join(ref.directory,"native.json.stdout.jsonl");writeFileSync(p,readFileSync(p,"utf8").replaceAll("APPROVED","NOT_APPROVED"));
 expect(validateFormatControl(expected,ref)).toBe(false);ref=saveEvidenceBundle(ref.directory);expect(validateFormatControl(expected,ref)).toBe(false);
});
test("wrong prompt runtime and unavailable raw files cannot become approval",()=>{
 const ref=formatControl();expect(validateFormatControl({...expected,promptSha:sha("wrong")},ref)).toBe(false);
 expect(validateFormatControl({...expected,runtime:{...expected.runtime,sdk:"0.3.999"}},ref)).toBe(false);
 rmSync(join(ref.directory,"native.json.stderr.bin"));expect(validateFormatControl(expected,ref)).toBe(false);
});
test("raw active overage and rejected events refuse without exact root policy",()=>{
 const ref=formatControl();const p=join(ref.directory,"native.json.stdout.jsonl");const frames=readFileSync(p,"utf8").split("\n").filter(Boolean).map(s=>JSON.parse(s));
 for(const f of frames)if(f.type==="rate_limit_event")f.rate_limit_info.isUsingOverage=true;
 writeFileSync(p,frames.map(f=>JSON.stringify(f)).join("\n")+"\n");const n=JSON.parse(readFileSync(join(ref.directory,"native.json"),"utf8"));n.rates=frames.filter(f=>f.type==="rate_limit_event");writeFileSync(join(ref.directory,"native.json"),JSON.stringify(n));
 expect(validateReviewEvidence(expected,saveEvidenceBundle(ref.directory))).toBe(false);
});
let grantSequence=0;
function policy():RootPaidPolicy{const grantNonce=sha("synthetic-grant-"+ ++grantSequence),parent=join(temp,"grants");mkdirSync(parent,{recursive:true,mode:0o700});return {version:1,grantNonce,consumedMarkerPath:join(parent,grantNonce+".json"),issue:841,authorizationUrl:"https://github.com/schlessera/brain-kit/issues/838#issuecomment-6065882737",allowOverage:true,basis:"actual additional billed charges",perIssueCapUsd:15,aggregateCapUsd:150,remainingUpperUsd:15,issuedAt:new Date(Date.now()-60000).toISOString(),expiresAt:new Date(Date.now()+60000).toISOString(),freezeSha:expected.freezeSha,detectedSha:sha("detected"),protocolSha:sha("protocol"),runtimeSha:sha(JSON.stringify(expected.runtime)),promptSha:expected.promptSha,proofSha:sha("proof"),canonicalModel:"claude-sonnet-5-5",maxPhysicalRequests:24,contextWindowTokens:1000000,maxInputTokens:1000000,maxInputBytes:2_000_000,maxOutputTokens:128000,inputUsdPerMillionUpper:8,outputUsdPerMillionUpper:20,invoiceUsd:null};}
test("explicit root paid policy permits observed active overage and refuses unknown/rejected rate or wrong proof",()=>{
 const p=policy();expect(validPaidPolicy(p,{...expected,proofSha:p.proofSha})).toBe(true);
 expect(validPaidPolicy(p,{...expected,proofSha:sha("other proof")})).toBe(false);
 expect(rateAdmission([{rate_limit_info:{status:"rejected",overageStatus:"allowed",isUsingOverage:true}}],p)).toBe(true);
 expect(rateAdmission([{rate_limit_info:{status:"rejected",overageStatus:"rejected",isUsingOverage:true}}],p)).toBe(false);expect(rateAdmission([],p)).toBe(false);
});
test("paid reservation precedes forwarding, debits complete physical usage and unknown keeps reservation",()=>{
 const p=policy(),b=paidReservation(p),request={model:"claude-sonnet-5-5",max_tokens:128000};b.beforeForward(request,2_000_000);
 expect(b.snapshot().reservedUpperUsd).toBe(10.56);expect(()=>b.beforeForward(request,10)).toThrow("single inflight");
 b.afterPhysical({outcome:"completed",usage:{input_tokens:10,output_tokens:20,cache_read_input_tokens:30,cache_creation_input_tokens:40}});
 expect(b.snapshot().knownUsageDebitUpperUsd).toBe(.00104);b.beforeForward(request,100);b.afterPhysical({outcome:"missing_usage",usage:null});
 expect(b.snapshot().reservedUpperUsd).toBeGreaterThan(0);expect(()=>b.beforeForward(request,10)).toThrow("previous receipt");
 for(const modified of [{speed:"fast"},{service_tier:"priority"},{inference_geo:"unknown"},{inference_geo:"not_available"}])expect(()=>paidReservation(p).beforeForward({...request,...modified},100)).toThrow("modifier");
});
test("short wire cannot bypass full-context paid reservation before forwarding",()=>{
 const p=policy(),request={model:"claude-sonnet-5-5",max_tokens:128000,messages:[{role:"user",content:"Review Odysseus's fictional raft note."}]},bytes=Buffer.byteLength(JSON.stringify(request));
 expect(bytes).toBeLessThan(1000);expect(request.messages[0]!.content.length).toBeGreaterThan(0);
 const small=paidReservation({...p,remainingUpperUsd:3});let forwarded=0;
 expect(()=>{small.beforeForward(request,bytes);forwarded++;}).toThrow("reservation exhausted");expect(forwarded).toBe(0);
 const admitted=paidReservation(p);admitted.beforeForward(request,bytes);expect(admitted.snapshot().reservedUpperUsd).toBe(10.56);
 admitted.afterPhysical({outcome:"completed",usage:{input_tokens:2000,output_tokens:1,cache_read_input_tokens:3000,cache_creation_input_tokens:4000}});
 expect(admitted.snapshot().unknown).toBe(false);expect(admitted.snapshot().reservedUpperUsd).toBe(0);expect(admitted.snapshot().knownUsageDebitUpperUsd).toBe(.07202);expect(admitted.snapshot().invoiceUsd).toBeNull();
});

test("literal stderr mutation fails the bound member hash without changing any semantic fields",()=>{const ref=formatControl();const p=join(ref.directory,"native.json.stderr.bin");writeFileSync(p,Buffer.concat([readFileSync(p),Buffer.from("literal byte tampering")]));expect(validateFormatControl(expected,ref)).toBe(false);});

test("expired policy replay checks recorded admission timestamp and every exact binding",()=>{
 const p=policy(),expired={...p,expiresAt:new Date(Date.now()-20000).toISOString()},at=new Date(Date.now()-30000).toISOString();
 expect(validPaidPolicy(expired)).toBe(false);expect(validPaidPolicy(expired,{...expected,proofSha:p.proofSha,detectedSha:p.detectedSha,protocolSha:p.protocolSha,dispatchedAt:at})).toBe(true);
 for(const field of ["proofSha","detectedSha","protocolSha"] as const)expect(validPaidPolicy(p,{...expected,[field]:sha("mismatch")})).toBe(false);
});
test("over-bound physical counters retain paid reservation and stop further forwarding",()=>{
 for(const usage of [{input_tokens:1_000_001,output_tokens:1,cache_read_input_tokens:0,cache_creation_input_tokens:0},{input_tokens:1,output_tokens:11,cache_read_input_tokens:0,cache_creation_input_tokens:0}]){
  const b=paidReservation(policy());b.beforeForward({model:"claude-sonnet-5-5",max_tokens:10},100);const before=b.snapshot().reservedUpperUsd;
  b.afterPhysical({outcome:"completed",usage});expect(b.snapshot().reservedUpperUsd).toBe(before);expect(b.snapshot().unknown).toBe(true);expect(()=>b.beforeForward({model:"claude-sonnet-5-5",max_tokens:10},100)).toThrow("previous receipt");
 }
});

test("actual native stderr error before SDK throw retains literal bytes and true close",()=>{
 const n=JSON.parse(readFileSync(join(errorDirectory,"native.json"),"utf8"));expect(n.exitCode).not.toBe(0);expect(n.drained).toBe(true);
 expect(readFileSync(join(errorDirectory,"native.json.stderr.bin"),"utf8")).toContain("fixture-invalid-review-argument");
 expect(validateReviewEvidence(expected,saveEvidenceBundle(errorDirectory))).toBe(false);
});

test("actual relay refuses changed physical prompt tools effort and policy binding before forwarding",async()=>{
 const f=runtimeFreeze(),payload="Approved fictional review input",runtime={sdk:f.binaries.claude.sdkVersion,nativeSha:f.binaries.claude.sha256,nativeMode:f.binaries.claude.mode,bunSha:f.binaries.bun.sha256,bunVersion:Bun.version,bunMode:f.binaries.bun.mode};
 const p={...policy(),freezeSha:f.freezeSha,runtimeSha:sha(JSON.stringify(runtime)),promptSha:sha(payload),protocolSha:sha(JSON.stringify(f.protocol))};
 const input={frozen:f,payload,proofSha:p.proofSha,detectedSha:p.detectedSha,policy:p,now:onDetectionDay};
 for(const change of [{messages:[{role:"user",content:"altered prompt"}]},{messages:[{role:"user",content:payload},{role:"user",content:"Unapproved Odysseus instruction"}]},{messages:[{role:"user",content:[{type:"text",text:payload},{type:"text",text:"Unapproved instruction"}]}]},{messages:[{role:"user",content:[{type:"text",text:payload},{type:"image",source:{type:"base64",media_type:"image/png",data:"AA=="}}]}]},{tools:[{name:"Write"}]},{tools:{name:"Write"}},{output_config:{effort:"high"}}]){
  let forwarded=0;const guard=createReviewAdmission(input),relay=startRelay({oauthToken:"offline-auth",beforeForward:guard.beforeForward,save:()=>{},fetch:async()=>{forwarded++;throw Error("unexpected forwarded request");}});
  try{const response=await fetch(relay.url+"/v1/messages",{method:"POST",headers:{authorization:"Bearer offline-auth"},body:JSON.stringify({model:"claude-sonnet-5-5",max_tokens:1000,messages:[{role:"user",content:payload}],tools:[],output_config:{effort:"low"},...change})});
   expect(forwarded).toBe(0);expect(response.status).toBe(403);expect(relay.calls.at(-1)?.forwarded).toBe(false);
  }finally{await relay.stop();}
 }
 for(const field of ["proofSha","detectedSha","protocolSha","promptSha","freezeSha","runtimeSha"] as const){
  let forwarded=0;const guard=createReviewAdmission({...input,policy:{...p,[field]:sha("wrong")}}),relay=startRelay({oauthToken:"offline-auth",beforeForward:guard.beforeForward,save:()=>{},fetch:async()=>{forwarded++;throw Error("unexpected");}});
  try{const r=await fetch(relay.url+"/v1/messages",{method:"POST",headers:{authorization:"Bearer offline-auth"},body:JSON.stringify({model:"claude-sonnet-5-5",max_tokens:1000,messages:[{role:"user",content:payload}],tools:[],output_config:{effort:"low"}})});expect(forwarded).toBe(0);expect(r.status).toBe(403);}finally{await relay.stop();}
 }
 for(const invalid of [{...p,issuedAt:new Date(Date.now()+60000).toISOString()},{...p,expiresAt:p.issuedAt}]){
  let forwarded=0;const guard=createReviewAdmission({...input,policy:invalid}),relay=startRelay({oauthToken:"offline-auth",beforeForward:guard.beforeForward,save:()=>{},fetch:async()=>{forwarded++;throw Error("unexpected");}});
  try{await fetch(relay.url+"/v1/messages",{method:"POST",headers:{authorization:"Bearer offline-auth"},body:JSON.stringify({model:"claude-sonnet-5-5",max_tokens:1000,messages:[{role:"user",content:payload}],tools:[],output_config:{effort:"low"}})});expect(forwarded).toBe(0);}finally{await relay.stop();}
 }
 const path="docs/audit-capability-investigation.md",original=readFileSync(path);let forwarded=0;
 const guard=createReviewAdmission(input),relay=startRelay({oauthToken:"offline-auth",beforeForward:guard.beforeForward,save:()=>{},fetch:async()=>{forwarded++;throw Error("unexpected");}});
 try{writeFileSync(path,Buffer.concat([original,Buffer.from("\nOdysseus controlled source mutation\n")]));
  const r=await fetch(relay.url+"/v1/messages",{method:"POST",headers:{authorization:"Bearer offline-auth"},body:JSON.stringify({model:"claude-sonnet-5-5",max_tokens:1000,messages:[{role:"user",content:payload}],tools:[],output_config:{effort:"low"}})});expect(forwarded).toBe(0);expect(r.status).toBe(403);
 }finally{writeFileSync(path,original);await relay.stop();}
});

test("actual relay atomically consumes grant and refuses reuse from another output scope",async()=>{
 const f=runtimeFreeze(),payload="Odysseus single-use grant",runtime={sdk:f.binaries.claude.sdkVersion,nativeSha:f.binaries.claude.sha256,nativeMode:f.binaries.claude.mode,bunSha:f.binaries.bun.sha256,bunVersion:Bun.version,bunMode:f.binaries.bun.mode};
 const p={...policy(),freezeSha:f.freezeSha,runtimeSha:sha(JSON.stringify(runtime)),promptSha:sha(payload),protocolSha:sha(JSON.stringify(f.protocol))};
 const input={frozen:f,payload,proofSha:p.proofSha,detectedSha:p.detectedSha,policy:p,now:onDetectionDay};let forwarded=0;
 for(let scope=0;scope<2;scope++){
 const guard=createReviewAdmission(input),relay=startRelay({oauthToken:"offline-auth",beforeForward:guard.beforeForward,save:()=>{},fetch:async()=>{forwarded++;throw Error("controlled failure after admission");}});
 try{await fetch(relay.url+"/v1/messages",{method:"POST",headers:{authorization:"Bearer offline-auth"},body:JSON.stringify({model:"claude-sonnet-5-5",max_tokens:1000,messages:[{role:"user",content:payload}],tools:[],output_config:{effort:"low"}})});expect(forwarded).toBe(1);expect(lstatSync(p.consumedMarkerPath).mode&0o777).toBe(0o600);}finally{await relay.stop();}
 }
 expect(()=>claimPaidGrant(p)).toThrow();
 const literal=readFileSync(p.consumedMarkerPath),claim=JSON.parse(literal.toString()),started=new Date(Date.parse(claim.claimedAtUtc)-1).toISOString(),dispatch=new Date(Date.parse(claim.claimedAtUtc)+1).toISOString();
 expect(validGrantEvidence(p,literal,sha(literal),started,dispatch)).toBe(true);
 writeFileSync(p.consumedMarkerPath,literal.toString().replace('"invoiceUsd": null','"invoiceUsd": 0'));
 expect(validGrantEvidence(p,literal,sha(literal),started,dispatch)).toBe(false);
});

test("actual paid native format replay binds literal consumed grant and refuses copied-marker tampering",()=>{
 const dir=mkdtempSync(join(temp,"paid-format-"));cpSync(paidDirectory,dir,{recursive:true});
 const execution=JSON.parse(readFileSync(join(dir,"execution.json"),"utf8")),p=JSON.parse(readFileSync(join(dir,"offline-synthetic-policy.json"),"utf8"));
 const expectedPaid={freezeSha:execution.freezeSha,promptSha:execution.promptSha,runtime:execution.runtime,proofSha:p.proofSha,detectedSha:p.detectedSha,protocolSha:p.protocolSha,paidPolicy:p};
 expect(validateReviewEvidence(expectedPaid,saveEvidenceBundle(dir))).toBe(false);
 execution.kind="subscription-native-direct";execution.transport="global-fetch";writeFileSync(join(dir,"execution.json"),JSON.stringify(execution));
 expect(validateFormatControl(expectedPaid,saveEvidenceBundle(dir))).toBe(true);
 const path=join(dir,"grant.json");writeFileSync(path,readFileSync(path,"utf8").replace('"invoiceUsd": null','"invoiceUsd": 0'));
 expect(validateFormatControl(expectedPaid,saveEvidenceBundle(dir))).toBe(false);
});

test("verified Standard auto-tier and US-only upper bounds retain complete usage",()=>{
 const b=paidReservation(policy());b.beforeForward({model:"claude-sonnet-5-5",max_tokens:100,service_tier:"auto",inference_geo:"us"},1000);
 b.afterPhysical({outcome:"completed",usage:{input_tokens:10,output_tokens:8,cache_read_input_tokens:0,cache_creation_input_tokens:0,service_tier:"standard",inference_geo:"us"}});
 expect(b.snapshot().unknown).toBe(false);expect(b.snapshot().reservedUpperUsd).toBe(0);expect(b.snapshot().knownUsageDebitUpperUsd).toBe(.00024);
 for(const modifier of [{service_tier:"priority"},{inference_geo:"unknown"}]){const c=paidReservation(policy());c.beforeForward({model:"claude-sonnet-5-5",max_tokens:100},1000);c.afterPhysical({outcome:"completed",usage:{input_tokens:10,output_tokens:8,cache_read_input_tokens:0,cache_creation_input_tokens:0,...modifier}});expect(c.snapshot().unknown).toBe(true);expect(c.snapshot().reservedUpperUsd).toBeGreaterThan(0);}
});

test("actual native unavailable response geography retains raw sentinel under conservative covered upper",()=>{
 const b=paidReservation(policy());b.beforeForward({model:"claude-sonnet-5-5",max_tokens:100},1000);
 b.afterPhysical({outcome:"completed",usage:{input_tokens:10,output_tokens:8,cache_read_input_tokens:0,cache_creation_input_tokens:0,service_tier:"standard",inference_geo:"not_available"}});
 expect(b.snapshot().unknown).toBe(false);expect(b.snapshot().knownUsageDebitUpperUsd).toBe(.00024);expect(b.snapshot().reservedUpperUsd).toBe(0);
});

test("independent raw replay refuses an extra prompt while retaining exact approved text",()=>{
 const ref=formatControl();const path=join(ref.directory,"physical.json"),calls=JSON.parse(readFileSync(path,"utf8")),call=calls.find((c:any)=>c.forwarded),body=JSON.parse(Buffer.from(call.rawRequestBase64,"base64").toString("utf8"));
 body.messages.push({role:"user",content:"Unapproved Odysseus instruction"});const raw=Buffer.from(JSON.stringify(body));call.rawRequestBase64=raw.toString("base64");call.requestSha=sha(raw);call.stateBytes=raw.length;writeFileSync(path,JSON.stringify(calls));
 expect(validateFormatControl(expected,saveEvidenceBundle(ref.directory))).toBe(false);
});
