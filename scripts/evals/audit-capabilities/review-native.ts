/** Pinned SDK review transport. Literal artifacts are protected; offline controls cannot approve. */
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { Transform } from "node:stream";
import { captureReviewStdout, priceReview, reviewEnvironment, unrelatedProviderCredentials } from "../note-disposition/review";
import { CLEARED_API_CREDENTIALS, NEUTRALISED_SETTINGS, subscriptionVerdict, settingsRefusal,credentialFields } from "../../../packages/ui-backend-claude/src/subscription";
import { runtimeFreeze, assertNative, repo, sha } from "./freeze";
import { startRelay } from "./review-relay";
import { saveEvidenceBundle, type RuntimeIdentity } from "./review-evidence";
import { drainReviewChild } from "./review-drain";
import { DETECTION_DAY } from "./benchmark";
import { buildReviewPacket } from "./review-packets";
import { MODEL } from "./protocol";
import { rateAdmission, paidReservation, validPaidPolicy, claimPaidGrant, type RootPaidPolicy } from "./review-policy";
/** Used at the real query prompt boundary and by actual SDK handshake controls. */
export async function* protectedReviewPrompt(handle:Promise<any>,payload:string,receipt:any,save:()=>void,controller:AbortController,beforeRelease?:()=>void){
 const cli=await handle,init=await cli.initializationResult(),settings=await cli.getSettings();
 receipt.account=init.account;receipt.settings=settings;receipt.credentials=credentialFields(init.account);save();
 if(!subscriptionVerdict(init.account).ok || settingsRefusal(settings)){receipt.failure="Protected preprompt account/settings refusal";save();controller.abort();throw Error(receipt.failure);}
 beforeRelease?.();receipt.promptReleased=true;save();yield {type:"user" as const,parent_tool_use_id:null,message:{role:"user" as const,content:payload},session_id:""};
}
/** Same guard executes at entry, prompt release and the actual relay's before-forward boundary. */
export function createReviewAdmission(input:{frozen:ReturnType<typeof runtimeFreeze>;payload:string;proofSha:string;detectedSha:string;policy:RootPaidPolicy;onClaim?:(claim:{bytes:string;sha:string})=>void},budget=paidReservation(input.policy)) {
 const f=input.frozen,runtime={sdk:f.binaries.claude.sdkVersion,nativeSha:f.binaries.claude.sha256,nativeMode:f.binaries.claude.mode,bunSha:f.binaries.bun.sha256,bunVersion:f.binaries.bun.version,bunMode:f.binaries.bun.mode};
 let claim:ReturnType<typeof claimPaidGrant>|undefined;
 function consume(){assertBindings();if(!claim){claim=claimPaidGrant(input.policy);input.onClaim?.(claim);}return claim;}
 function assertBindings(){
  if(runtimeFreeze().freezeSha!==f.freezeSha)throw Error("Actual review runtime/source changed before dispatch");
  if(!validPaidPolicy(input.policy,{freezeSha:f.freezeSha,promptSha:sha(input.payload),runtime,proofSha:input.proofSha,detectedSha:input.detectedSha,protocolSha:sha(JSON.stringify(f.protocol))}))throw Error("Root policy bindings do not match actual collector inputs");
 }
 return {assertBindings,consume,beforeForward(request:Record<string,any>,bytes:number){assertBindings();
 const texts=(request.messages??[]).filter((m:any)=>m.role==="user").flatMap((m:any)=>typeof m.content==="string"?[m.content]:Array.isArray(m.content)?m.content.filter((b:any)=>b.type==="text").map((b:any)=>b.text):[]);
 if(request.messages?.filter((m:any)=>m.role==="user").length!==1 || texts.length!==1 || !texts.every((s:any)=>typeof s==="string"&&sha(s)===input.policy.promptSha) || request.messages.some((m:any)=>m.role==="user"&&Array.isArray(m.content)&&m.content.some((b:any)=>b.type!=="text")) || (request.tools!==undefined && (!Array.isArray(request.tools)||request.tools.length!==0)) || request.output_config?.effort!=="low")throw Error("Actual physical prompt/tools/effort differs from approved review");
 if(new Date().toISOString().slice(0,10)!==DETECTION_DAY)throw Error("Actual detection day changed");consume();budget.beforeForward(request,bytes);
 },snapshot:budget.snapshot,afterPhysical:budget.afterPhysical};
}
export async function collectReviewArtifacts(options: {directory:string;payload:string;frozen:ReturnType<typeof runtimeFreeze>;
 token:string;proofSha?:string;detectedSha?:string;proofRaw?:string;detectedRaw?:string;packetKey?:string;kind:"offline-native-scripted"|"subscription-native-direct";fetch:typeof fetch;paidPolicy?:RootPaidPolicy;deadlineMs?:number;offlineInvalidArgument?:boolean}) {
 const {directory,payload,frozen}=options;
 const actualSdk=frozen.binaries.claude.sdkVersion,actualCli=frozen.binaries.claude.cliVersion;
 const pair=(actualSdk==="0.3.283"&&actualCli==="2.1.283")||(options.kind==="offline-native-scripted"&&actualSdk==="0.3.293"&&actualCli==="2.1.293");
 if(Bun.version!=="1.4.2" || !pair)throw Error("Require explicit native283 live or283/293 offline pair and Bun142");
 if(options.kind==="subscription-native-direct" && options.offlineInvalidArgument)throw Error("Offline invalid-argument control is not a live option");
 if(options.kind==="subscription-native-direct" && options.fetch!==globalThis.fetch)throw Error("Injected transport cannot claim native provider provenance");
 if(options.kind==="subscription-native-direct" && !validPaidPolicy(options.paidPolicy))throw Error("Explicit root paid policy required; no implicit paid dispatch");
 mkdirSync(directory,{recursive:true,mode:0o700}); const home=join(directory,"home");mkdirSync(home,{mode:0o700});
 const runtime:RuntimeIdentity={sdk:actualSdk,nativeSha:frozen.binaries.claude.sha256,nativeMode:frozen.binaries.claude.mode,
 bunSha:frozen.binaries.bun.sha256,bunVersion:Bun.version,bunMode:frozen.binaries.bun.mode};
 const native:any={failure:null,inputFailure:null,stderrFailure:null,termination:null,result:null,init:null,account:null,settings:null,
 rates:[],promptReleased:false,finished:false,drained:false,stdoutComplete:false,stderrDrained:false,exitCode:null,signalCode:null,
 additionalBilledUsd:null,apiEquivalent:null,runtime};
 const nativePath=join(directory,"native.json");const save=()=>writeFileSync(nativePath,JSON.stringify(native,null,2),{mode:0o600});
 for(const suffix of ["stdin.jsonl","stdout.jsonl","stderr.bin"])writeFileSync(nativePath+"."+suffix,"",{mode:0o600}); save();
 writeFileSync(join(directory,"grant.json"),"null",{mode:0o600});
 let grantSha:string|null=null;
 const budget=paidReservation(options.paidPolicy);
 let admission:ReturnType<typeof createReviewAdmission>|undefined;
 if(options.paidPolicy){
  const proofSha=options.proofRaw?sha(options.proofRaw):options.proofSha,detectedSha=options.detectedRaw?sha(options.detectedRaw):options.detectedSha;
  if(!proofSha||!detectedSha)throw Error("Complete collector proof/detected input bindings required");
  if(options.kind==="subscription-native-direct"){
   if(!options.proofRaw||!options.detectedRaw||!options.packetKey)throw Error("Require literal proof/detected inputs and exact packet at collector");
   const rebuilt=buildReviewPacket(frozen,options.detectedRaw,options.proofRaw,options.packetKey);
   if(rebuilt.payload!==payload)throw Error("Collector prompt is not freshly rebuilt exact packet");
  }
  admission=createReviewAdmission({frozen,payload,proofSha,detectedSha,policy:options.paidPolicy,onClaim:claim=>{writeFileSync(join(directory,"grant.json"),claim.bytes,{mode:0o600});grantSha=claim.sha;}},budget);admission.assertBindings();
 }

 const relay=startRelay({oauthToken:options.token,fetch:options.fetch,save:c=>{writeFileSync(join(directory,"physical.json"),JSON.stringify(c,null,2),{mode:0o600});const last=c.at(-1);if(last?.finished && last.forwarded)budget.afterPhysical(last);if(last?.finished && !["completed","local-connectivity-control"].includes(last.outcome))controller.abort();},
 beforeForward:admission?.beforeForward});
 writeFileSync(join(directory,"physical.json"),"[]",{mode:0o600});
 const execution:any={kind:options.kind,transport:options.kind==="offline-native-scripted"?"injected-offline-fetch":"global-fetch",
 upstream:"https://api.anthropic.com/v1/messages",freezeSha:frozen.freezeSha,startedAtUtc:new Date().toISOString(),promptSha:sha(payload),proofSha:options.proofSha??null,readOnlyReview:true,runtime,
 relayClosed:false,runnerFailure:null,additionalBilledUsd:null,paidPolicySha:options.paidPolicy?sha(JSON.stringify(options.paidPolicy)):null};
 const saveExecution=()=>writeFileSync(join(directory,"execution.json"),JSON.stringify(execution,null,2),{mode:0o600});saveExecution();
 const controller=new AbortController();let q:any,child:ReturnType<typeof spawn>|undefined,close:Promise<void>|undefined,stdoutEnd:Promise<void>|undefined,stderrEnd:Promise<void>|undefined;
 let handleResolve!:(q:any)=>void;const handle=new Promise<any>(r=>handleResolve=r);
 const commands=new Map<string,string>();
 const observe=(line:string)=>{try{
  if(!line.trim())return;const f=JSON.parse(line);
  if(f.type==="control_response") {const subtype=commands.get(f.response?.request_id);
   if(subtype==="initialize")native.account=f.response?.response?.account;
   if(subtype==="get_settings")native.settings=f.response?.response;}
  if(f.type==="system"&&f.subtype==="init") {native.init=f;
   if(f.model!==MODEL || f.apiKeySource!=="none" || f.claude_code_version!==actualCli || f.tools?.length)throw Error("Native model/auth/runtime/tool mismatch");}
  if(f.type==="rate_limit_event"){native.rates.push(f);if(!rateAdmission(native.rates,options.paidPolicy,relay.calls.filter(c=>c.forwarded).at(-1)?.startedAtUtc))throw Error("Unapproved or unknown extra usage/rate refusal");}
  if(f.type==="result"){native.result=f;if(f.is_error)throw Error("Native error result");}
 }catch(e){native.failure=String(e);controller.abort();}save();};
 const prompt=()=>protectedReviewPrompt(handle,payload,native,save,controller,admission?.consume);
 const deadline=setTimeout(()=>{native.failure="Review deadline";controller.abort();save();},options.deadlineMs??180_000);
 try {
  const {query}=await import(Bun.resolveSync("@anthropic-ai/claude-agent-sdk",join(repo,"packages/ui-backend-claude/src")));
  q=query({prompt:prompt(),options:{cwd:home,settingSources:[],settings:{...NEUTRALISED_SETTINGS,autoMemoryEnabled:false},persistSession:false,
   env:{...reviewEnvironment({PATH:process.env.PATH},home,options.token),ANTHROPIC_BASE_URL:relay.url,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:"1",NO_PROXY:"127.0.0.1,localhost",ANTHROPIC_DEFAULT_SONNET_MODEL:MODEL,ANTHROPIC_DEFAULT_OPUS_MODEL:MODEL,CLAUDE_CODE_SUBAGENT_MODEL:MODEL},model:MODEL,tools:[],mcpServers:{},maxTurns:1,effort:"low",maxBudgetUsd:3,abortController:controller,
   spawnClaudeCodeProcess:(o:any)=>{
    if([...Object.keys(CLEARED_API_CREDENTIALS).filter(k=>k!=="ANTHROPIC_BASE_URL"),...unrelatedProviderCredentials].some(k=>o.env[k]))throw Error("Unrelated provider credentials in isolated child");
    assertNative(o.command,frozen);child=spawn(o.command,options.offlineInvalidArgument?[...o.args,"--fixture-invalid-review-argument"]:o.args,{cwd:o.cwd,env:o.env,stdio:["pipe","pipe","pipe"]});
    close=new Promise(resolve=>child!.on("close",(code,signal)=>{native.exitCode=code;native.signalCode=signal;save();resolve();}));
    let pending="";const originalWrite=child.stdin!.write.bind(child.stdin!);
    (child.stdin! as any).write=(chunk:any,encoding:any,callback:any)=>{
     const bytes=typeof chunk==="string"?Buffer.from(chunk,typeof encoding==="string"?encoding as BufferEncoding:"utf8"):Buffer.from(chunk);
     appendFileSync(nativePath+".stdin.jsonl",bytes);pending+=bytes.toString("utf8");
     const lines=pending.split("\n");pending=lines.pop()!;for(const line of lines){try{const f=JSON.parse(line);if(f.type==="control_request")commands.set(f.request_id,f.request?.subtype);}catch{native.inputFailure="Malformed native input";}}
     return originalWrite(chunk,encoding,callback);
    };
    const capture=captureReviewStdout(nativePath+".stdout.jsonl",observe); child.stdout!.pipe(capture);Object.defineProperty(child,"stdout",{value:capture});
    stdoutEnd=new Promise(resolve=>capture.on("end",()=>{native.stdoutComplete=true;save();resolve();}));
    const err=new Transform({transform(chunk,_encoding,cb){appendFileSync(nativePath+".stderr.bin",chunk);cb(null,chunk);}});
    child.stderr!.pipe(err);err.resume();stderrEnd=new Promise(resolve=>err.on("end",()=>{native.stderrDrained=true;save();resolve();}));
    return child;
   }}});handleResolve(q);for await(const _frame of q){/* authoritative result is captured before SDK parsing/throw */}
 }catch(e){native.failure??=String(e);}finally{
  clearTimeout(deadline);try{q?.close();}catch{native.failure??="SDK close failed";}
  const bounded=async(p:Promise<void>|undefined,ms:number)=>{if(!p)return false;let t:any;try{return await Promise.race([p.then(()=>true),new Promise<false>(r=>t=setTimeout(()=>r(false),ms))]);}finally{clearTimeout(t);}};
  child?.stdout?.resume();
  if(close && child){const drain=await drainReviewChild(child,close);if(drain.forcedKill)native.termination={requested:"SIGKILL",forced:true};}
  await Promise.all([bounded(stdoutEnd,2000),bounded(stderrEnd,2000)]);
  native.drained=native.exitCode!==null&&native.stdoutComplete&&native.stderrDrained;
  if(options.kind==="subscription-native-direct" && new Date().toISOString().slice(0,10)!==DETECTION_DAY)native.failure??="Actual detection day changed during drain";
  native.finished=native.drained;native.apiEquivalent=priceReview(native.result);save();
  try{await relay.stop();execution.relayClosed=true;}catch{execution.runnerFailure="Relay did not drain";native.failure??="Relay did not drain";save();}execution.runnerFailure??=native.failure;execution.finishedAtUtc=new Date().toISOString();execution.budget=budget.snapshot();execution.grantClaimSha=grantSha;saveExecution();
 }
 return {native,execution,calls:relay.calls,evidence:saveEvidenceBundle(directory)};
}
