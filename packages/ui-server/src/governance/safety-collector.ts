/** Concrete turn-bound pre-delivery collector. All decisions remain restrictive. */
import type { BackendBridge } from "@schlessera/brain-ui-sdk/server";
import type { Database } from "bun:sqlite";
import { inputTaintSignals, outputTaintSignals, type IngestionSignal } from "../activity/ingestion-taint.js";
import { isMarkedUntrusted } from "../files/untrusted-marks.js";
import { occurrence } from "./occurrence.js";
import type { GovernanceWrites } from "./event-writes.js";
import { SafetyRecordingUnavailable } from "./safety-store.js";

export function createSafetyCollector(db:Database,writes:GovernanceWrites,options:{turnId:string;bindingId:string;backendId:string;
 sessionId:()=>string|null;actor?:"interactive"|"voice";brainPath?:string;shellProxied:()=>boolean;signal:AbortSignal;onReady?:()=>void;stop?:(error:Error)=>void;policyHash?:string|null}):NonNullable<BackendBridge["inputSafety"]> {
 // `admitted`: every input signal of its latest begin() is recorded. A result
 // for a call whose begin() failed partway cannot be recorded faithfully.
 const operations=new Map<string,{tool:string;inputHashes:Set<string>;id:string;occurrences:string[];done:boolean;admitted:boolean;signals:IngestionSignal[];outputHash?:string}>();
 const base=()=>({turnId:options.turnId,sessionId:options.sessionId(),actor:options.actor??"interactive" as const,model:null,profile:null});
 const marked=(path:string)=>isMarkedUntrusted(db,path);
 const hash=(value:string)=>new Bun.CryptoHasher("sha256").update(value).digest("hex");
 const assertLive=()=>{if(options.signal.aborted)throw new Error("Safety input collection cancelled");};
 // `held`: the failure came from begin(), which the backend awaits before it
 // runs the tool. A refused reservation there, with a producer that did stop,
 // delivered nothing: only this turn is refused, its chat keeps no gap (#3812).
 // A result already exists when result() records it, and the runtime may keep
 // it in its own session (the Claude runtime replays it on resume), so every
 // failure there is a loss after delivery and the chat keeps a permanent gap.
 const fail=async(error:unknown,held=false)=>{
  const failures=[error];
  try{options.stop?.(error instanceof Error?error:new Error(String(error)));}catch(stop){failures.push(stop);}
  if(held&&failures.length===1&&error instanceof SafetyRecordingUnavailable&&error.beforeDelivery)throw error;
  try{await writes.safetyFail(options.turnId,error);}
  catch(notice){throw new AggregateError([...failures,notice],`Safety input refused: ${String(error)}; failure notice could not commit`);}
  if(failures.length>1)throw new AggregateError(failures,`Safety input refused: ${String(error)}`);
  throw error;
 };
 const tails=new Map<string,Promise<void>>();let queued=0;
 const serial=(id:string,work:()=>Promise<void>,afterFailure=false):Promise<void>=>{
  if(queued>=256)return fail(new Error("Safety collection queue capacity exceeded"));
  queued++;
  // A result runs even after its call's begin() failed: that refusal must not
  // become the result's, which would skip both its record and its gap.
  const prior=tails.get(id)??Promise.resolve();
  const result=(afterFailure?prior.catch(()=>{}):prior).then(work);tails.set(id,result);
  void result.finally(()=>{queued--;if(tails.get(id)===result)tails.delete(id);}).catch(()=>{});
  return result;
 };
 return {
  async ready(backend,version){assertLive();await writes.safetyReady(options.turnId,backend,version);options.onReady?.();},
  async unavailable(){return fail(new Error("Input collection is not qualified for this runtime configuration"));},
  begin(toolUseId,tool,input){return serial(toolUseId,async()=>{
   assertLive();
   try{
    const inputHash=hash(JSON.stringify(input)),previous=operations.get(toolUseId);
    if(previous&&(previous.tool!==tool||previous.done))throw new Error("Safety operation identity already completed or changed tool");
    if(!previous&&operations.size>=2000)throw new Error("Safety tool operation capacity exceeded");
    const op=previous??{tool,inputHashes:new Set<string>(),id:crypto.randomUUID(),occurrences:[] as string[],done:false,admitted:false,signals:[] as IngestionSignal[]};
    if(!op.inputHashes.has(inputHash)&&op.inputHashes.size>=16)throw new Error("Safety input revision capacity exceeded");
    op.inputHashes.add(inputHash);op.admitted=false;operations.set(toolUseId,op);
    for(const signal of inputTaintSignals(tool,input,options.brainPath,marked,options.shellProxied())){
     if(op.signals.some(prior=>prior.detector===signal.detector&&prior.key===signal.key))continue;
     const item=occurrence(options.bindingId,signal.detector,op.id,"open");item.admission={trusted:false,policyHash:options.policyHash??null,trustRevision:"0"};
     await writes.firstTaint({...base(),kind:"taint",payload:{source:signal.source,tool,detail:null,occurrence:item}},{beforeDelivery:true});
     op.occurrences.push(item.id);op.signals.push(signal);
    }
    op.admitted=true;
    assertLive();
   }catch(error){return fail(error,true);}
  });},
  // A result already exists when it reaches the host, and the runtime may keep
  // it in its session. So nothing between the tool running and its record
  // may skip both: a stopped turn still records it (stopping refuses new
  // tools, never a record), and any failure leaves its chat a permanent gap.
  result(toolUseId,tool,output,finalized,segments){return serial(toolUseId,async()=>{
   try{
    if(segments&&segments.length>256)throw new Error("Safety result segment capacity exceeded");
    const op=operations.get(toolUseId);if(!op||op.tool!==tool||!op.admitted)throw new Error("Safety result has no admitted operation");
    const outputHash=hash(JSON.stringify([output,finalized,segments??null]));
    if(op.done){if(op.outputHash!==outputHash)throw new Error("Conflicting safety result delivery");return;}
    // Each separately delivered external result segment has its own exposure.
    for(const _segment of (segments??[]).slice(1))for(const signal of op.signals.filter(signal=>["compute_input","external_mcp_input","attachment_input","tool_web_input"].includes(signal.detector))){
      const item=occurrence(options.bindingId,signal.detector,op.id,"open");item.admission={trusted:false,policyHash:options.policyHash??null,trustRevision:"0"};
      await writes.firstTaint({...base(),kind:"taint",payload:{source:signal.source,tool,detail:null,occurrence:item}});op.occurrences.push(item.id);
    }
    // Record output independently, before the backend releases it to the
    // model. Its bytes already exist, so a refusal here is never "before delivery".
    for(const signal of outputTaintSignals(tool,output,options.brainPath,marked)){
      const item=occurrence(options.bindingId,signal.detector,op.id,"open");item.admission={trusted:false,policyHash:options.policyHash??null,trustRevision:"0"};
      await writes.firstTaint({...base(),kind:"taint",payload:{source:signal.source,tool,detail:null,occurrence:item}});op.occurrences.push(item.id);
    }
    const state=finalized&&!['Bash','bash'].includes(tool)?"finalized":"interrupted_unknown";
    for(const id of op.occurrences)await writes.record({...base(),kind:"taint_exposure",dedupeKey:id,payload:{occurrenceId:id,state}});
    op.done=true;op.outputHash=outputHash;
   }catch(error){return fail(error);}
  },true);},
  // A result the backend could not hand over (a refused or malformed report):
  // its chat keeps a permanent gap. Resolves once that gap is durable.
  async lost(toolUseId,tool,cause){
   const loss=new Error(`Safety result for ${tool} (${toolUseId}) was not recorded: ${cause instanceof Error?cause.message:String(cause)}`);
   try{await fail(loss);}catch(error){if(error!==loss)throw error;}
  },
 };
}
