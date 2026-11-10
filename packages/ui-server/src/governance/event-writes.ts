/**
 * Governance event writes off the event loop (#2850). The hosted server's
 * app connection never commits a governance event itself: each one is
 * validated where it is raised, then committed on the `ui.db` write worker at
 * `synchronous=FULL`, in submission order with the journal's and Activity's
 * writes. An event the journal records inside its own transaction stays
 * there (`brain/journal-store.ts`).
 */
import { retainSafetyLoss, safetyQueue, notifySafetyChanged } from "./safety-queue.js";
import { prepareSafetyReview, commitSafetyReview, type SafetyReviewBody, type SafetyReviewer, type SafetyReviewReceipt } from "./safety-reviews.js";
import { beginSafetyCollection, acknowledgeSafety, endSafetyCollection, safetyProjection, reserveSafetyWrite, releaseSafetyWrite,
  ensureSafetyEventCollection, recordSafetyFailure, recoverSafetyRecording, migrateSafetyHistory, logSafetyRecording, safetyRecordingStatus,
  SafetyCapacityExhausted, SafetyRecordingUnavailable, SafetyUnavailable, safetyScopeTurns, type SafetyCollectionInput, type SafetyProjection,
  type SafetyFailureSite, type SafetyRecovery, type SafetyRecordingStatus } from "./safety-store.js";
import { Database } from "bun:sqlite";
import {assertLive,ChatRetiredError} from "../ws/chat-lifecycle.js";

import { procedureCaller, type SqliteWriter, type WriteProcedures } from "../db/write-worker.js";
import { replaySteeringEvents } from "../brain/journal-governance.js";
import { bindTurnEvents, governanceEventRow, insertGovernanceEvent, type GovernanceEventInput, type GovernanceEventRow } from "./events.js";
import { recordTurnRoadblocks, type RoadblockAttribution, type TurnTrace } from "./roadblocks.js";
import { sessionTaint, type SessionTaint } from "./session-taint.js";

export const url = import.meta.url;

/** Worker side: every procedure is one of the synchronous writers, run on the write connection. */
export function setup(db: Database): WriteProcedures {
  const retired=(turnId:string)=>!!db.query("SELECT 1 FROM safety_retired_turns WHERE turn_id=?").get(turnId);
  // Writes the failure at the narrowest scope that takes it and tells the app
  // side which one did, on the error itself: `chat`, `brain`, or `unrecorded`.
  const contain=(error:unknown,turnId:string|null,site:SafetyFailureSite,sessionId:string|null=null)=>{
    let scope:string;
    try{scope=recordSafetyFailure(db,turnId,error,site,sessionId);}catch{scope="unrecorded";}
    if(error instanceof Error)try{Object.defineProperty(error,"safetyScope",{value:scope,enumerable:true,configurable:true});}catch{/* frozen: treated as unrecorded */}
  };
  return {
    safetyPrepareReview: (body:SafetyReviewBody,actor:SafetyReviewer) => prepareSafetyReview(db,body,actor),
    safetyCommitReview: (id:string,body:SafetyReviewBody,actor:SafetyReviewer,pending:boolean,failed:boolean=false) => commitSafetyReview(db,id,body,actor,pending,failed),
    record: (row: GovernanceEventRow) => {
      try { return insertGovernanceEvent(db,row); } catch(error) { if(!(error instanceof ChatRetiredError)&&(row.kind==="taint"||row.kind==="taint_exposure"))contain(error,row.turnId,"record",row.sessionId); throw error; }
    },
    // A failed begin is before any delivery: it refuses that turn alone and
    // latches nothing (#3812). The app side names the retryable refusal.
    safetyBegin: (input:SafetyCollectionInput) => beginSafetyCollection(db,input),
    safetyReady: (turnId:string,backendId:string,version:number) => acknowledgeSafety(db,turnId,backendId,version),
    safetyEnd: (turnId:string,loss=false) => {
      // Never seal an apparently complete epoch if its loss notice rolled
      // back. A failed retry leaves it open for restart classification.
      if(loss&&!retired(turnId))recordSafetyFailure(db,turnId,new SafetyUnavailable("Safety evidence was lost before its collection ended"),"safetyEnd");
      endSafetyCollection(db,turnId);
    },
    safetyFail: (turnId:string|null,cause?:{name:string;message:string;stack?:string}) => {
      if(turnId&&retired(turnId))return null;
      const error=cause?Object.assign(new Error(cause.message),{name:cause.name,stack:cause.stack}):new SafetyUnavailable("A safety producer failed; its evidence may be lost");
      return recordSafetyFailure(db,turnId,error,"safetyFail");
    },
    // A reservation precedes its event. When the producer holds its input
    // until the event commits, a refused reservation delivered nothing.
    safetyReserve: (row:GovernanceEventRow,id:string,bytes:number,beforeDelivery=false) => {
      try {const turnId=ensureSafetyEventCollection(db,row);reserveSafetyWrite(db,turnId,id,bytes,row.kind==="taint_exposure"?JSON.parse(row.payload).occurrenceId:undefined);}
      catch(error){if(!(error instanceof ChatRetiredError)&&!beforeDelivery)contain(error,row.turnId,"safetyReserve",row.sessionId);throw error;}
    },
    safetyCommit: (row:GovernanceEventRow,id:string) => {
      try{return db.transaction(()=>{assertLive(db,[["session",row.sessionId]]);if(row.turnId&&db.query("SELECT 1 FROM safety_retired_turns WHERE turn_id=?").get(row.turnId))throw new ChatRetiredError();if(!db.query("SELECT 1 FROM safety_pending WHERE id=?").get(id))throw new SafetyUnavailable("Safety reservation absent");releaseSafetyWrite(db,id);return insertGovernanceEvent(db,row,true);}).immediate();}
      catch(error){if(!(error instanceof ChatRetiredError))contain(error,row.turnId,"safetyCommit",row.sessionId);throw error;}
    },
    bind: (turnId: string, sessionId: string) => bindTurnEvents(db, turnId, sessionId),
    // Classification reads the turn's earlier events on the same connection,
    // after every event submitted before it has committed.
    roadblocks: (attribution: RoadblockAttribution, trace: TurnTrace) => recordTurnRoadblocks(db, attribution, trace),
    replaySteering: () => replaySteeringEvents(db),
  };
}

