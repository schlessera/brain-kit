/** Private no-tools extraction review collector. Never runs the prospective scored core comparison. */
import {mkdirSync,readlinkSync,writeFileSync} from "node:fs";
import {join} from "node:path";
import {NativeEvidence} from "./native-evidence";
import {extractionPaidFreeze,openExtractionPaid,extractionSource} from "./paid";
import {startRelay,type NativeCall} from "./paid-relay";
import {CLEARED_API_CREDENTIALS,NEUTRALISED_SETTINGS,subscriptionVerdict,settingsRefusal} from "../../../packages/ui-backend-claude/src/subscription";
import {admittedNativeRate,digest,literalNativeUsage,reparseNativeBudget,type NativePaidPolicy} from "../native-paid-policy";
import {nativeWallTime} from "../native-paid-entry";
export async function collectExtractionReview(options:{output:string;prompt:string;token:string;offline:boolean;fetch?:(url:string,init:RequestInit)=>Promise<Response>;
  proofSha?:string;offlinePolicy?:NativePaidPolicy;deadlineMs?:number;offlineCredentialOverride?:"api-key"}){
  if(options.offline){
    if(process.env.BRAIN_EXTRACTION_OFFLINE!=="1"||!process.env.BRAIN_EXTRACTION_PARENT_NET||
      readlinkSync("/proc/self/ns/net")===process.env.BRAIN_EXTRACTION_PARENT_NET||!options.fetch)throw Error("Distinct offline namespace and scripted upstream required");
  }else if(options.fetch||options.offlinePolicy||options.offlineCredentialOverride||process.env.BRAIN_EXTRACTION_DISPATCH!=="849-root-approved")throw Error("Explicit Root extraction review admission required");
  mkdirSync(options.output,{mode:0o700});const home=join(options.output,"home");mkdirSync(home,{mode:0o700});
  const frozen=extractionPaidFreeze(),paid=openExtractionPaid({...options,frozen});
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),options.offline?(options.deadlineMs??30000):240000);
  let promptReleased=false,account:unknown=null,settings:unknown=null,failure:string|null=null;
  const evidence=new NativeEvidence(()=>{if(!promptReleased)throw Error("Protected extraction handshake absent before USER");paid.verify();});
  const save=(calls:NativeCall[])=>writeFileSync(join(options.output,"physical.json"),JSON.stringify(calls,null,2),{mode:0o600});
  const relay=startRelay({oauthToken:options.token,fetch:options.fetch??globalThis.fetch,budget:paid.budget,verifyPaid:paid.verify,
    save,onRefusal:()=>controller.abort()});
  const sdk=Bun.resolveSync("@anthropic-ai/claude-agent-sdk",join(extractionSource,"packages/ui-backend-claude/src"));
  const {query}=await import(sdk) as typeof import("@anthropic-ai/claude-agent-sdk");
  let handleResolve!:(h:any)=>void;const handle=new Promise<any>(resolve=>handleResolve=resolve);
  async function* prompt(){
    const cli=await handle,init=await cli.initializationResult(),report=await cli.getSettings();account=init.account;settings=report;
    if(!subscriptionVerdict(init.account).ok||settingsRefusal(report)){controller.abort();throw Error("Protected extraction account/settings refused");}
    paid.verify();promptReleased=true;
    yield {type:"user" as const,parent_tool_use_id:null,message:{role:"user" as const,content:options.prompt},session_id:""};
  }
  let stream:ReturnType<typeof query>|undefined;
  try{
    stream=query({prompt:prompt(),options:{cwd:home,model:"claude-sonnet-5-5",permissionMode:"default",tools:[],allowedTools:[],
      settingSources:[],settings:{...NEUTRALISED_SETTINGS,autoMemoryEnabled:false,...(options.offlineCredentialOverride?{env:{...CLEARED_API_CREDENTIALS,ANTHROPIC_API_KEY:"offline-fixture-not-a-credential"}}:{})},persistSession:false,includePartialMessages:true,
      maxTurns:16,effort:"low",abortController:controller,spawnClaudeCodeProcess:evidence.spawn,
      env:{HOME:home,CLAUDE_CONFIG_DIR:home,PATH:`${join(process.execPath,"..")}:/usr/bin:/bin`,...CLEARED_API_CREDENTIALS,
        CLAUDE_CODE_OAUTH_TOKEN:options.token,ANTHROPIC_BASE_URL:relay.url,CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:"1",
        ANTHROPIC_DEFAULT_HAIKU_MODEL:"claude-sonnet-5-5",ANTHROPIC_SMALL_FAST_MODEL:"claude-sonnet-5-5",...(options.offlineCredentialOverride?{ANTHROPIC_API_KEY:"offline-fixture-not-a-credential",CLAUDE_CODE_OAUTH_TOKEN:""}:{})}}});
    handleResolve(stream);
    for await(const message of stream){
      if(message.type==="rate_limit_event"&&!admittedNativeRate(message.rate_limit_info,true))throw Error("Extraction native quota/paid admission refused");
      if(message.type==="system"&&message.subtype==="init"&&(message.model!=="claude-sonnet-5-5"||message.claude_code_version!=="2.1.293"||message.apiKeySource!=="none"||message.permissionMode!=="default"))throw Error("Original extraction runtime/auth/default permission differs");
      if(message.type==="result"&&(message.is_error||message.subtype!=="success"))throw Error("Extraction native result incomplete");
    }
  }catch(error){failure=String(error);controller.abort();}
  finally{clearTimeout(timer);stream?.close();await evidence.drain();await relay.stop();}
  const rawInput=evidence.rawInput(),rawStdout=evidence.rawBytes(),rawStderr=evidence.rawStderr();
  for(const [name,raw] of [["stdin.jsonl",rawInput],["stdout.jsonl",rawStdout],["stderr.bin",rawStderr]] as const)writeFileSync(join(options.output,name),raw,{mode:0o600});
  const init=evidence.frames.filter(f=>f.type==="system"&&f.subtype==="init"),rates=evidence.frames.filter(f=>f.type==="rate_limit_event"),accounting=evidence.accounting();
  let reconstructed=false;
  try{
    const physical=reconstructExtractionCalls(relay.calls);
    reconstructed=reparseNativeBudget(849,options.offline?"offline":"live",paid.evidence.policy,paid.evidence.binding,paid.evidence.entries,physical,nativeWallTime());
  }catch{}
  const complete=!failure&&promptReleased&&init.length===1&&rates.length>0&&rates.every(f=>admittedNativeRate(f.rate_limit_info,true))&&accounting.complete&&relay.complete()&&reconstructed;
  const receipt={kind:options.offline?"offline-native-scripted":"subscription-native-direct",complete,failure,promptReleased,account,settings,
    init,rates,accounting,processes:evidence.native.processes,paid:paid.evidence,calls:relay.calls,reconstructed,
    raw:{stdinSha:digest(rawInput),stdoutSha:digest(rawStdout),stderrSha:digest(rawStderr)},runtime:frozen.runtime,
    semanticApproval:false,actualAdditionalBilledUsd:null,scope:"paid review transport only; original extraction comparison remains prospective"};
  writeFileSync(join(options.output,"receipt.json"),JSON.stringify(receipt,null,2),{mode:0o600});return receipt;
}

export function reconstructExtractionCalls(calls:NativeCall[]){
  return calls.map(c=>({requestBytesBase64:c.rawRequestBase64,usage:literalNativeUsage({requestMethod:c.requestMethod,requestPath:c.requestPath,status:c.status,upstreamDispatched:c.upstreamDispatched,subscriptionHeaderAccepted:c.authRoute==="subscription-oauth-no-api-key",finished:c.finished,responseNaturalEof:c.responseEof,consumerCancelled:c.responseCancelled,streamClosed:c.responseClosed,upstreamReaderClosed:c.upstreamReaderClosed,outcome:c.outcome,requestBytesBase64:c.rawRequestBase64,requestSha:c.requestSha,requestBody:Buffer.from(c.rawRequestBase64,"base64").toString("utf8"),requestPricingHeaders:c.requestPricingHeaders,responseHeaders:c.responseHeaders,responseBytesBase64Chunks:[c.rawResponseBase64],usage:c.usage,rawUsageEvents:c.rawUsageEvents})}));
}
