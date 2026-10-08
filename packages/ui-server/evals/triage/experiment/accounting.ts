/** Private complete physical/workflow accounting. List estimates are never invoices. */
import { priceSonnet55Usage } from "../../../../../scripts/measure-sonnet55-cost";
import { sha } from "./adapter";
import { protocol } from "./protocol";
import type { PhysicalCall } from "./adapter";
const counter=(value:unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
export interface GenerationCall { phase:"baseline"|"fallback"|"summary"; model:string; physicalRequests:number; terminal:boolean; failed:boolean;
  usageBasis:"provider-terminal"|"native-final-all-model"; tokens:{input:number;output:number;cacheRead:number;cacheWrite:number}|null;
  priceEstimate:{lowerUsd:number;upperUsd:number;unknownCacheTokens:number}|null; rawRequest:string;rawResponseBase64:string;failure:string|null;durationMs:number|null }
function terminalEvidence(call:GenerationCall) {
 try {
  const decoded=new TextDecoder("utf-8",{fatal:true}).decode(Buffer.from(call.rawResponseBase64,"base64"));
  let result:any;
  if(call.usageBasis === "native-final-all-model") {
   const results=decoded.split("\n").filter(Boolean).map(s=>JSON.parse(s)).filter(e=>e.type === "result");
   if(results.length !== 1)return null;
   result=results[0];
  } else if(call.usageBasis === "provider-terminal") {
   const frames=decoded.replaceAll("\r\n","\n").split("\n\n").flatMap(f=>f.split("\n").filter(s=>s.startsWith("data: ")).map(s=>JSON.parse(s.slice(6))));
   const starts=frames.filter(e=>e.type === "message_start"),deltas=frames.filter(e=>e.type === "message_delta" && counter(e.usage?.output_tokens));
   if(starts.length!==1 || !deltas.length || frames.filter(e=>e.type === "message_stop").length!==1)return null;
   const u={...starts[0].message.usage,...Object.assign({},...deltas.map(e=>Object.fromEntries(Object.entries(e.usage).filter(([,v])=>v!=null))))};
   result={modelUsage:{[starts[0].message.model]:{inputTokens:u.input_tokens,outputTokens:u.output_tokens,cacheReadInputTokens:u.cache_read_input_tokens,cacheCreationInputTokens:u.cache_creation_input_tokens}},usage:u};
  } else return null;
  if(JSON.stringify(Object.keys(result.modelUsage ?? {}))!==JSON.stringify([protocol.models.generation]))return null;
  const u=result.modelUsage[protocol.models.generation],tokens={input:u.inputTokens,output:u.outputTokens,cacheRead:u.cacheReadInputTokens,cacheWrite:u.cacheCreationInputTokens};
  const price=priceSonnet55Usage(result);
  return Object.keys(tokens).every(k=>tokens[k as keyof typeof tokens] === call.tokens?.[k as keyof typeof tokens]) && JSON.stringify(price)===JSON.stringify(call.priceEstimate)?{tokens,price}:null;
 }catch{return null;}
}
export function workflowAccounting(classification:PhysicalCall[], generations:GenerationCall[], summaryDemand:boolean|null) {
 const costs:number[]=[], unknown:string[]=[];
 for(const [index,call] of classification.entries()) {
  const usage=call.usage as Record<string,unknown>|null;
  let raw:any=null,request:any=null;
  try { const bytes=Buffer.from(call.responseBase64 ?? "","base64"); if(sha(bytes)!==call.responseSha || sha(call.requestBody)!==call.requestSha)throw Error("Changed raw evidence");raw=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes));request=JSON.parse(call.requestBody); }catch{/* Unknown retained. */}
  if(call.model !== protocol.models.classification || request?.model!==protocol.models.classification || raw?.model!==call.model || JSON.stringify(raw?.usage)!==JSON.stringify(usage) || !usage || !counter(usage.input_tokens) || !counter(usage.output_tokens) || call.responseBase64 === null || !call.responseComplete)
   unknown.push(`classification:${index}`);
  else costs.push(usage.input_tokens * .042 / 1e6); // Verified official Jev input rate; output free, raw nonzero output still retained.
 }
 for(const [index,call] of generations.entries()) {
  const tokens=call.tokens;
  const known=call.terminal && counter(call.physicalRequests) && call.physicalRequests >= 1 &&
   ["provider-terminal","native-final-all-model"].includes(call.usageBasis) && tokens !== null &&
   Object.keys(tokens).length === 4 && ["input","output","cacheRead","cacheWrite"].every(key=>Object.hasOwn(tokens,key) && counter(tokens[key as keyof typeof tokens])) &&
   call.model === protocol.models.generation && typeof call.rawRequest === "string" && call.rawRequest.length>0 && typeof call.rawResponseBase64 === "string" && call.rawResponseBase64.length>0 &&
   typeof call.durationMs === "number" && Number.isFinite(call.durationMs) && call.durationMs >= 0;
  const price=call.priceEstimate;
  const priced=price !== null && [price.lowerUsd,price.upperUsd].every(n=>typeof n === "number" && Number.isFinite(n) && n >= 0) && price.upperUsd >= price.lowerUsd;
  const evidence=terminalEvidence(call);
  if(!known || !priced || !evidence) unknown.push(`generation:${index}`);
  if(known && priced && evidence)costs.push(price!.upperUsd); // Retain known terminal failed-call spend, independent of accepted outcome.
 }
 if(summaryDemand === null || (summaryDemand && !generations.some(g=>g.phase === "summary")))unknown.push("summary-demand");
 if(!classification.length && !generations.length)unknown.push("no-physical-receipts");
 return {receiptComplete:unknown.length === 0,knownListEstimateUpperUsd:costs.reduce((s,c)=>s+c,0),unknown,
  actualAdditionalInvoiceUsd:null,cacheAdjustments:null,tierAdjustments:null,geographyAdjustments:null,
  physicalRequests:classification.length+generations.reduce((n,g)=>n+(counter(g.physicalRequests)?g.physicalRequests:0),0),
  summaryDemand,failedGenerationCalls:generations.filter(g=>g.failed),rawClassification:classification,rawGenerations:generations,
  pricingScope:"standard/list diagnostic, not invoice/upper bound on billed spend; Sonnet5.5 cache-read ambiguity #1239 retained"};
}
export function latencySummary(values:number[]) {
 if(!values.length || values.some(n=>!Number.isFinite(n)||n<0))return null;
 const sorted=[...values].sort((a,b)=>a-b),p=(q:number)=>sorted[Math.max(0,Math.ceil(q*sorted.length)-1)]!;
 return {observations:values.length,p50Ms:p(.5),p95Ms:p(.95),totalMs:values.reduce((a,b)=>a+b,0),throughputPerSecond:values.reduce((a,b)=>a+b,0)>0?values.length*1000/values.reduce((a,b)=>a+b,0):null};
}
