/** Connection-local ingestion state shared by every facade and host recovery. */
import type { Database } from "bun:sqlite";
import type { SessionTaint } from "./session-taint.js";
type PendingSafety = {turnId:string|null;sessionId:string|null;source:SessionTaint["source"];bytes:number};
const queues=new WeakMap<Database,{pending:Set<PendingSafety>;bytes:number;failed:boolean;inflight:number;
 lostTurns:Set<string>;unscopedLoss:boolean;listeners:Set<()=>void>}>();
export function safetyQueue(db:Database){
 let queue=queues.get(db);
 if(!queue){queue={pending:new Set(),bytes:0,failed:false,inflight:0,lostTurns:new Set(),unscopedLoss:false,listeners:new Set()};queues.set(db,queue);}
 return queue;
}

export function notifySafetyChanged(db:Database):void {
 for(const listener of [...safetyQueue(db).listeners]) {
  try { listener(); } catch { /* The synchronous dispatch read still fails closed. */ }
 }
}

/** Bounded, fail-closed fallback when the durable failure notice itself fails.
 * Unscoped/overflow loss requires conservative coverage recovery for all epochs. */
export function retainSafetyLoss(db:Database,turnId:string|null):void {
 const queue=safetyQueue(db);queue.failed=true;
 if(turnId===null||(!queue.lostTurns.has(turnId)&&queue.lostTurns.size>=4096))queue.unscopedLoss=true;
 else queue.lostTurns.add(turnId);
 notifySafetyChanged(db);
}