export interface GovernanceWrites {
  /** Host-only persistence; callers must establish live owner authority. No route or capability is enabled here. */
  safetyPrepareReview(body:SafetyReviewBody,actor:SafetyReviewer):Promise<SafetyReviewReceipt>;
  safetyCommitReview(id:string,body:SafetyReviewBody,actor:SafetyReviewer):Promise<SafetyReviewReceipt>;
  /** Refuses with `SafetyRecordingUnavailable` when the collection cannot commit; nothing is latched. */
  safetyBegin(input:SafetyCollectionInput):Promise<string>;
  safetyReady(turnId:string,backendId:string,version:number):Promise<void>;
  safetyEnd(turnId:string):Promise<void>;
  /** Marks the turn's chat failed (`cause` is error text only); the brain only when that cannot commit. */
  safetyFail(turnId:string,cause?:unknown):Promise<void>;
  safety(turnId:string|null,sessionId:string|null):SafetyProjection;
  /** Input recording must be settled and healthy before any provider delivery. */
  recordingAvailable(turnId:string|null,sessionId:string|null):boolean;
  /**
   * Validates now, throwing `GovernanceEventError` as the synchronous writer
   * did; the returned promise settles once the row commits, or with the
   * database failure.
   */
  record(input: GovernanceEventInput): Promise<{ id: number; recorded: boolean }>;
  /** Stores every distinct occurrence; only the exact host key deduplicates. Historical internal method name. */
  /** `beforeDelivery`: the producer holds the input until this settles, so a
   * refused reservation delivered nothing and refuses only the turn. */
  firstTaint(input: GovernanceEventInput<"taint">, options?: { beforeDelivery?: boolean }): Promise<boolean>;
  /** The brain-wide recorder state the owner sees on `/api/status` (#3810). */
  recordingStatus(): SafetyRecordingStatus;
  /** Owner fallback for automatic recovery, with the strict quiescence precondition. */
  recoverRecording(actor:string): SafetyRecovery;
  /**
   * The session's first taint (G6) as admission must see it: the committed
   * one, else one submitted and not yet committed. A pending taint has no row
   * id yet (`eventId` 0). Only committed individual verdicts can resolve
   * retained evidence; failed recording remains restrictive.
   */
  taint(turnId: string | null, sessionId: string | null): SessionTaint | null;
  /** Attaches a turn's session-less events to its session once its catalog row exists. */
  bind(turnId: string, sessionId: string): Promise<number>;
  /** Classifies a finished turn against its committed events and stores its roadblocks. */
  roadblocks(attribution: RoadblockAttribution, trace: TurnTrace): Promise<number>;
  /** Records any `steering_change` event a journal steering change lacks (#2789). */
  replaySteering(): Promise<number>;
}

