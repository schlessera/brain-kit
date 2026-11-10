/** Connection-local ingestion state shared by every facade and host recovery. */
import type { Database } from "bun:sqlite";
import type { SessionTaint } from "./session-taint.js";
type PendingSafety = {turnId:string|null;sessionId:string|null;source:SessionTaint["source"];bytes:number};
const queues=new WeakMap<Database,{pending:Set<PendingSafety>;bytes:number;failed:boolean;inflight:number;
 /** The safety revision when this process latched in memory; null when unreadable. */
 latchRevision:string|null;
 lostTurns:Set<string>;unscopedLoss:boolean;listeners:Set<()=>void>;recovery:{timer:ReturnType<typeof setTimeout>|null;attempt:number};
 /** First cause of a loss only this process holds, kept for the recovery audit. */
 lossCause:{errorClass:string;message:string;site:string;turnId:string|null;at:number;count:number}|null;
 /** Each turn's tool-result records under way; its collection's end waits for them. */
 recording:Map<string,Set<Promise<void>>>}>();
export function safetyQueue(db:Database){
 let queue=queues.get(db);
 if(!queue){queue={pending:new Set(),bytes:0,failed:false,inflight:0,latchRevision:null,lostTurns:new Set(),unscopedLoss:false,listeners:new Set(),recovery:{timer:null,attempt:0},lossCause:null,recording:new Map()};queues.set(db,queue);}
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
 const queue=safetyQueue(db),was=queue.failed;
 if(turnId===null||(!queue.lostTurns.has(turnId)&&queue.lostTurns.size>=4096)){queue.unscopedLoss=true;queue.failed=true;}
 else queue.lostTurns.add(turnId);
 if(brainWide)queue.failed=true;
 // Unreadable: recovery then treats every open producer as predating it.
 if(queue.failed&&!was){try{queue.latchRevision=(db.query("SELECT revision FROM safety_meta WHERE singleton=1").get() as {revision:string}|null)?.revision??null;}catch{queue.latchRevision=null;}}
 notifySafetyChanged(db);
}
