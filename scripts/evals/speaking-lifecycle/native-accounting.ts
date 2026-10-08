/** Reconcile complete terminal physical counters to the final native model ledger. */
import { MODEL,type NativeCall } from "./relay";
import { priceSonnet55Usage } from "../../measure-sonnet55-cost";
import { digest } from "./source-admission";
export function reconcileNative(result:any,calls:NativeCall[]){
 if(!result||result.is_error||!Array.isArray(calls)||!calls.length||JSON.stringify(Object.keys(result.modelUsage??{}))!==JSON.stringify([MODEL]))throw Error("Native final usage/model missing or auxiliary model unknown");
 const model=result.modelUsage[MODEL];if(model.canonicalModel!==MODEL||model.provider!=="firstParty"||model.costBasis!=="list"||model.contextWindow!==1_000_000||model.maxOutputTokens!==128_000)throw Error("Native canonical served model/rates differ");
 const totals={inputTokens:0,outputTokens:0,cacheReadInputTokens:0,cacheCreationInputTokens:0};
 const equivalent={lowerUsd:0,upperUsd:0};
 for(const call of calls){
   if(!call.forwarded||call.requestedModel!==MODEL||call.servedModel!==MODEL||call.status!==200||call.outcome!=="completed"||!call.finished||!call.responseEof||!call.responseClosed||call.responseCancelled||!call.apiEquivalent||call.failure)throw Error("Incomplete physical native round trip");
   const bytes=Buffer.from(call.rawResponseBase64,"base64"),request=Buffer.from(call.rawRequestBase64,"base64");
   if(digest(bytes)!==call.rawResponseSha||bytes.length!==call.responseBytes||digest(request)!==call.requestSha||request.length!==call.stateBytes||JSON.parse(request.toString()).model!==MODEL)throw Error("Literal native request/response identity differs");
   const frames=new TextDecoder("utf-8",{fatal:true}).decode(bytes).replaceAll("\r\n","\n").split("\n\n").filter(s=>s.trim()).map(s=>JSON.parse(s.split("\n").filter(line=>line.startsWith("data: ")).map(line=>line.slice(6)).join("\n")));
   let counters:Record<string,any>={},terminal=false;const rawEvents=[];
   if(frames.filter(f=>f.type==="message_start").length!==1||frames.filter(f=>f.type==="message_stop").length!==1||frames.some(f=>f.type==="error"))throw Error("Native physical frame sequence incomplete");
   for(const frame of frames){const u=frame.type==="message_start"?frame.message?.usage:frame.type==="message_delta"?frame.usage:null;if(frame.type==="message_start"&&frame.message.model!==MODEL)throw Error("Physical served model differs");if(u){rawEvents.push({type:frame.type,usage:u});counters={...counters,...Object.fromEntries(Object.entries(u).filter(([,value])=>value!=null))};}if(frame.type==="message_delta"&&Number.isSafeInteger(u?.output_tokens)&&u.output_tokens>=0)terminal=true;}
   if(!terminal||JSON.stringify(counters)!==JSON.stringify(call.usage)||JSON.stringify(rawEvents)!==JSON.stringify(call.rawUsageEvents))throw Error("Terminal physical output/raw counters differ");
   for(const [physical,native]of [["input_tokens","inputTokens"],["output_tokens","outputTokens"],["cache_read_input_tokens","cacheReadInputTokens"],["cache_creation_input_tokens","cacheCreationInputTokens"]] as const){if(!Number.isSafeInteger(counters[physical])||counters[physical]<0)throw Error("Missing physical native counter");totals[native]+=counters[physical];}
   const price=priceSonnet55Usage({modelUsage:{[MODEL]:{inputTokens:counters.input_tokens,outputTokens:counters.output_tokens,cacheReadInputTokens:counters.cache_read_input_tokens,cacheCreationInputTokens:counters.cache_creation_input_tokens}},usage:{cache_creation:counters.cache_creation}});
   if(JSON.stringify(price)!==JSON.stringify(call.apiEquivalent))throw Error("Physical independent price differs");equivalent.lowerUsd+=price.lowerUsd;equivalent.upperUsd+=price.upperUsd;
 }
 if(Object.entries(totals).some(([key,value])=>model[key]!==value))throw Error("Physical terminal counters do not reconcile final native modelUsage");
 return {totals,equivalent,finalEquivalent:priceSonnet55Usage(result),physicalRoundTrips:calls.length,actualInvoiceUsd:null};
}
