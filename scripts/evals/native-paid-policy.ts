/** Private native experiment reservations. Root owns allocations; these are never invoices. */
import { createHash } from "node:crypto";
import { assertGrantPath,validGrantTime,type GrantPolicy } from "./native-grant";
import { rejectPriceModifiers,rejectResponseModifiers,usageUpper,type RawTokens,type ReviewBinding } from "./native-pricing";

export type NativeIssue=842|843|844|845|846|847|849|850;
export const PAID_AUTHORIZATION="https://github.com/schlessera/brain-kit/issues/838#issuecomment-6065882737";
export const NATIVE_MODEL="claude-sonnet-5-5";
export const digest=(bytes:string|Uint8Array)=>createHash("sha256").update(bytes).digest("hex");
export interface NativePaidPolicy extends GrantPolicy,ReviewBinding {
  version:1;issue:NativeIssue;control:"live"|"offline";purpose:"review"|"workflow";authorizationUrl:string;allowOverage:true;
  basis:"actual additional billed charges";perIssueCapUsd:15;aggregateCapUsd:150;remainingUpperUsd:number;
  canonicalModel:typeof NATIVE_MODEL;maxPhysicalRequests:24;maxInputBytes:number;
  contextWindowTokens:1_000_000;maxOutputTokens:128000;inputUsdPerMillionUpper:8;outputUsdPerMillionUpper:20;invoiceUsd:null;nativeUserContextSha?:string;
}
const count=(n:unknown):n is number=>typeof n==="number"&&Number.isSafeInteger(n)&&n>=0;
const finite=(n:unknown):n is number=>typeof n==="number"&&Number.isFinite(n)&&n>=0;
const keys=["freezeSha","inputSha","protocolSha","runtimeSha","proofSha","promptSha"] as const;
export function validateNativePaidPolicy(issue:NativeIssue,control:NativePaidPolicy["control"],p:NativePaidPolicy,b:ReviewBinding,now=Date.now()){
  assertGrantPath(p);
  if(p.version!==1||p.issue!==issue||p.control!==control||!["review","workflow"].includes(p.purpose)||p.authorizationUrl!==PAID_AUTHORIZATION||p.allowOverage!==true||
    p.basis!=="actual additional billed charges"||p.perIssueCapUsd!==15||p.aggregateCapUsd!==150||p.invoiceUsd!==null||
    p.canonicalModel!==NATIVE_MODEL||p.maxPhysicalRequests!==24||p.contextWindowTokens!==1_000_000||p.maxOutputTokens!==128000||
    p.inputUsdPerMillionUpper!==8||p.outputUsdPerMillionUpper!==20||!count(p.maxInputBytes)||!p.maxInputBytes||
    !finite(p.remainingUpperUsd)||p.remainingUpperUsd>15||!validGrantTime(p,now)||
    (p.nativeUserContextSha!==undefined&&(issue===842||!/^[a-f0-9]{64}$/.test(p.nativeUserContextSha)))||
    keys.some(k=>!/^[a-f0-9]{64}$/.test(b[k])||p[k]!==b[k]))throw Error("Missing, stale or mismatched root native paid allocation");
  return p;
}
/** An included-only rejection can coexist with allowed paid overage. Keep its literal state. */
export function admittedNativeRate(info:any,paid:boolean){
  if(!info||!["allowed","allowed_warning","rejected"].includes(info.status))return false;
  const states=[info.isUsingOverage,info.overageInUse].filter(v=>v!==undefined);
  if(!states.length||states.some(v=>typeof v!=="boolean")||states.some(v=>v!==states[0]))return false;
  if(states[0]===false)return ["allowed","allowed_warning"].includes(info.status);
  return paid&&!info.overageDisabledReason&&["allowed","allowed_warning"].includes(info.overageStatus);
}
export interface NativeReservation {
  index:number;at:number;requestSha:string;inputBound:1_000_000;outputBound:number;reservedUpperUsd:number;
  status:"reserved"|"complete"|"unknown";pricedUpperUsd:number|null;rawUsage:RawTokens|null;invoiceUsd:null;
}
export function observedNativeModifiers(headers:Record<string,string>){
  for(const key of ["service-tier","anthropic-service-tier"]){if(headers[key]!=null)rejectResponseModifiers({service_tier:headers[key]});}
  for(const key of ["inference-geo","anthropic-inference-geo"]){if(headers[key]!=null)rejectResponseModifiers({inference_geo:headers[key]});}
  if(headers.speed!=null||headers["fast-mode"]!=null||/fast|priority/i.test(headers["anthropic-beta"]??""))throw Error("Unsupported observed native response pricing header");
}
/** Reparse preserved upstream bytes rather than trusting a supplied usage summary. */
export function literalNativeUsage(call:any):RawTokens{
  if(call.requestMethod!=="POST"||!["/v1/messages","/v1/messages?beta=true"].includes(call.requestPath))throw Error("Literal native endpoint differs");
  if(call.status!==200||!call.upstreamDispatched||!call.subscriptionHeaderAccepted||!call.finished||!call.responseNaturalEof||call.consumerCancelled||!call.streamClosed||!call.upstreamReaderClosed||call.outcome!=="completed")throw Error("Incomplete physical native receipt");
  const request=Buffer.from(call.requestBytesBase64,"base64");
  rejectPriceModifiers(JSON.parse(call.requestBody),new Headers(call.requestPricingHeaders));
  observedNativeModifiers(call.responseHeaders??{});
  if(digest(request)!==call.requestSha||request.toString("utf8")!==call.requestBody||JSON.parse(call.requestBody).model!==NATIVE_MODEL)throw Error("Literal native request differs");
  const bytes=Buffer.concat(call.responseBytesBase64Chunks.map((b:string)=>Buffer.from(b,"base64")));
  const text=new TextDecoder("utf-8",{fatal:true}).decode(bytes).replace(/\r\n/g,"\n"),events:any[]=[];
  for(const frame of text.split("\n\n")){
    const data=frame.split("\n").filter(line=>line.startsWith("data: ")).map(line=>line.slice(6)).join("\n");
    if(data&&data!=="[DONE]")events.push(JSON.parse(data));
  }
  const starts=events.filter(e=>e.type==="message_start"),stops=events.filter(e=>e.type==="message_stop");
  if(starts.length!==1||stops.length!==1||starts[0].message?.model!==NATIVE_MODEL||events.some(e=>e.type==="error"))throw Error("Literal native model/terminal stream differs");
  let usage={...starts[0].message.usage},output=false;const raw:any[]=[];
  for(const e of events){
    const u=e.type==="message_start"?e.message?.usage:e.type==="message_delta"?e.usage:null;
    if(u){rejectResponseModifiers(u);raw.push({type:e.type,usage:u});if(e.type==="message_delta"){usage={...usage,...Object.fromEntries(Object.entries(u).filter(([,v])=>v!=null))};if(count(u.output_tokens))output=true;}}
  }
  if(!output||JSON.stringify(usage)!==JSON.stringify(call.usage)||JSON.stringify(raw)!==JSON.stringify(call.rawUsageEvents))throw Error("Literal terminal usage differs from summary");
  rejectResponseModifiers(usage);usageUpper(usage,1_000_000,128000);return usage as RawTokens;
}
/** Independently reconstruct identities and terminal output from complete native bytes. */
export function literalNativeFrames(receipt:any){
  const raw=receipt.rawNative;
  if(!raw||digest(Buffer.from(raw.stdoutBase64,"base64"))!==raw.stdoutSha||digest(Buffer.from(raw.stderrBase64,"base64"))!==raw.stderrSha)throw Error("Literal native output hashes differ");
  const frames=new TextDecoder("utf-8",{fatal:true}).decode(Buffer.from(raw.stdoutBase64,"base64")).split("\n").filter(line=>line.trim()).map(line=>JSON.parse(line));
  const init=frames.filter(f=>f.type==="system"&&f.subtype==="init"),result=frames.filter(f=>f.type==="result");
  if(init.length!==1||result.length!==1||JSON.stringify(result[0])!==JSON.stringify(receipt.result)||
    JSON.stringify(frames.filter(f=>f.type==="rate_limit_event").map(f=>f.rate_limit_info??{}))!==JSON.stringify(receipt.rateLimits)||
    JSON.stringify({model:init[0].model,apiKeySource:init[0].apiKeySource,cli:init[0].claude_code_version})!==JSON.stringify(receipt.init))throw Error("Literal native init/rates/result differ from summary");
  if(!receipt.rateLimits.length||receipt.rateLimits.some((info:any)=>!admittedNativeRate(info,receipt.paid?.policy.allowOverage===true)))throw Error("Literal native quota/paid admission refused");
  return frames;
}
export class NativeBudget {
  readonly policy:NativePaidPolicy;readonly binding:ReviewBinding;
  private records:NativeReservation[]=[];private blocked=false;
  constructor(readonly issue:NativeIssue,readonly control:NativePaidPolicy["control"],p:NativePaidPolicy,b:ReviewBinding,
    private readonly persist:(entries:NativeReservation[])=>void,private readonly clock=Date.now){
    validateNativePaidPolicy(issue,control,p,b,clock());this.policy=Object.freeze(structuredClone(p));this.binding=Object.freeze(structuredClone(b));
  }
  get entries(){return structuredClone(this.records);}
  usedUpper(){return this.records.reduce((n,r)=>n+(r.status==="complete"?r.pricedUpperUsd!:r.reservedUpperUsd),0);}
  reserve(bytes:Uint8Array,headers?:Headers){
    validateNativePaidPolicy(this.issue,this.control,this.policy,this.binding,this.clock());
    if(this.blocked||this.records.some(r=>r.status==="reserved")||this.records.length>=24)throw Error("Prior unknown/inflight native request or physical bound");
    if(!bytes.byteLength||bytes.byteLength>this.policy.maxInputBytes)throw Error("Native request byte bound");
    const request=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes));
    if(request.model!==NATIVE_MODEL||!count(request.max_tokens)||!request.max_tokens||request.max_tokens>128000)throw Error("Native model/output bound before forwarding");
    rejectPriceModifiers(request,headers);
    const users=Array.isArray(request.messages)?request.messages.filter((m:any)=>m?.role==="user"):[];
    let frozen=0;
    for(const user of users){
      const content=user.content;
      if(typeof content==="string"&&digest(content)===this.binding.promptSha){frozen++;continue;}
      if(Array.isArray(content)&&content.length===1&&content[0]?.type==="text"&&typeof content[0].text==="string"&&digest(content[0].text)===this.binding.promptSha){frozen++;continue;}
      if(this.policy.nativeUserContextSha&&Array.isArray(content)&&content.length===2&&content.every((b:any)=>b?.type==="text"&&typeof b.text==="string")&&digest(content[0].text)===this.policy.nativeUserContextSha&&digest(content[1].text)===this.binding.promptSha){frozen++;continue;}
      if(this.policy.purpose==="workflow"&&Array.isArray(content)&&content.length&&content.every((b:any)=>b?.type==="tool_result"))continue;
      throw Error("Unreviewed native USER payload before forwarding");
    }
    if(frozen!==1||(this.policy.purpose==="review"&&(users.length!==1||request.tools?.length||request.output_config?.effort!=="low")))throw Error("Exact frozen native prompt/tool/effort boundary");
    // Hidden framing is not bounded by wire bytes. Every physical request reserves full supported context.
    const reservedUpperUsd=(1_000_000*8+request.max_tokens*20)/1e6;
    if(!finite(reservedUpperUsd)||this.usedUpper()+reservedUpperUsd>this.policy.remainingUpperUsd)throw Error("Native reservation exceeds remaining allocation");
    const entry:NativeReservation={index:this.records.length,at:this.clock(),requestSha:digest(bytes),inputBound:1_000_000,
      outputBound:request.max_tokens,reservedUpperUsd,status:"reserved",pricedUpperUsd:null,rawUsage:null,invoiceUsd:null};
    this.records.push(entry);try{this.persist(this.entries);}catch(error){this.blocked=true;throw error;}return entry.index;
  }
  settle(index:number,usage:RawTokens){
    const entry=this.records[index];if(!entry||entry.status!=="reserved")throw Error("Unknown or already settled native reservation");
    try{
      rejectResponseModifiers(usage);
      const upper=usageUpper(usage,entry.inputBound,entry.outputBound,8,20);
      const completed:NativeReservation={...entry,status:"complete",pricedUpperUsd:upper,rawUsage:structuredClone(usage)};
      this.persist(this.records.map(r=>structuredClone(r.index===index?completed:r)));Object.assign(entry,completed);
    }catch(error){this.unknown(index);throw error;}
  }
  unknown(index:number){const r=this.records[index];if(!r||r.status!=="reserved")throw Error("Unknown or settled native reservation");r.status="unknown";this.blocked=true;this.persist(this.entries);}
}
/** Literal physical request/terminal counters rebuild the ledger; flags do not replace it. */
export function reparseNativeBudget(issue:NativeIssue,control:NativePaidPolicy["control"],policy:NativePaidPolicy,binding:ReviewBinding,
  entries:NativeReservation[],calls:Array<{requestBytesBase64:string;usage:RawTokens}>,observedAt=Date.now()){
  if(!entries.length||entries.length!==calls.length)return false;
  try{
    let at=entries[0]!.at;const budget=new NativeBudget(issue,control,policy,binding,()=>{},()=>at);
    for(let i=0;i<calls.length;i++){
      const entry=entries[i]!;if(!finite(entry.at)||entry.at>observedAt||(i&&entry.at<entries[i-1]!.at))return false;at=entry.at;
      const id=budget.reserve(Buffer.from(calls[i]!.requestBytesBase64,"base64"));budget.settle(id,calls[i]!.usage);
    }
    return JSON.stringify(budget.entries)===JSON.stringify(entries);
  }catch{return false;}
}
