/** Owned physical Messages relay; exact bytes are private and credentials stay memory-only. */
import { createHash } from "node:crypto";
import { priceSonnet55Usage } from "../../measure-sonnet55-cost";
import { observedNativeModifiers,type NativeBudget } from "../native-paid-policy";
import { rejectResponseModifiers } from "../../../packages/ui-server/evals/triage/experiment/paid-policy";
export const MODEL="claude-sonnet-5-5";
export interface NativeCall {
  requestPricingHeaders:Record<string,string>;responseHeaders:Record<string,string>;
  requestBody:string;requestBytesBase64:string;requestSha:string;stateBytes:number;
  responseFrames:string[];responseBytesBase64Chunks:string[];
  requestedModel:string;servedModel:string|null;status:number|null;
  subscriptionHeaderAccepted:boolean;upstreamDispatched:boolean;
  usage:Record<string,any>|null;rawUsageEvents:Array<{type:string;usage:Record<string,unknown>}>;
  finished:boolean;outcome:string;durationMs:number;failure?:string;
  responseNaturalEof:boolean;consumerCancelled:boolean;streamClosed:boolean;upstreamReaderClosed:boolean;
  apiEquivalent:ReturnType<typeof priceSonnet55Usage>|null;
}
export function startRelay(options:{oauthToken:string;fetch:(url:string,init:RequestInit)=>Promise<Response>;save:(calls:NativeCall[])=>void;upstream?:string;budget?:NativeBudget;verifyPaid?:()=>void;onRefusal?:(reason:string)=>void}){
  const calls:NativeCall[]=[];let stopped=false;
  const upstream=new URL(options.upstream??"https://api.anthropic.com");
  if(upstream.origin!=="https://api.anthropic.com"&&!["127.0.0.1","localhost"].includes(upstream.hostname))throw Error("Unapproved upstream");
  const owned=new Set<{abort:AbortController;closed:Promise<void>;cancel:(reason:unknown)=>Promise<void>}>();
  const save=()=>options.save(calls);
  const server=Bun.serve({hostname:"127.0.0.1",port:0,async fetch(request){
    const url=new URL(request.url);
    if(request.method!=="POST"||url.pathname!=="/v1/messages")return new Response("Only the native Messages endpoint is permitted",{status:403});
    // Capture native bytes before decoding, including invalid requests and
    // blocked retries. No Authorization/header values are retained.
    const requestBytes=new Uint8Array(await request.arrayBuffer()),started=performance.now();
    const call:NativeCall={requestPricingHeaders:Object.fromEntries([...request.headers].filter(([name])=>name==="anthropic-beta")),responseHeaders:{},requestBody:"",requestBytesBase64:Buffer.from(requestBytes).toString("base64"),requestSha:createHash("sha256").update(requestBytes).digest("hex"),stateBytes:requestBytes.byteLength,
      responseFrames:[],responseBytesBase64Chunks:[],requestedModel:"unknown",servedModel:null,status:null,
      subscriptionHeaderAccepted:request.headers.get("authorization")===`Bearer ${options.oauthToken}`&&!request.headers.get("x-api-key"),upstreamDispatched:false,
      usage:null,rawUsageEvents:[],finished:false,outcome:"received",durationMs:0,responseNaturalEof:false,consumerCancelled:false,streamClosed:false,upstreamReaderClosed:false,apiEquivalent:null};
    calls.push(call);save();
    const reject=(status:number,outcome:string)=>{call.status=status;call.outcome=outcome;call.finished=true;call.streamClosed=true;call.durationMs=performance.now()-started;save();options.onRefusal?.(call.failure??outcome);return new Response(outcome,{status});};
    if(stopped||calls.length>24||calls.slice(0,-1).some(row=>row.finished&&row.outcome!=="completed"))return reject(409,"admission_stopped");
    if(!call.subscriptionHeaderAccepted){stopped=true;return reject(403,"subscription_header_refused");}
    try{call.requestBody=new TextDecoder("utf-8",{fatal:true}).decode(requestBytes);const parsed=JSON.parse(call.requestBody);call.requestedModel=parsed.model??"unknown";}
    catch{stopped=true;return reject(400,"invalid_native_request");}
    if(call.requestedModel!==MODEL){stopped=true;return reject(403,"unexpected_requested_model");}
    let reservation:number|undefined;
    try{options.verifyPaid?.();if(options.budget)reservation=options.budget.reserve(requestBytes,request.headers);}
    catch(error){stopped=true;call.failure=String(error);return reject(403,"root_paid_reservation_refused");}
    const headers=new Headers(request.headers);for(const name of ["host","connection","content-length","transfer-encoding","accept-encoding"])headers.delete(name);
    const abort=new AbortController();let reader:ReadableStreamDefaultReader<Uint8Array>|undefined;
    let resolveClosed!:()=>void;const closed=new Promise<void>(resolve=>resolveClosed=resolve);
    const state={abort,closed,cancel:async(reason:unknown)=>{call.consumerCancelled=true;stopped=true;abort.abort(reason);try{if(reader){await reader.cancel(reason);save();}}catch{}await closed;}};
    owned.add(state);
    const onAbort=()=>{void state.cancel("Native downstream request aborted");};request.signal.addEventListener("abort",onAbort,{once:true});
    async function finish(){
      if(reader){try{await reader.closed;}catch{}call.upstreamReaderClosed=true;}
      if(reservation!==undefined){
        const id=reservation;reservation=undefined;
        if(call.outcome==="completed"&&call.responseNaturalEof&&!call.consumerCancelled&&call.status===200&&call.usage){
          try{options.budget!.settle(id,call.usage as any);}catch{stopped=true;call.apiEquivalent=null;call.outcome="root_paid_usage_refused";}
        }else options.budget!.unknown(id);
      }
      call.finished=true;call.streamClosed=true;call.durationMs=performance.now()-started;request.signal.removeEventListener("abort",onAbort);owned.delete(state);save();resolveClosed();
      if(call.outcome!=="completed")options.onRefusal?.(call.failure??call.outcome);
    }
    let response:Response;
    try{call.upstreamDispatched=true;call.outcome="upstream_dispatched";save();response=await options.fetch(`${upstream.origin}${url.pathname}${url.search}`,{method:"POST",headers,body:requestBytes,redirect:"error",signal:abort.signal});}
    catch(error){stopped=true;call.outcome=call.consumerCancelled?"consumer_cancelled":"network_error";call.failure=String(error);await finish();return new Response("Native upstream failed",{status:502});}
    call.status=response.status;call.responseHeaders=Object.fromEntries([...response.headers].filter(([name,value])=>!name.toLowerCase().includes(options.oauthToken.toLowerCase())&&!value.includes(options.oauthToken)));save();
    const outgoing=new Headers(response.headers);for(const name of ["content-length","content-encoding","transfer-encoding","connection"])outgoing.delete(name);
    if(!response.body){stopped=true;call.outcome="missing_response_body";await finish();return new Response(null,{status:response.status,headers:outgoing});}
    if(!response.ok){stopped=true;call.outcome="http_error";}
    reader=response.body.getReader();const decoder=new TextDecoder("utf-8",{fatal:true});let buffer="",sawStop=false,sawOutput=false;
    function observe(frame:string){
      call.responseFrames.push(frame);const data=frame.split("\n").filter(line=>line.startsWith("data: ")).map(line=>line.slice(6)).join("\n");
      if(!data||data==="[DONE]")return;const event=JSON.parse(data);
      if(event.type==="message_start"){call.servedModel=event.message?.model??null;call.usage={...event.message?.usage};}
      if(event.type==="message_start"||event.type==="message_delta"){
        const usage=event.type==="message_start"?event.message?.usage:event.usage;
        if(usage){call.rawUsageEvents.push({type:event.type,usage:structuredClone(usage)});if(options.budget)rejectResponseModifiers(usage);}
        if(event.type==="message_delta"&&usage){call.usage={...call.usage,...Object.fromEntries(Object.entries(usage).filter(([,value])=>value!=null))};sawOutput=Number.isSafeInteger(usage.output_tokens)&&usage.output_tokens>=0;}
      }
      if(event.type==="message_stop")sawStop=true;
      if(event.type==="error")throw Error("Native upstream stream error");
    }
    function decode(){buffer=buffer.replace(/\r\n/g,"\n");for(;;){const end=buffer.indexOf("\n\n");if(end<0)break;observe(buffer.slice(0,end));buffer=buffer.slice(end+2);}}
    const stream=new ReadableStream<Uint8Array>({start(controller){
      void(async()=>{
        try{
          if(options.budget)observedNativeModifiers(call.responseHeaders);
          for(;;){const next=await reader!.read();if(next.done){call.responseNaturalEof=!call.consumerCancelled&&!abort.signal.aborted;break;}
            // Literal upstream bytes are retained before any parse or forward.
            call.responseBytesBase64Chunks.push(Buffer.from(next.value).toString("base64"));save();
            if(response.ok){buffer+=decoder.decode(next.value,{stream:true});decode();}
            controller.enqueue(next.value);
          }
          if(call.consumerCancelled)throw Error("Native consumer cancelled before successful completion");
          if(response.ok){
            buffer+=decoder.decode();decode();if(buffer.trim())observe(buffer);
            if(!sawStop||!sawOutput||call.servedModel!==MODEL||!call.usage)throw Error("Missing terminal usage/model/stop evidence");
            call.apiEquivalent=priceSonnet55Usage({modelUsage:{[MODEL]:{inputTokens:call.usage.input_tokens,outputTokens:call.usage.output_tokens,cacheReadInputTokens:call.usage.cache_read_input_tokens,cacheCreationInputTokens:call.usage.cache_creation_input_tokens}},usage:{cache_creation:call.usage.cache_creation}});
            call.outcome="completed";
          }
          controller.close();
        }catch(error){stopped=true;call.apiEquivalent=null;call.outcome=call.consumerCancelled?"consumer_cancelled":response.ok?"missing_usage_or_parse_error":"http_error";call.failure=String(error);
          abort.abort(error);try{await reader!.cancel(error);}catch{}try{controller.error(error);}catch{}
        }finally{await finish();}
      })();
    },async cancel(reason){await state.cancel(reason);}});
    return new Response(stream,{status:response.status,headers:outgoing});
  }});
  return{url:`http://127.0.0.1:${server.port}`,calls,isStopped:()=>stopped,
    async stop(){stopped=true;await Promise.all([...owned].map(state=>state.cancel("Measurement relay shutdown")));server.stop(true);},
    complete:()=>calls.some(call=>call.upstreamDispatched)&&calls.every(call=>call.finished&&call.streamClosed&&call.responseNaturalEof&&!call.consumerCancelled&&call.outcome==="completed"&&call.apiEquivalent),
  };
}

/** Known subtotal is not a total when any dispatched physical request is unknown. */
export function physicalPriceDiagnostics(calls:NativeCall[]){
  const physical=calls.filter(call=>call.upstreamDispatched);
  let knownLowerUsd=0,knownUpperUsd=0,unknownPhysicalCalls=0,unknownCacheTokens=0;
  for(const call of physical){
    const price=call.apiEquivalent;
    if(!price||![price.lowerUsd,price.upperUsd].every(value=>typeof value==="number"&&Number.isFinite(value)&&value>=0)||price.upperUsd<price.lowerUsd){unknownPhysicalCalls++;continue;}
    knownLowerUsd+=price.lowerUsd;knownUpperUsd+=price.upperUsd;unknownCacheTokens+=price.unknownCacheTokens;
  }
  return{physicalRequests:physical.length,blockedAdmissions:calls.length-physical.length,knownLowerUsd,knownUpperUsd,unknownPhysicalCalls,unknownCacheTokens,
    aggregateApiEquivalent:unknownPhysicalCalls?null:{lowerUsd:knownLowerUsd,upperUsd:knownUpperUsd},actualAdditionalBilledUsd:null,finalInvoiceSupplied:false};
}
