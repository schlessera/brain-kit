/** Explicit one-time rehydration of a preserved physical response, never fresh flat inference. */
import {readFileSync,appendFileSync} from "node:fs";
import {join} from "node:path";
import {createHash} from "node:crypto";
const sha=(value:Uint8Array|string)=>createHash("sha256").update(value).digest("hex");
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
export function createPiSchemaReplay(root:string,expected:{receiptSha256:string;rawSha256:string},log:string){
  const receiptBytes=readFileSync(join(root,"flat/receipts/physical-requests.json"));
  const raw=readFileSync(join(root,"flat/receipts/physical-1.error-body"));
  if(sha(receiptBytes)!==expected.receiptSha256||sha(raw)!==expected.rawSha256)throw new Error("Original replay prefix hash mismatch.");
  const receipts=JSON.parse(receiptBytes.toString());
  if(receipts.length!==1||receipts[0].sequence!==1||receipts[0].form!=="flat"||receipts[0].status!==200||receipts[0].requestedModel!=="gpt-6.1-sol"||receipts[0].route!=="native-codex-subscription"||!receipts[0].auth.bearerMatchesNativeAccess||!receipts[0].auth.accountHeaderMatchesNativeClaim||receipts[0].auth.originator!=="pi")throw new Error("Original physical request provenance mismatch.");
  const original=receipts[0];const events=raw.toString().split("\n").filter(line=>line.startsWith("data: ")).map(line=>JSON.parse(line.slice(6)));
  const terminal=events.at(-1);
  if(terminal?.type!=="response.completed"||terminal.response?.status!=="completed"||terminal.response?.model!==original.requestedModel)throw new Error("Original replay response lacks completed exact-model terminal.");
  const calls=terminal.response.output.filter((item:any)=>item.type==="function_call");
  if(calls.length!==1||calls[0].name!=="show_block"||typeof calls[0].call_id!=="string"||typeof calls[0].arguments!=="string")throw new Error("Original replay response must carry its single show_block call.");
  const call=calls[0];const expectedResult=JSON.parse(call.arguments);
  let replayed=false;let continuations=0;
  return {
    original,
    beforeRequest(body:any,localWireSha256:string){
      const differingFields=[...new Set([...Object.keys(original.request),...Object.keys(body)])].filter(key=>!same(original.request[key],body[key]));
      if(!replayed){
        if(differingFields.some(key=>key!=="prompt_cache_key"))throw new Error("Rehydrated request differs from original semantic context.");
        replayed=true;
        const provenance={kind:"recovered-original-physical" as const,originalReceiptSha256:expected.receiptSha256,rawSha256:expected.rawSha256,originalObserverError:original.error,localReplayWireSha256:localWireSha256,differingFields,unchangedRequestWire:localWireSha256===original.wireSha256,sameServerSession:false,originalHeadersComplete:false};
        appendFileSync(log,JSON.stringify({event:"prefix-replayed-once",externalProviderDispatch:false,provenance,localReplayRequest:body})+"\n",{mode:0o600});
        return {original,provenance,response:new Response(raw,{status:original.status,headers:original.headers})};
      }
      if(++continuations>4||differingFields.some(key=>key!=="input"&&key!=="prompt_cache_key"))throw new Error("Continuation bound or original semantic context mismatch.");
      const actualCall=body.input?.find((item:any)=>item.type==="function_call"&&item.call_id===call.call_id);
      const result=body.input?.find((item:any)=>item.type==="function_call_output"&&item.call_id===call.call_id);
      if(!actualCall||actualCall.name!==call.name||actualCall.arguments!==call.arguments||!result||typeof result.output!=="string"||!same(JSON.parse(result.output),expectedResult)||!same(body.input.filter((item:any)=>item.role==="user"),original.request.input.filter((item:any)=>item.role==="user")))throw new Error("Continuation lost original call, parsed handler result or user input.");
      appendFileSync(log,JSON.stringify({event:"continuation-admitted",externalProviderDispatchAdmitted:true,continuation:continuations,originalCallIdPreserved:true,originalArgumentsPreserved:true,parsedOriginalHandlerResultPreserved:true,localWireSha256})+"\n",{mode:0o600});
      return null;
    }
  };
}
