/** Literal paid-review proof validation. True means transport proof, never semantic approval. */
import {readFileSync} from "node:fs";
import {join} from "node:path";
import {digest,admittedNativeRate,reparseNativeBudget,validateNativePaidPolicy} from "../native-paid-policy";
import {protectedNativeJson} from "../native-paid-entry";
import {subscriptionVerdict,settingsRefusal} from "../../../packages/ui-backend-claude/src/subscription";
import {reconstructExtractionCalls} from "./paid-native";
const equal=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
export function validateExtractionPaidArtifacts(directory:string){
  try{
    const receipt=JSON.parse(readFileSync(join(directory,"receipt.json"),"utf8")),paid=JSON.parse(readFileSync(join(directory,"paid.json"),"utf8"));
    if(!receipt.complete||receipt.failure||receipt.semanticApproval!==false||receipt.actualAdditionalBilledUsd!==null||!equal(paid,receipt.paid)||
      !receipt.processes?.length||receipt.processes.some((p:any)=>!p.closed||!p.stdoutFinished||p.forcedKill||p.error||p.code!==0))return false;
    const input=readFileSync(join(directory,"stdin.jsonl")),stdout=readFileSync(join(directory,"stdout.jsonl")),stderr=readFileSync(join(directory,"stderr.bin"));
    if(digest(input)!==receipt.raw.stdinSha||digest(stdout)!==receipt.raw.stdoutSha||digest(stderr)!==receipt.raw.stderrSha)return false;
    const parse=(b:Buffer)=>new TextDecoder("utf-8",{fatal:true}).decode(b).split("\n").filter(l=>l.trim()).map(l=>JSON.parse(l));
    const sent=parse(input),frames=parse(stdout),users=sent.filter(f=>f.type==="user"),init=frames.filter(f=>f.type==="system"&&f.subtype==="init"),results=frames.filter(f=>f.type==="result"),rates=frames.filter(f=>f.type==="rate_limit_event");
    if(users.length!==1||digest(users[0].message?.content)!==paid.binding.promptSha||init.length!==1||results.length!==1||results[0].subtype!=="success"||results[0].is_error||
      !equal(results[0],receipt.accounting.result)||!equal(init,receipt.init)||!equal(rates,receipt.rates)||!rates.length||rates.some(f=>!admittedNativeRate(f.rate_limit_info,true)))return false;
    const native=init[0];if(native.model!=="claude-sonnet-5-5"||native.claude_code_version!=="2.1.293"||native.permissionMode!=="default"||native.apiKeySource!=="none"||native.tools.length)return false;
    const responses=frames.filter(f=>f.type==="control_response"),answer=(subtype:string)=>{
      const requests=sent.filter(f=>f.type==="control_request"&&f.request?.subtype===subtype);
      if(requests.length!==1)throw Error("Missing/duplicate actual native handshake");
      const response=responses.filter(f=>f.response?.request_id===requests[0].request_id);
      if(response.length!==1||response[0].response.subtype!=="success")throw Error("Native handshake refused");
      return response[0].response.response;
    };
    const account=answer("initialize").account,settings=answer("get_settings");
    if(!equal(account,receipt.account)||!equal(settings,receipt.settings)||!subscriptionVerdict(account).ok||settingsRefusal(settings))return false;
    const marker=protectedNativeJson(paid.policy.consumedMarkerPath),copy=readFileSync(join(directory,"paid-grant.json"));
    if(!marker.raw.equals(copy)||marker.sha!==paid.grant.sha||!equal(marker.value,paid.grant.marker)||
      marker.value.policySha!==digest(JSON.stringify(paid.policy))||marker.value.bindingSha!==digest(JSON.stringify(paid.binding)))return false;
    const at=paid.entries[0]?.at;validateNativePaidPolicy(849,paid.policy.control,paid.policy,paid.binding,at);
    if(paid.policySha!==digest(JSON.stringify(paid.policy))||paid.binding.runtimeSha!==digest(JSON.stringify(receipt.runtime))||receipt.runtime.sdk!=="0.3.293")return false;
    const calls=JSON.parse(readFileSync(join(directory,"physical.json"),"utf8"));if(!equal(calls,receipt.calls))return false;
    const physical=reconstructExtractionCalls(calls);
    if(!reparseNativeBudget(849,paid.policy.control,paid.policy,paid.binding,paid.entries,physical))return false;
    const model=results[0].modelUsage,rows=Object.entries(model??{});
    if(rows.length!==1||rows[0]![0]!=="claude-sonnet-5-5")return false;
    const total=rows[0]![1] as any;
    for(const [physicalKey,nativeKey] of [["input_tokens","inputTokens"],["output_tokens","outputTokens"],["cache_read_input_tokens","cacheReadInputTokens"],["cache_creation_input_tokens","cacheCreationInputTokens"]])
      if(physical.reduce((n,c)=>n+Number(c.usage[physicalKey as keyof typeof c.usage]),0)!==total[nativeKey!])return false;
    return true;
  }catch{return false;}
}