/** The app side: every write commits on `writer` when there is one, else on `db` at once. */
export function createGovernanceWrites(db: Database, writer?: SqliteWriter): GovernanceWrites {
  const invoke = procedureCaller(db, { url, setup }, undefined, writer);
  const shared=safetyQueue(db),pendingTaints=shared.pending;
  const snapshot=<T>(read:()=>T):T=>db.inTransaction?read():Database.prototype.transaction.call(db,read).deferred() as T;
  const pendingInScope=(turnId:string|null,sessionId:string|null)=>{
    if(!pendingTaints.size)return [];
    const turns=safetyScopeTurns(db,turnId,sessionId);
    return [...pendingTaints].filter(p=>(p.turnId!==null&&turns.has(p.turnId))||(sessionId!==null&&p.sessionId===sessionId));
  };
  // Retained in-process loss restricts only the chats it belongs to.
  const lostInScope=(turnId:string|null,sessionId:string|null)=>{
    if(!shared.lostTurns.size)return false;
    if(turnId!==null&&shared.lostTurns.has(turnId))return true;
    for(const turn of safetyScopeTurns(db,turnId,sessionId))if(shared.lostTurns.has(turn))return true;
    return false;
  };
  const brainFailed=()=>shared.failed||!!(db.query("SELECT failed FROM safety_meta WHERE singleton=1").get() as {failed:number}|null)?.failed;
  // A turn begun restricted carries a permanent gap before any delivery:
  // nothing it loses can make its chat look complete, so it keeps running.
  const covered=(turnId:string|null)=>turnId!==null&&!!db.query("SELECT 1 FROM safety_collections WHERE turn_id=? AND restricted_begin=1").get(turnId);
  const retired=(turnId:string)=>!!db.query("SELECT 1 FROM safety_retired_turns WHERE turn_id=?").get(turnId);
  // Any worker write can latch the brain (a failed end, a commit, a peer):
  // whichever does, recovery is scheduled from here.
  const watchLatch=()=>{try{if(!shared.recovery.timer&&brainFailed())scheduleSafetyRecovery(db);}catch{/* A closed or broken store schedules nothing. */}};
  const call:typeof invoke=<T>(name:string,...args:unknown[])=>{
    shared.inflight++;
    return invoke<T>(name,...args).finally(()=>{shared.inflight--;watchLatch();notifySafetyChanged(db);});
  };
  const retainedForBrain=(turnId:string|null,notice:unknown,cause?:unknown)=>{
    const original=cause??notice;
    shared.lossCause=shared.lossCause?{...shared.lossCause,count:shared.lossCause.count+1}:{errorClass:original instanceof Error?(original.constructor?.name&&original.constructor.name!=="Error"?original.constructor.name:original.name):"Error",
      message:(original instanceof Error?original.message:String(original)).slice(0,512),site:"retained",turnId,at:Date.now(),count:1};
    retainSafetyLoss(db,turnId,true);scheduleSafetyRecovery(db);
    logSafetyRecording("safety recording retained in process for the brain",{"safety.scope":"brain","safety.reason":"recording_failed",
      "safety.site":"retained","safety.turn_id":turnId,"error.message":notice instanceof Error?notice.message:String(notice)});
  };
  const safetyFail=(turnId:string|null,cause?:unknown):Promise<void>=>{
    const counted=!turnId||!retired(turnId);
    // A turn with no collection has no chat to carry the fact: the brain does.
    if(counted)retainSafetyLoss(db,turnId,turnId!==null&&!db.query("SELECT 1 FROM safety_collections WHERE turn_id=?").get(turnId));
    const wire=cause instanceof Error?{name:cause.constructor?.name&&cause.constructor.name!=="Error"?cause.constructor.name:cause.name,message:cause.message,stack:cause.stack}
      :cause===undefined?undefined:{name:"Error",message:String(cause)};
    return call<"chat"|"brain"|null>("safetyFail",turnId,wire).then(scope=>{
      // The chat now carries the durable fact; its in-process copy is redundant.
      if(scope==="chat"&&turnId)shared.lostTurns.delete(turnId);
      if(scope==="brain")scheduleSafetyRecovery(db);
      notifySafetyChanged(db);
    },notice=>{
      // Neither the chat nor the brain fact committed: the store cannot take
      // a write. Restrict the brain in-process until recovery commits one.
      if(counted)retainedForBrain(turnId,notice,cause);
      throw notice;
    });
  };
  const contained=(error:unknown,turnId:string|null)=>{
    const scope=(error as {safetyScope?:string}|null)?.safetyScope;
    if(scope==="chat")return;
    if(scope==="brain"){scheduleSafetyRecovery(db);return;}
    retainedForBrain(turnId,error);
  };
  const record = (input: GovernanceEventInput, options: { beforeDelivery?: boolean } = {}): Promise<{ id: number; recorded: boolean }> => {
    const row = governanceEventRow(input);
    if (input.kind !== "taint" && input.kind !== "taint_exposure") return call("record", row);
    const restricted=covered(row.turnId);
    // A stopped producer stays stopped: its chat, or the brain, holds the failure.
    if (!restricted&&input.kind!=="taint_exposure"&&(brainFailed()||(row.turnId!==null&&(shared.lostTurns.has(row.turnId)
      ||!!db.query("SELECT 1 FROM safety_collections WHERE turn_id=? AND failure IS NOT NULL AND ended=0").get(row.turnId))))) {
      // A producer that holds its input delivered nothing. Any other may
      // already have: its chat keeps the loss before this refusal returns.
      if (options.beforeDelivery) throw new SafetyRecordingUnavailable(brainFailed());
      const refused = new Error("Safety occurrence writer requires recovery");
      void safetyFail(row.turnId, refused).catch(() => {});
      throw refused;
    }
    const bytes = Buffer.byteLength(JSON.stringify(row))+1024;
    const session = snapshot(()=>row.turnId===null&&row.sessionId===null
      ? [...pendingTaints].filter(p=>p.turnId===null&&p.sessionId===null) : pendingInScope(row.turnId,row.sessionId));
    if (pendingTaints.size >= 4096 || shared.bytes + bytes > 16777216 || session.length >= 256
      || session.reduce((sum, p) => sum + p.bytes, 0) + bytes > 1048576) {
      void safetyFail(row.turnId,new SafetyCapacityExhausted("Safety occurrence write capacity exceeded")).catch(()=>{});
      throw new Error("Safety occurrence write capacity exceeded; ingestion must stop");
    }
    const pending = { turnId: row.turnId, sessionId: row.sessionId, source: input.kind==="taint"?(input as GovernanceEventInput<"taint">).payload.source:"legacy_unknown" as const, bytes };
    pendingTaints.add(pending); shared.bytes += bytes;
    notifySafetyChanged(db);
    const reservation=crypto.randomUUID();let reserved=false;
    const stored = call<void>("safetyReserve",row,reservation,bytes,!!options.beforeDelivery)
      .then(()=>{reserved=true;return call<{id:number;recorded:boolean}>("safetyCommit",row,reservation);});
    return stored.catch(error => {
      if((error as {code?:string})?.code==="chat_retired")throw error;
      // Already permanently gapped before delivery: this loss changes nothing.
      if(restricted){logSafetyRecording("safety evidence not recorded for a restricted turn",{"safety.scope":"turn","safety.turn_id":row.turnId,
        "error.message":error instanceof Error?error.message:String(error)});return {id:0,recorded:false};}
      if(!reserved&&options.beforeDelivery)throw new SafetyRecordingUnavailable(brainFailed(),error);
      contained(error,row.turnId);
      throw error;
    }).finally(() => { pendingTaints.delete(pending); shared.bytes -= bytes; notifySafetyChanged(db); });
  };
  watchLatch();
  return {
    record,
    safetyPrepareReview: (body,actor)=>call("safetyPrepareReview",body,actor),
    safetyCommitReview(id,body,actor){
      let pending=true;
      try {pending=snapshot(()=>pendingInScope(null,body.session.sessionId).length>0||lostInScope(null,body.session.sessionId));}
      catch(error){if(!(error instanceof ChatRetiredError))throw error;}
      // Retirement is an explicit worker-side receipt, including on retry.
      return call("safetyCommitReview",id,body,actor,pending,shared.failed);
    },
    async safetyBegin(input){
      const paused=brainFailed();
      try{return await call<string>("safetyBegin",{...input,restricted:paused});}
      catch(error){
        if((error as {code?:string})?.code==="chat_retired")throw error;
        // Before any delivery: refuse this turn alone, retryable, latch nothing.
        const refusal=new SafetyRecordingUnavailable(paused||brainFailed(),error);
        logSafetyRecording("safety recording refused one turn before delivery",{"safety.scope":"turn","safety.site":"safetyBegin","safety.turn_id":input.turnId,
          "safety.paused":refusal.paused?1:0,"error.class":error instanceof Error?error.constructor?.name??error.name:"Error","error.message":error instanceof Error?error.message:String(error)});
        throw refusal;
      }
    },
    safetyReady: (turnId,backendId,version)=>call("safetyReady",turnId,backendId,version),
    safetyEnd: turnId=>call("safetyEnd",turnId,shared.unscopedLoss||shared.lostTurns.has(turnId)),
    safetyFail,
    safety: (turnId,sessionId)=>snapshot(()=>{
      const projection=safetyProjection(db,turnId,sessionId);
      const local=pendingInScope(turnId,sessionId).length,lost=shared.failed||lostInScope(turnId,sessionId);
      if(local||lost){projection.restriction="restricted";projection.pendingCount=Math.max(local,projection.pendingCount);
        if(local&&!projection.reasons.includes("recording_pending"))projection.reasons.push("recording_pending");
        if(lost){projection.coverage.state="incomplete";if(!projection.reasons.includes("recording_failed"))projection.reasons.push("recording_failed");}}
      return projection;
    }),
    recordingAvailable(turnId,sessionId){
      return snapshot(()=>{
        if(covered(turnId))return true;
        if(shared.failed||lostInScope(turnId,sessionId)||pendingInScope(turnId,sessionId).length)return false;
        const state=safetyProjection(db,turnId,sessionId);
        return !state.reasons.some(reason=>["recording_failed","recording_pending","capacity"].includes(reason));
      });
    },
    firstTaint: (input, options) => record(input, options).then(result => result.recorded),
    taint(turnId, sessionId) {
      return snapshot(()=>{
        if (shared.failed||lostInScope(turnId,sessionId)) return { eventId: 0, source: "legacy_unknown" };
        const committed = sessionTaint(db, turnId, sessionId);
        if (committed && committed.eventId>0) return committed;
        const pending=pendingInScope(turnId,sessionId)[0];
        if(pending)return {eventId:0,source:pending.source};
        return committed;
      });
    },
    bind: async (turnId, sessionId) => {
      const bound = await call<number>("bind", turnId, sessionId);
      for (const pending of pendingTaints) if (pending.turnId === turnId) pending.sessionId = sessionId;
      return bound;
    },
    roadblocks: (attribution, trace) => call<number>("roadblocks", attribution, trace),
    replaySteering: () => call<number>("replaySteering"),
    recordingStatus: () => safetyRecordingStatus(db),
    recoverRecording(actor){
      const result=recoverSafetyRecording(db,{trigger:"owner",actor});
      notifySafetyChanged(db);return result;
    },
  };
}

