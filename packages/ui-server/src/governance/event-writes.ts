/**
 * Governance event writes off the event loop (#2850). The hosted server's
 * app connection never commits a governance event itself: each one is
 * validated where it is raised, then committed on the `ui.db` write worker at
 * `synchronous=FULL`, in submission order with the journal's and Activity's
 * writes. An event the journal records inside its own transaction stays
 * there (`brain/journal-store.ts`).
 */
import { retainSafetyLoss, safetyQueue } from "./safety-queue.js";
import { beginSafetyCollection, acknowledgeSafety, endSafetyCollection, safetyProjection, reserveSafetyWrite, releaseSafetyWrite,
  ensureSafetyEventCollection, latchSafety, SafetyUnavailable, type SafetyCollectionInput, type SafetyProjection } from "./safety-store.js";
import type { Database } from "bun:sqlite";
import {assertLive,ChatRetiredError} from "../ws/chat-lifecycle.js";

import { procedureCaller, type SqliteWriter, type WriteProcedures } from "../db/write-worker.js";
import { replaySteeringEvents } from "../brain/journal-governance.js";
import { bindTurnEvents, governanceEventRow, insertGovernanceEvent, type GovernanceEventInput, type GovernanceEventRow } from "./events.js";
import { recordTurnRoadblocks, type RoadblockAttribution, type TurnTrace } from "./roadblocks.js";
import { sessionTaint, type SessionTaint } from "./session-taint.js";

export const url = import.meta.url;

/** Worker side: every procedure is one of the synchronous writers, run on the write connection. */
export function setup(db: Database): WriteProcedures {
  return {
    record: (row: GovernanceEventRow) => {
      try { return insertGovernanceEvent(db,row); } catch(error) { if(!(error instanceof ChatRetiredError)&&(row.kind==="taint"||row.kind==="taint_exposure"))latchSafety(db,row.turnId,error instanceof SafetyUnavailable?"capacity":"recording_failed"); throw error; }
    },
    safetyBegin: (input:SafetyCollectionInput) => { try{return beginSafetyCollection(db,input);}catch(error){if(!(error instanceof ChatRetiredError))latchSafety(db,input.turnId,"capacity");throw error;} },
    safetyReady: (turnId:string,backendId:string,version:number) => acknowledgeSafety(db,turnId,backendId,version),
    safetyEnd: (turnId:string,loss=false) => {
      // Never seal an apparently complete epoch if its loss notice rolled
      // back. A failed retry leaves it open for restart classification.
      if(loss&&!db.query("SELECT 1 FROM safety_retired_turns WHERE turn_id=?").get(turnId))latchSafety(db,turnId,"recording_failed");
      endSafetyCollection(db,turnId);
    },
    safetyFail: (turnId:string|null) => {if(!turnId||!db.query("SELECT 1 FROM safety_retired_turns WHERE turn_id=?").get(turnId))latchSafety(db,turnId,"recording_failed");},
    safetyReserve: (row:GovernanceEventRow,id:string,bytes:number) => {
      try {const turnId=ensureSafetyEventCollection(db,row);reserveSafetyWrite(db,turnId,id,bytes,row.kind==="taint_exposure"?JSON.parse(row.payload).occurrenceId:undefined);}
      catch(error){if(!(error instanceof ChatRetiredError))latchSafety(db,row.turnId,"capacity");throw error;}
    },
    safetyCommit: (row:GovernanceEventRow,id:string) => {
      try{return db.transaction(()=>{assertLive(db,[["session",row.sessionId]]);if(row.turnId&&db.query("SELECT 1 FROM safety_retired_turns WHERE turn_id=?").get(row.turnId))throw new ChatRetiredError();if(!db.query("SELECT 1 FROM safety_pending WHERE id=?").get(id))throw new SafetyUnavailable("Safety reservation absent");releaseSafetyWrite(db,id);return insertGovernanceEvent(db,row,true);}).immediate();}
      catch(error){if(!(error instanceof ChatRetiredError))latchSafety(db,row.turnId,error instanceof SafetyUnavailable?"capacity":"recording_failed");throw error;}
    },
    bind: (turnId: string, sessionId: string) => bindTurnEvents(db, turnId, sessionId),
    // Classification reads the turn's earlier events on the same connection,
    // after every event submitted before it has committed.
    roadblocks: (attribution: RoadblockAttribution, trace: TurnTrace) => recordTurnRoadblocks(db, attribution, trace),
    replaySteering: () => replaySteeringEvents(db),
  };
}

