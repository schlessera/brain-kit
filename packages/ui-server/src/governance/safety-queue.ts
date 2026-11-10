/** Connection-local ingestion state shared by every facade and host recovery. */
import type { Database } from "bun:sqlite";
import type { SessionTaint } from "./session-taint.js";
type PendingSafety = {turnId:string|null;sessionId:string|null;source:SessionTaint["source"];bytes:number};
const queues=new WeakMap<Database,{pending:Set<PendingSafety>;bytes:number;failed:boolean;inflight:number;
 lostTurns:Set<string>;unscopedLoss:boolean;listeners:Set<()=>void>;recovery:{timer:ReturnType<typeof setTimeout>|null;attempt:number}}>();
export function safetyQueue(db:Database){
 let queue=queues.get(db);
 if(!queue){queue={pending:new Set(),bytes:0,failed:false,inflight:0,lostTurns:new Set(),unscopedLoss:false,listeners:new Set(),recovery:{timer:null,attempt:0}};queues.set(db,queue);}
 return queue;
}

export function notifySafetyChanged(db:Database):void {
 for(const listener of [...safetyQueue(db).listeners]) {
  try { listener(); } catch { /* The synchronous dispatch read still fails closed. */ }
 }
}

/** Bounded, fail-closed fallback while a durable failure notice is not yet
 * committed. A known turn restricts only its own chat. Unscoped/overflow loss,
 * or a notice that could not commit at all (`brainWide`), restricts the brain
 * until automatic recovery commits conservative gaps for every affected epoch. */
export function retainSafetyLoss(db:Database,turnId:string|null,brainWide=false):void {
 const queue=safetyQueue(db);
 if(turnId===null||(!queue.lostTurns.has(turnId)&&queue.lostTurns.size>=4096)){queue.unscopedLoss=true;queue.failed=true;}
 else queue.lostTurns.add(turnId);
 if(brainWide)queue.failed=true;
 notifySafetyChanged(db);
}
