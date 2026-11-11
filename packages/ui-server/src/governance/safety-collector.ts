/** Concrete turn-bound pre-delivery collector. All decisions remain restrictive. */
import type { BackendBridge } from "@schlessera/brain-ui-sdk/server";
import type { Database } from "bun:sqlite";
import { inputTaintSignals, outputTaintSignals, type IngestionSignal } from "../activity/ingestion-taint.js";
import { isMarkedUntrusted } from "../files/untrusted-marks.js";
import { occurrence } from "./occurrence.js";
import type { GovernanceWrites } from "./event-writes.js";
import { SafetyRecordingUnavailable } from "./safety-store.js";
import { safetyQueue } from "./safety-queue.js";

export function createSafetyCollector(db:Database,writes:GovernanceWrites,options:{turnId:string;bindingId:string;backendId:string;
 sessionId:()=>string|null;actor?:"interactive"|"voice";brainPath?:string;shellProxied:()=>boolean;signal:AbortSignal;onReady?:()=>void;stop?:(error:Error)=>void;policyHash?:string|null}):NonNullable<BackendBridge["inputSafety"]> {
 // `admitted`: every input signal of its latest begin() is recorded, and the
 // call owes its result. A result for a call whose begin() failed partway
 // cannot be recorded faithfully. `owed`: its obligation is durable (#3812).
 // `refused`: the backend refused a call with this id, so nothing more for
 // that id is admitted or let run.
 type Operation={tool:string;inputHashes:Set<string>;id:string;occurrences:string[];done:boolean;admitted:boolean;signals:IngestionSignal[];outputHash?:string;owed:boolean;refused:boolean};
 const operations=new Map<string,Operation>();
 // What the backend reported about each id: how many times the runtime asked
 // to admit a call under it, for each tool name it came under, and whether
 // the backend ever let one run. Kept in memory, apart from `operations` and
 // the obligation rows: an admission can be denied before any begin(), so
 // before any row exists (the reviewer's duplicate-id run), and only this
 // collector discharges this turn's obligations; a restart gaps every open
 // obligation whatever these say. Two tool names already make the id
 // unprovable, so a third is not kept.
 const calls=new Map<string,{tools:Map<string,number>;allowed:boolean}>();
 // A refusal can prove the call never ran only for an id admitted once,
 // under one tool name, and never allowed.
 const once=(call:{tools:Map<string,number>;allowed:boolean}|undefined)=>!!call&&!call.allowed&&call.tools.size===1&&[...call.tools.values()][0]===1;
 const operation=(tool:string):Operation=>({tool,inputHashes:new Set<string>(),id:crypto.randomUUID(),occurrences:[],done:false,admitted:false,signals:[],owed:false,refused:false});
 const base=()=>({turnId:options.turnId,sessionId:options.sessionId(),actor:options.actor??"interactive" as const,model:null,profile:null});
 const marked=(path:string)=>isMarkedUntrusted(db,path);
 const hash=(value:string)=>new Bun.CryptoHasher("sha256").update(value).digest("hex");
 const observed=(toolUseId:string,detector:Parameters<typeof occurrence>[1],operationId:string)=>{
  const item=occurrence(options.bindingId,detector,operationId,"open");
  if(/^[A-Za-z0-9_-]{1,128}$/.test(toolUseId))item.entry={kind:"tool",toolUseId};
  item.admission={trusted:false,policyHash:options.policyHash??null,trustRevision:"0"};
  return item;
 };
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
 // A recorded result discharges an obligation, and so does a denial that
 // proves the call never ran (`refused`). A discharge that cannot commit
 // leaves it, and so its chat's gap when the collection ends.
 const discharge=async(op:Operation)=>{
  if(!op.owed)return;
  try{await writes.safetyDischarge(options.turnId,op.id);op.owed=false;}catch{/* Still owed: the end gaps it. */}
 };
 const tails=new Map<string,Promise<void>>();let queued=0;
 // A result record under way, which the turn's end waits for (#3812).
 const recording=(work:Promise<void>):Promise<void>=>{
  const records=safetyQueue(db).recording;let mine=records.get(options.turnId);
  if(!mine)records.set(options.turnId,mine=new Set());
  const own=mine;own.add(work);
  void work.finally(()=>{own.delete(work);if(!own.size&&records.get(options.turnId)===own)records.delete(options.turnId);}).catch(()=>{});
  return work;
 };
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
  // Every call begin() admits owes its result's record from the moment its
  // obligation is durable (#3812). Its recorded result discharges it, and so
  // does the one refusal that proves it never ran (`refused`); a rejected
  // begin() does not by itself, since the backend's denial that follows it
  // is that refusal. A begin() rejected before its obligation is durable
  // owes nothing: the backend awaits it before running the tool, and runs
  // nothing on rejection. The obligation is the host's own record, so it
  // holds whatever the runtime delivers: cancellation, abort, a result hook
  // the runtime skips, or process death all leave the gap.
  begin(toolUseId,tool,input){return serial(toolUseId,async()=>{
   assertLive();
   // Refused: the runtime never runs it, and refusing again is no failure.
   if(operations.get(toolUseId)?.refused)throw new Error("Safety operation was refused; the call does not run");
   try{
    const inputHash=hash(JSON.stringify(input)),previous=operations.get(toolUseId);
    if(previous&&(previous.tool!==tool||previous.done))throw new Error("Safety operation identity already completed or changed tool");
    if(!previous&&operations.size>=2000)throw new Error("Safety tool operation capacity exceeded");
    const op=previous??operation(tool);
    if(!op.inputHashes.has(inputHash)&&op.inputHashes.size>=16)throw new Error("Safety input revision capacity exceeded");
    op.inputHashes.add(inputHash);op.admitted=false;operations.set(toolUseId,op);
    for(const signal of inputTaintSignals(tool,input,options.brainPath,marked,options.shellProxied())){
     if(op.signals.some(prior=>prior.detector===signal.detector&&prior.key===signal.key))continue;
     const item=observed(toolUseId,signal.detector,op.id);
     await writes.firstTaint({...base(),kind:"taint",payload:{source:signal.source,tool,detail:null,occurrence:item}},{beforeDelivery:true});
     op.occurrences.push(item.id);op.signals.push(signal);
    }
    if(!op.owed){await writes.safetyOblige(options.turnId,op.id,toolUseId,tool);op.owed=true;}
    op.admitted=true;
    assertLive();
   }catch(error){return fail(error,true);}
  });},
  // A result already exists when it reaches the host, and the runtime may keep
  // it in its session. So nothing between the tool running and its record
  // may skip both: a stopped turn still records it (stopping refuses new
  // tools, never a record; the turn's end waits for a record under way),
  // and any failure leaves its chat a permanent gap.
  result(toolUseId,tool,output,finalized,segments){return recording(serial(toolUseId,async()=>{
   try{
    if(segments&&segments.length>256)throw new Error("Safety result segment capacity exceeded");
    const op=operations.get(toolUseId);if(!op||op.tool!==tool||!op.admitted)throw new Error("Safety result has no admitted operation");
    const outputHash=hash(JSON.stringify([output,finalized,segments??null]));
    if(op.done){if(op.outputHash!==outputHash)throw new Error("Conflicting safety result delivery");return;}
    // Each separately delivered external result segment has its own exposure.
    for(const _segment of (segments??[]).slice(1))for(const signal of op.signals.filter(signal=>["compute_input","external_mcp_input","attachment_input","tool_web_input"].includes(signal.detector))){
      const item=observed(toolUseId,signal.detector,op.id);
      await writes.firstTaint({...base(),kind:"taint",payload:{source:signal.source,tool,detail:null,occurrence:item}});op.occurrences.push(item.id);
    }
    // Record output independently, before the backend releases it to the
    // model. Its bytes already exist, so a refusal here is never "before delivery".
    for(const signal of outputTaintSignals(tool,output,options.brainPath,marked)){
      const item=observed(toolUseId,signal.detector,op.id);
      await writes.firstTaint({...base(),kind:"taint",payload:{source:signal.source,tool,detail:null,occurrence:item}});op.occurrences.push(item.id);
    }
    const state=finalized&&!['Bash','bash'].includes(tool)?"finalized":"interrupted_unknown";
    // The last exposure commits with the call's discharge, in one
    // transaction: no end and no restart can find the record durable and
    // the call still owed between them, and gap a recorded result.
    for(const [index,id] of op.occurrences.entries()){
     const last=index===op.occurrences.length-1&&op.owed;
     const stored=await writes.record({...base(),kind:"taint_exposure",dedupeKey:id,payload:{occurrenceId:id,state}},last?{discharge:op.id}:undefined);
     if(last&&stored.discharged)op.owed=false;
    }
    op.done=true;op.outputHash=outputHash;
    // A result with nothing to record is recorded by its discharge alone. A
    // discharge that cannot commit stays owed, which only gaps the chat; it
    // is no loss of this record.
    await discharge(op);
   }catch(error){return fail(error);}
  },true));},
  // The runtime asks to admit one call under this id, for this tool. Counted
  // at once, not queued: a refusal already queued for the id then sees the
  // new admission and proves nothing. An id the collector cannot track keeps
  // no count, so no refusal discharges it.
  admitting(toolUseId,toolName=""){
   let call=calls.get(toolUseId);
   if(!call){if(calls.size>=2000)return;calls.set(toolUseId,call={tools:new Map(),allowed:false});}
   if(call.tools.has(toolName)||call.tools.size<2)call.tools.set(toolName,(call.tools.get(toolName)??0)+1);
  },
  // The backend refused a call with this id; a later begin() or allow for the
  // id is refused too, so a parallel hook or request cannot reopen it. The
  // refusal proves the call never ran, and discharges its obligation, only
  // when it is the backend's own denial (`denied`: a Claude permission
  // callback or PreToolUse hook deny, a Pi permission deny or gate block), of
  // the only admission ever made under the id, under its only tool name, and
  // the backend never let a call under it run. Anything else proves nothing
  // and leaves the obligation to its recorded result: a second admission of
  // the id, under the same tool or another (the Claude runtime admits two
  // calls under one id), an allow followed by a refusal, a rejected request
  // (a stopped turn, a replay). Never rejects.
  refused(toolUseId,denied=false){return serial(toolUseId,async()=>{
   const op=operations.get(toolUseId);
   const proves=denied&&once(calls.get(toolUseId));
   if(!op){if(operations.size<2000)operations.set(toolUseId,{...operation(""),refused:true});return;}
   op.refused=true;
   if(proves&&!op.done)await discharge(op);
  },true).catch(()=>{});},
  // The backend's last check before it lets this call run, noted so that no
  // later refusal under the id proves the call never ran. A call whose id
  // was refused, or whose latest begin() did not complete, must not run: the
  // backend refuses it instead, and hands out nothing the call could use
  // until this resolves.
  allowed(toolUseId){return serial(toolUseId,async()=>{
   const op=operations.get(toolUseId);
   if(op&&(op.refused||!op.admitted))throw new Error("Safety operation was refused or not admitted; the call does not run");
   const call=calls.get(toolUseId);
   if(call)call.allowed=true;
   else if(calls.size<2000)calls.set(toolUseId,{tools:new Map(),allowed:true});
   else throw new Error("Safety allowance capacity exceeded; the call does not run");
  },true);},
  // A result the backend could not hand over (a refused or malformed report):
  // its chat keeps a permanent gap. Resolves once that gap is durable.
  async lost(toolUseId,tool,cause){
   const loss=new Error(`Safety result for ${tool} (${toolUseId}) was not recorded: ${cause instanceof Error?cause.message:String(cause)}`);
   try{await fail(loss);}catch(error){if(error!==loss)throw error;}
  },
 };
}
