/** A genuinely new catalog creation with the same host birth/ack path as a turn. */
import type { Database } from "bun:sqlite";
import { beginSafetyCollection,acknowledgeSafety,bindSafetyCollection } from "../../src/governance/safety-store";
import { createSessionCatalog } from "../../src/ws/session-catalog";
export function connectedSafetySession(db:Database,sessionId:string,turnId:string):void {
 beginSafetyCollection(db,{turnId,bindingId:crypto.randomUUID(),sessionId:null,principalId:"odysseus",backendId:"claude",at:0});
 const catalog=createSessionCatalog(()=>db);catalog.persistSessionStub(sessionId,"Voyage",null,"claude","odysseus",turnId);
 bindSafetyCollection(db,turnId,sessionId);acknowledgeSafety(db,turnId,"claude",1);
}