/**
 * Automatic recovery of the brain-wide recorder (#3812). Needs no judgment:
 * it commits the permanent gaps and clears the latch, so it keeps trying,
 * backing off to once a minute, and never stops at a retry count.
 */
export function scheduleSafetyRecovery(db:Database):void {
  const queue=safetyQueue(db),state=queue.recovery;
  if(state.timer)return;
  const delay=Math.min(60000,250*2**Math.min(state.attempt,8));
  state.timer=setTimeout(()=>{
    state.timer=null;
    if(!attemptSafetyRecovery(db)){state.attempt++;scheduleSafetyRecovery(db);}
    else state.attempt=0;
  },delay);
  (state.timer as {unref?:()=>void}).unref?.();
}
/** One automatic attempt. True once nothing brain-wide remains to recover. */
export function attemptSafetyRecovery(db:Database):boolean {
  const queue=safetyQueue(db);
  try{
    const failed=queue.failed||!!(db.query("SELECT failed FROM safety_meta WHERE singleton=1").get() as {failed:number}|null)?.failed;
    if(!failed)return true;
    // A legacy row without its record or its gap must not be cleared over.
    if(!migrateSafetyHistory(db))return false;
    recoverSafetyRecording(db,{trigger:"automatic",actor:"host"});
    notifySafetyChanged(db);
    return true;
  }catch(error){
    // A closed database ends this host's attempts; anything else is retried.
    return error instanceof Error&&/closed database|Cannot use a closed/i.test(error.message);
  }
}