export interface GovernanceWrites {
  safetyBegin(input:SafetyCollectionInput):Promise<string>;
  safetyReady(turnId:string,backendId:string,version:number):Promise<void>;
  safetyEnd(turnId:string):Promise<void>;
  safetyFail(turnId:string):Promise<void>;
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
  firstTaint(input: GovernanceEventInput<"taint">): Promise<boolean>;
  /**
   * The session's first taint (G6) as admission must see it: the committed
   * one, else one submitted and not yet committed. A pending taint has no row
   * id yet (`eventId` 0). Taint is sticky, so a taint that later fails to
   * commit stops its turn rather than loosening anything.
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
  const call:typeof invoke=<T>(name:string,...args:unknown[])=>{
    shared.inflight++;
    return invoke<T>(name,...args).finally(()=>{shared.inflight--;});
  };
  const safetyFail=(turnId:string|null):Promise<void>=>{
    if(!turnId||!db.query("SELECT 1 FROM safety_retired_turns WHERE turn_id=?").get(turnId))retainSafetyLoss(db,turnId);
    return call("safetyFail",turnId);
  };
  const record = (input: GovernanceEventInput): Promise<{ id: number; recorded: boolean }> => {
    const row = governanceEventRow(input);
    if (input.kind !== "taint" && input.kind !== "taint_exposure") return call("record", row);
    if (shared.failed&&input.kind!=="taint_exposure") throw new Error("Safety occurrence writer requires recovery");
    const bytes = Buffer.byteLength(JSON.stringify(row))+1024;
    const session = [...pendingTaints].filter(p => row.sessionId !== null ? p.sessionId === row.sessionId : p.turnId === row.turnId);
    if (pendingTaints.size >= 4096 || shared.bytes + bytes > 16777216 || session.length >= 256
      || session.reduce((sum, p) => sum + p.bytes, 0) + bytes > 1048576) {
      void safetyFail(row.turnId).catch(()=>{});
      throw new Error("Safety occurrence write capacity exceeded; ingestion must stop");
    }
    const pending = { turnId: row.turnId, sessionId: row.sessionId, source: input.kind==="taint"?(input as GovernanceEventInput<"taint">).payload.source:"legacy_unknown" as const, bytes };
    pendingTaints.add(pending); shared.bytes += bytes;
    const reservation=crypto.randomUUID();
    const stored = call<void>("safetyReserve",row,reservation,bytes).then(()=>call<{id:number;recorded:boolean}>("safetyCommit",row,reservation));
    return stored.catch(error => { if((error as {code?:string})?.code!=="chat_retired")retainSafetyLoss(db,row.turnId); throw error; })
      .finally(() => { pendingTaints.delete(pending); shared.bytes -= bytes; });
  };
  return {
    record,
    async safetyBegin(input){if(shared.failed)throw new SafetyUnavailable("Safety recording requires recovery");return call("safetyBegin",input);},
    safetyReady: (turnId,backendId,version)=>call("safetyReady",turnId,backendId,version),
    safetyEnd: turnId=>call("safetyEnd",turnId,shared.unscopedLoss||shared.lostTurns.has(turnId)),
    safetyFail,
    safety: (turnId,sessionId)=>{
      const projection=safetyProjection(db,turnId,sessionId);
      const local=[...pendingTaints].filter(p=>(turnId!==null&&p.turnId===turnId)||(sessionId!==null&&p.sessionId===sessionId)).length;
      if(local||shared.failed){projection.restriction="restricted";projection.pendingCount=Math.max(local,projection.pendingCount);
        if(local&&!projection.reasons.includes("recording_pending"))projection.reasons.push("recording_pending");
        if(shared.failed){projection.coverage.state="incomplete";if(!projection.reasons.includes("recording_failed"))projection.reasons.push("recording_failed");}}
      return projection;
    },
    recordingAvailable(turnId,sessionId){
      if(shared.failed||[...pendingTaints].some(p=>(turnId!==null&&p.turnId===turnId)||(sessionId!==null&&p.sessionId===sessionId)))return false;
      const state=safetyProjection(db,turnId,sessionId);
      return !state.reasons.some(reason=>["recording_failed","recording_pending","capacity"].includes(reason));
    },
    firstTaint: input => record(input).then(result => result.recorded),
    taint(turnId, sessionId) {
      if (shared.failed) return { eventId: 0, source: "legacy_unknown" };
      const committed = sessionTaint(db, turnId, sessionId);
      if (committed && committed.eventId>0) return committed;
      for (const pending of pendingTaints) {
        if ((turnId !== null && pending.turnId === turnId) || (sessionId !== null && pending.sessionId === sessionId)) return { eventId: 0, source: pending.source };
      }
      return committed;
    },
    bind: async (turnId, sessionId) => {
      const bound = await call<number>("bind", turnId, sessionId);
      for (const pending of pendingTaints) if (pending.turnId === turnId) pending.sessionId = sessionId;
      return bound;
    },
    roadblocks: (attribution, trace) => call<number>("roadblocks", attribution, trace),
    replaySteering: () => call<number>("replaySteering"),
  };
}
