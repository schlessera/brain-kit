/** Connection-local ingestion state shared by every facade and host recovery. */
import type { Database } from "bun:sqlite";
import type { SessionTaint } from "./session-taint.js";
type PendingSafety = {turnId:string|null;sessionId:string|null;source:SessionTaint["source"];bytes:number};
const queues=new WeakMap<Database,{pending:Set<PendingSafety>;bytes:number;failed:boolean;inflight:number}>();
export function safetyQueue(db:Database){
 let queue=queues.get(db);
 if(!queue){queue={pending:new Set(),bytes:0,failed:false,inflight:0};queues.set(db,queue);}
 return queue;
}
