/** Serialized host-only collection ledger and committed verdict projection. */
import { Database } from "bun:sqlite";
import { safetyQueue } from "./safety-queue.js";
import { assertLive,ChatRetiredError } from "../ws/chat-lifecycle.js";
import { occurrence, type Occurrence } from "./occurrence.js";
import type { GovernanceEventRow } from "./events.js";

const SAFETY_DETECTORS = ["tool_web_input", "tool_file_input", "tool_search_output", "external_mcp_input", "attachment_input",
  "compute_input", "unproxied_shell_input", "proxy_input", "explicit_untrusted_input"] as const;
const SAFETY_LIMITS = { occurrenceBytes: 8192, sessionRows: 100000, sessionBytes: 67108864,
  brainRows: 1000000, brainBytes: 536870912, sessionPending: 256, sessionPendingBytes: 1048576,
  brainPending: 4096, brainPendingBytes: 16777216, unbound: 1024, unboundBytes: 8388608, epochs: 128 } as const;
const MAX_REVISION = 18446744073709551615n;
function actualGeneration(value:number):string {
 if(!Number.isSafeInteger(value)||value<1)throw new SafetyUnavailable("Invalid safety history generation");
 return String(value);
}
const VERDICT_BYTES = 2048, TERMINAL_BYTES = 2048;
interface SafetySessionKey { sessionId: string; historyOwnerId: string; historyGeneration: string }
export interface SafetyCollectionInput { turnId: string; bindingId: string; principalId: string | null; historyOwnerId?: string;
  sessionId: string | null; backendId: string; sourceSessionId?: string; policyHash?: string|null; at: number }
interface Collection { id: string; turn_id: string; session_id: string | null; principal_id: string | null; history_owner_id: string | null;
  generation: string; backend_id: string; started_at: number; ended: number; acknowledged: string; gap: string | null; failure: string | null;
  policy_hash:string|null; start_revision: string; end_revision: string | null }
interface Session { session_id: string; history_owner_id: string; generation: string; principal_id: string | null;
  classification: string; origin_turn: string | null; backend_id: string | null }
export class SafetyUnavailable extends Error { constructor(message: string) { super(message); } }
const one = <T>(db: Database, sql: string, ...args: (string | number | null)[]) => db.query(sql).get(...args) as T;
const collection = (db: Database, turn: string) => one<Collection | null>(db,"SELECT * FROM safety_collections WHERE turn_id=?",turn);
const meta = (db: Database) => one<{revision:string;failed:number;used_rows:number;used_bytes:number;scope_rows:number;scope_bytes:number}>(db,"SELECT * FROM safety_meta WHERE singleton=1");
export function advance(db: Database): string {
  const old=BigInt(meta(db).revision);
  if(old>=MAX_REVISION) throw new SafetyUnavailable("Safety revision exhausted");
  const next=String(old+1n); db.query("UPDATE safety_meta SET revision=? WHERE singleton=1").run(next); return next;
}
/** Existing emergency cells are allocated before ingestion, never appended at overflow. */
export function latchSafety(db:Database,turnId:string|null,reason:"recording_failed"|"capacity"):void {
  db.transaction(()=>{
    db.query("UPDATE safety_emergency_reserve SET padding=zeroblob(0) WHERE singleton=1").run();
    db.query("UPDATE safety_meta SET failed=1,reason=CASE WHEN reason='capacity' THEN reason ELSE ? END WHERE singleton=1").run(reason);
    if(turnId) db.query("UPDATE safety_collections SET failure=CASE WHEN failure='capacity' THEN failure ELSE ? END WHERE turn_id=?").run(reason,turnId);
    if(BigInt(meta(db).revision)<MAX_REVISION)advance(db);
  }).immediate();
}
function live(db:Database,c:Collection,reserved=false):void {
  assertLive(db,[["session",c.session_id],["dialogue_owner",c.history_owner_id]]);
  const owner=c.history_owner_id?one<{generation:number}|null>(db,"SELECT generation FROM dialogue_owners WHERE id=?",c.history_owner_id):null;
  if(owner&&String(owner.generation)!==c.generation)throw new SafetyUnavailable("Safety history generation changed");
  if(c.ended)throw new SafetyUnavailable("Safety collection ended; late input refused");
  if(!reserved&&(c.failure||meta(db).failed))throw new SafetyUnavailable("Safety collection requires recovery");
}
function capacity(db:Database,c:Collection,rows:number,bytes:number):void {
  const all=meta(db);
  const {scope,args}=safetyScope(db,c.turn_id,c.session_id);
  const used=one<{rows:number;bytes:number}>(db,`SELECT COALESCE(SUM(r.reserved_rows),0) rows,COALESCE(SUM(r.reserved_bytes),0) bytes
    FROM safety_records r JOIN safety_collections c ON c.id=r.collection_id WHERE ${scope}`,...args);
  const pending=one<{rows:number;bytes:number}>(db,`SELECT COALESCE(SUM(p.rows),0) rows,COALESCE(SUM(p.reserved_bytes),0) bytes FROM safety_pending p`);
  const localPending=one<{rows:number;bytes:number}>(db,`SELECT COALESCE(SUM(p.rows),0) rows,COALESCE(SUM(p.reserved_bytes),0) bytes
    FROM safety_pending p JOIN safety_collections c ON c.id=p.collection_id WHERE ${scope}`,...args);
  if(all.used_rows+all.scope_rows+pending.rows+rows>SAFETY_LIMITS.brainRows||all.used_bytes+all.scope_bytes+pending.bytes+bytes>SAFETY_LIMITS.brainBytes
    ||used.rows+localPending.rows+rows>SAFETY_LIMITS.sessionRows||used.bytes+localPending.bytes+bytes>SAFETY_LIMITS.sessionBytes)
    throw new SafetyUnavailable("Safety ledger capacity exhausted");
  if(c.session_id===null){
    const unbound=one<{bytes:number}>(db,`SELECT COALESCE(SUM(r.reserved_bytes),0) bytes FROM safety_records r
      JOIN safety_collections c ON c.id=r.collection_id WHERE c.session_id IS NULL`);
    if(unbound.bytes+pending.bytes+bytes+one<{n:number}>(db,"SELECT COUNT(*) n FROM safety_collections WHERE session_id IS NULL").n*2048>SAFETY_LIMITS.unboundBytes)throw new SafetyUnavailable("Safety unbound byte capacity exhausted");
  }
}
/** Must commit before any first-turn bytes or tool execution. Callbacks cannot create a session. */
export function beginSafetyCollection(db:Database,input:SafetyCollectionInput):string {
 return db.transaction(()=>{
  for(const id of [input.turnId,input.bindingId,input.backendId,input.sessionId,input.historyOwnerId,input.principalId]){
    if(id!==null&&id!==undefined&&!/^[A-Za-z0-9_-]{1,128}$/.test(id))throw new SafetyUnavailable("Invalid bounded safety identity");
  }
  if(!Number.isSafeInteger(input.at)||input.at<0)throw new SafetyUnavailable("Invalid safety clock");
  if(meta(db).failed)throw new SafetyUnavailable("Safety recording requires recovery");
  if(db.query("SELECT 1 FROM safety_retired_turns WHERE turn_id=?").get(input.turnId))throw new ChatRetiredError();
  const previous=collection(db,input.turnId);
  if(previous){if(previous.id!==input.bindingId||previous.principal_id!==input.principalId||previous.backend_id!==input.backendId)throw new SafetyUnavailable("Conflicting safety collection"); live(db,previous);return previous.id;}
  assertLive(db,[["session",input.sessionId],["dialogue_owner",input.historyOwnerId]]);
  const session=input.sessionId?one<Session|null>(db,"SELECT * FROM safety_sessions WHERE session_id=?",input.sessionId):null;
  if(input.sessionId&&!session)throw new SafetyUnavailable("Unknown safety session; discover catalog history first");
  let owner=input.historyOwnerId??session?.history_owner_id??input.bindingId,generation=session?.generation??"1",uncollectedOwner=false;
  if(owner){
    const d=one<{id:string;principal_id:string;generation:number}|null>(db,`SELECT id,principal_id,generation FROM dialogue_owners
      WHERE id=COALESCE((SELECT id FROM dialogue_owners WHERE session_id=?),(SELECT owner_id FROM dialogue_aliases WHERE id=?),?)`,input.sessionId,owner,owner);
    if(d){if(d.principal_id!==input.principalId)throw new SafetyUnavailable("Safety history ownership mismatch");owner=d.id;generation=actualGeneration(d.generation);
      uncollectedOwner=!db.query("SELECT 1 FROM safety_collections WHERE history_owner_id=? AND generation=? LIMIT 1").get(owner,generation);
    }
  }
  assertLive(db,[["dialogue_owner",owner]]);
  if(session?.principal_id&&session.principal_id!==input.principalId)throw new SafetyUnavailable("Safety principal mismatch");
  const n=one<{n:number}>(db, input.sessionId?"SELECT COUNT(*) n FROM safety_collections WHERE session_id=?":"SELECT COUNT(*) n FROM safety_collections WHERE session_id IS NULL",...(input.sessionId?[input.sessionId]:[]));
  if(n.n>=(input.sessionId?SAFETY_LIMITS.epochs:SAFETY_LIMITS.unbound))throw new SafetyUnavailable("Safety coverage capacity exhausted");
  if(input.sessionId===null){
    const unbound=one<{bytes:number}>(db,`SELECT COALESCE(SUM(r.reserved_bytes),0) bytes FROM safety_records r JOIN safety_collections c ON c.id=r.collection_id WHERE c.session_id IS NULL`);
    const pending=one<{bytes:number}>(db,`SELECT COALESCE(SUM(p.reserved_bytes),0) bytes FROM safety_pending p JOIN safety_collections c ON c.id=p.collection_id WHERE c.session_id IS NULL`);
    if(unbound.bytes+pending.bytes+(n.n+1)*2048>SAFETY_LIMITS.unboundBytes)throw new SafetyUnavailable("Safety unbound byte capacity exhausted");
  }
  const ledger=meta(db),pending=one<{rows:number;bytes:number}>(db,"SELECT COALESCE(SUM(rows),0) rows,COALESCE(SUM(reserved_bytes),0) bytes FROM safety_pending");
  if(ledger.used_rows+ledger.scope_rows+pending.rows+1>SAFETY_LIMITS.brainRows||ledger.used_bytes+ledger.scope_bytes+pending.bytes+2048>SAFETY_LIMITS.brainBytes)throw new SafetyUnavailable("Safety identity capacity exhausted");
  if(owner&&one<{n:number}>(db,"SELECT COUNT(*) n FROM safety_collections WHERE history_owner_id=? AND generation=?",owner,generation).n>=128)throw new SafetyUnavailable("Safety coverage capacity exhausted");
  if(input.policyHash!==undefined&&input.policyHash!==null&&!/^[a-f0-9]{64}$/.test(input.policyHash))throw new SafetyUnavailable("Invalid safety policy hash");
  const gap=uncollectedOwner?"missing_history_owner_collection":input.sessionId&&!session?.principal_id?"unknown_history_owner":session?.backend_id&&session.backend_id!==input.backendId?"backend_history_not_reconstructed":null;
  db.query(`INSERT INTO safety_collections(id,turn_id,session_id,principal_id,history_owner_id,generation,backend_id,started_at,gap,start_revision)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(input.bindingId,input.turnId,input.sessionId,input.principalId,owner,generation,input.backendId,input.at,gap,advance(db));
  db.query("UPDATE safety_collections SET policy_hash=? WHERE id=?").run(input.policyHash??null,input.bindingId);
  db.query("UPDATE safety_meta SET scope_rows=scope_rows+1,scope_bytes=scope_bytes+2048 WHERE singleton=1").run();
  if(input.sessionId)bindSafetyCollection(db,input.turnId,input.sessionId);
  if(input.sourceSessionId){
    const sourceOwner=one<{principal_id:string|null}|null>(db,"SELECT principal_id FROM safety_sessions WHERE session_id=?",input.sourceSessionId);
    if(sourceOwner?.principal_id&&sourceOwner.principal_id!==input.principalId)throw new SafetyUnavailable("Safety fork history ownership mismatch");
    safetyProjection(db,null,input.sourceSessionId); // Also validates retirement.
    db.query("UPDATE safety_collections SET gap='inherited_history_not_reconstructed' WHERE id=?").run(input.bindingId);
    const records=db.query<RecordRow,[string]>(`SELECT r.* FROM safety_records r JOIN safety_collections c ON c.id=r.collection_id
      WHERE c.session_id=? AND r.kind='occurrence' AND NOT EXISTS(SELECT 1 FROM safety_decisions d WHERE d.occurrence_id=r.id)`).iterate(input.sourceSessionId);
    for(const r of records){const payload=JSON.parse(r.payload);payload.occurrence=occurrence(input.bindingId,(r.detector??"tool_file_input") as Occurrence["detector"],null,"interrupted_unknown");
      appendRecord(db,collection(db,input.turnId)!,payload.occurrence.id,"occurrence",payload.occurrence.id,r.source,r.detector,"interrupted_unknown",payload,input.at);}
  }
  return input.bindingId;
 }).immediate();
}
/** Catalog owner records prove creation; never infer a new chat from an arbitrary callback. */
export function safetyCatalogCreated(db:Database,sessionId:string,principalId:string,turnId:string|undefined):void {
 if(!turnId)return;
 if(db.query("SELECT 1 FROM safety_retired_turns WHERE turn_id=?").get(turnId))throw new ChatRetiredError();
 const c=collection(db,turnId);
 if(c){assertLive(db,[["dialogue_owner",c.history_owner_id]]);if(c.ended)throw new SafetyUnavailable("Safety collection ended before catalog creation");}if(!c||c.session_id!==null||c.principal_id!==principalId)return;
 db.query("UPDATE safety_sessions SET principal_id=?,origin_turn=?,classification='new',history_owner_id=?,generation=? WHERE session_id=? AND classification='discovered'").run(principalId,turnId,c.history_owner_id,c.generation,sessionId);
}
export function bindSafetyCollection(db:Database,turnId:string,sessionId:string):void {
 const c=collection(db,turnId);if(!c)return;
 live(db,c);
 const s=one<Session|null>(db,"SELECT * FROM safety_sessions WHERE session_id=?",sessionId);if(!s)throw new SafetyUnavailable("Safety catalog binding absent");
 if(c.session_id&&c.session_id!==sessionId)throw new SafetyUnavailable("Safety binding is once-only");
 const d=one<{id:string;principal_id:string;generation:number}|null>(db,"SELECT id,principal_id,generation FROM dialogue_owners WHERE session_id=?",sessionId);
 const principal=d?.principal_id??s.principal_id??one<{principal_id:string}|null>(db,"SELECT principal_id FROM chat_session_owners WHERE session_id=?",sessionId)?.principal_id??null;
 if(c.principal_id&&principal&&c.principal_id!==principal)throw new SafetyUnavailable("Safety binding owner mismatch");
 if(c.history_owner_id&&d&&c.history_owner_id!==d.id&&c.history_owner_id!==s.history_owner_id){
  const alias=one<{owner_id:string}|null>(db,"SELECT owner_id FROM dialogue_aliases WHERE id=?",c.history_owner_id);
  if(alias?.owner_id!==d.id)throw new SafetyUnavailable("Contradictory safety history owner");
 }
 // The catalog announcement precedes DialogueJournal adoption. Resolve both
 // the native-session owner and the retained provisional owner, never the
 // discovery row's placeholder generation.
 const retained=c.history_owner_id?one<{id:string;principal_id:string;generation:number}|null>(db,
  "SELECT id,principal_id,generation FROM dialogue_owners WHERE id=COALESCE((SELECT owner_id FROM dialogue_aliases WHERE id=?),?)",c.history_owner_id,c.history_owner_id):null;
 if(retained&&retained.principal_id!==c.principal_id)throw new SafetyUnavailable("Safety retained owner mismatch");
 const owner=d?.id??retained?.id??s.history_owner_id,gen=d?actualGeneration(d.generation):retained?actualGeneration(retained.generation):s.generation;
 if(retained&&actualGeneration(retained.generation)!==c.generation)throw new SafetyUnavailable("Safety history generation changed");
 assertLive(db,[["session",sessionId],["dialogue_owner",owner]]);
 const {scope,args}=safetyScope(db,turnId,sessionId);
 const epochs=one<{n:number}>(db,`SELECT COUNT(*) n FROM safety_collections c WHERE ${scope}`,...args);
 if(epochs.n>128)throw new SafetyUnavailable("Safety binding coverage capacity exhausted");
 const totals=one<{rows:number;bytes:number}>(db,`SELECT COALESCE(SUM(r.reserved_rows),0) rows,COALESCE(SUM(r.reserved_bytes),0) bytes FROM safety_records r
  JOIN safety_collections c ON c.id=r.collection_id WHERE ${scope}`,...args);
 const pending=one<{rows:number;bytes:number;count:number;serializedBytes:number}>(db,`SELECT COALESCE(SUM(p.rows),0) rows,COALESCE(SUM(p.reserved_bytes),0) bytes,
  COUNT(*) count,COALESCE(SUM(p.bytes),0) serializedBytes FROM safety_pending p
  JOIN safety_collections c ON c.id=p.collection_id WHERE ${scope}`,...args);
 if(totals.rows+pending.rows>SAFETY_LIMITS.sessionRows||totals.bytes+pending.bytes>SAFETY_LIMITS.sessionBytes)throw new SafetyUnavailable("Safety binding capacity exhausted");
 if(pending.count>SAFETY_LIMITS.sessionPending||pending.serializedBytes>SAFETY_LIMITS.sessionPendingBytes)throw new SafetyUnavailable("Safety binding pending capacity exhausted");
 const previous=one<{session_id:string;history_owner_id:string;generation:string}|null>(db,"SELECT * FROM safety_bindings WHERE turn_id=?",turnId);
 if(previous&&(previous.session_id!==sessionId||previous.history_owner_id!==owner||previous.generation!==gen))throw new SafetyUnavailable("Safety SessionKey binding changed");
 db.query("INSERT INTO safety_bindings VALUES(?,?,?,?,?,?) ON CONFLICT DO NOTHING").run(c.id,turnId,sessionId,owner,gen,advance(db));
 db.query("UPDATE safety_sessions SET history_owner_id=?,generation=?,principal_id=COALESCE(principal_id,?) WHERE session_id=?").run(owner,gen,principal,sessionId);
 db.query("UPDATE safety_collections SET session_id=?,history_owner_id=?,generation=?,gap=COALESCE(gap,?) WHERE id=?")
  .run(sessionId,owner,gen,principal?null:"unknown_history_owner",c.id);advance(db);
}
export function acknowledgeSafety(db:Database,turnId:string,backendId:string,version:number):void {
 db.transaction(()=>{const c=collection(db,turnId);if(!c)throw new SafetyUnavailable("Safety collection missing");live(db,c);
 if(c.backend_id!==backendId||version!==1||!["claude","pi"].includes(backendId))throw new SafetyUnavailable("Safety detector version/backend mismatch");
 db.query("UPDATE safety_collections SET acknowledged=? WHERE id=?").run(JSON.stringify(SAFETY_DETECTORS),c.id);advance(db);
 }).immediate();
}
interface RecordRow {id:string;collection_id:string;sequence:string;observed_at:number;kind:string;occurrence_id:string;source:string|null;detector:string|null;
 state:string|null;payload:string;bytes:number;reserved_rows:number;reserved_bytes:number;detail_pruned:number}
function appendRecord(db:Database,c:Collection,id:string,kind:"occurrence"|"exposure",occurrenceId:string,source:string|null,detector:string|null,state:string|null,payload:unknown,at:number):void {
 const json=JSON.stringify(payload),bytes=Buffer.byteLength(JSON.stringify({id,collectionId:c.id,turnId:c.turn_id,
   session:{sessionId:c.session_id,historyOwnerId:c.history_owner_id,historyGeneration:c.generation},sequence:"18446744073709551615",observedAt:at,
   kind,occurrenceId,source,detector,state,payload}));
 if(bytes>SAFETY_LIMITS.occurrenceBytes)throw new SafetyUnavailable("Safety occurrence byte limit exceeded");
 const previous=one<RecordRow|null>(db,"SELECT * FROM safety_records WHERE id=?",id);
 if(previous){if(previous.collection_id!==c.id||(previous.detail_pruned ? JSON.parse(previous.payload).sha256!==new Bun.CryptoHasher("sha256").update(json).digest("hex") : previous.payload!==json))throw new SafetyUnavailable("Conflicting safety occurrence identity");return;}
 const rows=kind==="occurrence"?(state==="finalized"?2:4):0,
   reserved=kind==="occurrence"?bytes+VERDICT_BYTES+(state==="finalized"?0:2*TERMINAL_BYTES):0;
 if(kind==="exposure"&&bytes>TERMINAL_BYTES)throw new SafetyUnavailable("Safety terminal reserve exceeded");
 capacity(db,c,rows,reserved);
 db.query("INSERT INTO safety_records VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,0)").run(id,c.id,advance(db),at,kind,occurrenceId,source,detector,state,json,bytes,rows,reserved);
 db.query("UPDATE safety_meta SET used_rows=used_rows+?,used_bytes=used_bytes+? WHERE singleton=1").run(rows,reserved);
}
/** Runs inside the governance event's transaction; legacy producers stay unknown. */
export function appendSafetyEvent(db:Database,row:GovernanceEventRow,reserved=false):string|null {
 if(row.kind!=="taint"&&row.kind!=="taint_exposure")return null;
 let c=row.turnId?collection(db,row.turnId):null;
 const payload=JSON.parse(row.payload);
 if(!c){
  const turnId=row.turnId??`unbound_${crypto.randomUUID()}`;
  const id=crypto.randomUUID();
  // Uninstrumented producers never establish complete collection.
  beginSafetyCollection(db,{turnId,bindingId:id,principalId:null,sessionId:null,backendId:"unknown",at:row.at});
  db.query("UPDATE safety_collections SET session_id=?,gap='uninstrumented_backend_input' WHERE id=?").run(row.sessionId&&db.query("SELECT 1 FROM sessions WHERE id=?").get(row.sessionId)?row.sessionId:null,id);
  c=collection(db,turnId)!;
 }
 live(db,c,reserved);
 if(row.kind==="taint"){
  const observed=payload.occurrence as Occurrence|undefined;
  if(!observed)db.query("UPDATE safety_collections SET gap=COALESCE(gap,'uninstrumented_backend_input') WHERE id=?").run(c.id);
  if(observed&&JSON.parse(c.acknowledged).length&&observed.epochId!==c.id)throw new SafetyUnavailable("Safety occurrence epoch mismatch");
  const id=observed?.id??row.dedupeKey??crypto.randomUUID();
  appendRecord(db,c,id,"occurrence",id,payload.source,observed?.detector??null,observed?.exposure??"interrupted_unknown",payload,row.at);
  return id;
 }else{
  const original=one<RecordRow|null>(db,"SELECT * FROM safety_records WHERE id=? AND kind='occurrence'",payload.occurrenceId);
  if(!original||original.collection_id!==c.id)throw new SafetyUnavailable("Safety exposure identity mismatch");
  const previous=db.query("SELECT state FROM safety_records WHERE occurrence_id=? AND kind='exposure'").all(payload.occurrenceId) as {state:string}[];
  if(original.state==="finalized"||previous.some(p=>p.state==="finalized")||previous.length>=2||previous.some(p=>p.state===payload.state))throw new SafetyUnavailable("Safety exposure is terminal or duplicate transition");
  const transitionId=`x_${new Bun.CryptoHasher("sha256").update(row.dedupeKey??crypto.randomUUID()).digest("hex")}`;
  appendRecord(db,c,transitionId,"exposure",payload.occurrenceId,null,null,payload.state,payload,row.at);
  return null;
 }
}
export function endSafetyCollection(db:Database,turnId:string):void {
 db.transaction(()=>{const c=collection(db,turnId);if(!c||c.ended)return;
 // Lost/incomplete hooks leave exposures open and therefore unresolved.
 db.query("UPDATE safety_collections SET ended=1,end_revision=? WHERE id=?").run(advance(db),c.id);
 }).immediate();
}
export interface SafetyProjection { session:SafetySessionKey|null;evidenceRevision:string;unresolvedCount:number;earliestUnresolvedId:string|null;
 pendingCount:number;restriction:"normal"|"restricted";reasons:string[];
 coverage:{detectorVersion:1;state:"complete"|"incomplete"|"unknown";epochs:{id:string;backendId:string;startSequence:string;endSequence:string|null;mandatory:readonly string[];acknowledged:string[];status:string;reason:string|null}[];exclusions:string[]} }
/** Count is derived from all compact identities, never a detail page or Activity. */
export function safetyProjection(db:Database,turnId:string|null,sessionId:string|null):SafetyProjection {
 // This callback only reads. Use a native deferred snapshot so a held write
 // worker does not block pending-input admission on the event loop.
 if(db.inTransaction)return readSafetyProjection(db,turnId,sessionId);
 return Database.prototype.transaction.call(db,()=>readSafetyProjection(db,turnId,sessionId)).deferred() as SafetyProjection;
}
function safetyScope(db:Database,turnId:string|null,sessionId:string|null) {
 const s=sessionId?one<Session|null>(db,"SELECT * FROM safety_sessions WHERE session_id=?",sessionId):null;
 const target=turnId?collection(db,turnId):null;
 const retainedOwner=s?.history_owner_id??target?.history_owner_id??null,generation=s?.generation??target?.generation??"1";
 const owner=retainedOwner?one<{owner_id:string}|null>(db,"SELECT owner_id FROM dialogue_aliases WHERE id=?",retainedOwner)?.owner_id??retainedOwner:null;
 assertLive(db,[["session",sessionId],["dialogue_owner",retainedOwner],["dialogue_owner",owner]]);
 const scope=`((? IS NOT NULL AND c.session_id=?) OR c.turn_id=? OR
   (? IS NOT NULL AND c.generation=? AND (c.history_owner_id=? OR c.history_owner_id IN (SELECT id FROM dialogue_aliases WHERE owner_id=?))))`;
 const args=[sessionId,sessionId,turnId,owner,generation,owner,owner];
 return {s,scope,args};
}
/** Pending input uses the aggregate's durable canonical membership, even before
 * its own reservation commits. Include an unbound turn with no collection yet. */
export function safetyScopeTurns(db:Database,turnId:string|null,sessionId:string|null):Set<string> {
 const {scope,args}=safetyScope(db,turnId,sessionId);
 const turns=new Set(db.query<{turn_id:string},(string|null)[]>(`SELECT c.turn_id FROM safety_collections c WHERE ${scope}`).all(...args).map(c=>c.turn_id));
 if(turnId!==null)turns.add(turnId);
 return turns;
}
/** Last immutable append in the same canonical scope as the aggregate. */
export function safetyEvidenceSequence(db:Database,turnId:string|null,sessionId:string|null):string {
 const {scope,args}=safetyScope(db,turnId,sessionId);
 return one<{sequence:string}|null>(db,`SELECT sequence FROM (
   SELECT r.sequence FROM safety_records r JOIN safety_collections c ON c.id=r.collection_id WHERE ${scope}
   UNION ALL SELECT d.sequence FROM safety_decisions d JOIN safety_records r ON r.id=d.occurrence_id
     JOIN safety_collections c ON c.id=r.collection_id WHERE ${scope}
   UNION ALL SELECT b.sequence FROM safety_bindings b JOIN safety_collections c ON c.id=b.binding_id WHERE ${scope}
   UNION ALL SELECT c.start_revision FROM safety_collections c WHERE ${scope}
   UNION ALL SELECT c.end_revision FROM safety_collections c WHERE ${scope} AND c.end_revision IS NOT NULL
 ) ORDER BY length(sequence) DESC,sequence DESC LIMIT 1`,...args,...args,...args,...args,...args)?.sequence??"0";
}
function readSafetyProjection(db:Database,turnId:string|null,sessionId:string|null):SafetyProjection {
 const {s,scope,args}=safetyScope(db,turnId,sessionId);
 const cs=db.query(`SELECT c.* FROM safety_collections c WHERE ${scope} ORDER BY c.rowid`).all(...args) as Collection[];
 const epochs=cs.slice(0,128).map(c=>{
   const acknowledged=JSON.parse(c.acknowledged) as string[];
   const complete=!c.gap&&!c.failure&&SAFETY_DETECTORS.every(d=>acknowledged.includes(d));
   return {id:c.id,backendId:c.backend_id,startSequence:c.start_revision,endSequence:c.end_revision,mandatory:SAFETY_DETECTORS,
     acknowledged,status:complete?"complete":"incomplete",reason:c.failure??c.gap??(complete?null:"missing_detector_acknowledgement")};
 });
 const unknown=cs.length===0||cs.length>128||cs.some(c=>c.gap||c.failure||JSON.parse(c.acknowledged).length<SAFETY_DETECTORS.length)
   ||!!s&&s.classification!=="new";
 const aggregate=one<{n:number}>(db,`SELECT COUNT(*) n FROM safety_records r JOIN safety_collections c ON c.id=r.collection_id
   WHERE r.kind='occurrence' AND ${scope} AND NOT EXISTS(SELECT 1 FROM safety_decisions d WHERE d.occurrence_id=r.id)`,...args);
 const first=one<{id:string}|null>(db,`SELECT r.id FROM safety_records r JOIN safety_collections c ON c.id=r.collection_id
   WHERE r.kind='occurrence' AND ${scope} AND NOT EXISTS(SELECT 1 FROM safety_decisions d WHERE d.occurrence_id=r.id)
   ORDER BY length(r.sequence),r.sequence LIMIT 1`,...args);
 const pending=one<{n:number}>(db,`SELECT COUNT(*) n FROM safety_pending p JOIN safety_collections c ON c.id=p.collection_id WHERE ${scope}`,...args).n;
 const reasons:string[]=[];
 if(aggregate.n)reasons.push("unresolved");if(unknown)reasons.push("coverage_unknown");if(pending)reasons.push("recording_pending");
 // Ended failures remain in epoch coverage forever. Once explicit quiescent
 // recovery clears the global latch, they are historical gaps, not an active
 // infrastructure outage that prevents a new restricted turn from running.
 if(meta(db).failed||cs.some(c=>c.failure&&!c.ended))reasons.push("recording_failed");
 if(one<{reason:string|null}>(db,"SELECT reason FROM safety_meta").reason==="capacity"||cs.some(c=>c.failure==="capacity"&&!c.ended))reasons.push("capacity");
 return {session:s?{sessionId:s.session_id,historyOwnerId:s.history_owner_id,historyGeneration:s.generation}:null,
   evidenceRevision:meta(db).revision,unresolvedCount:aggregate.n,earliestUnresolvedId:first?.id??null,pendingCount:pending,
   restriction:reasons.length?"restricted":"normal",reasons,
   coverage:{detectorVersion:1,state:unknown?(cs.length?"incomplete":"unknown"):"complete",epochs,
     exclusions:["proxied_shell_local_read","opaque_tunnel_inner_protocol",...(unknown?["missing_historical_signals"]:[])]}};
}
/** Explicit detector loss/restart never auto-clears an admitted exposure. */
export function recoverSafetyCollections(db:Database):void {
 db.transaction(()=>{
  const n=one<{n:number}>(db,"SELECT COUNT(*) n FROM safety_collections WHERE ended=0").n;
  if(n){db.query("UPDATE safety_collections SET gap=COALESCE(gap,'host_restart_unknown'),ended=1,end_revision=? WHERE ended=0").run(advance(db));}
  if(one<{n:number}>(db,"SELECT COUNT(*) n FROM safety_pending").n)latchSafety(db,null,"recording_failed");
 }).immediate();
}
/** Prune only display bytes; identity, counts and reserved audit capacity survive. */
export function pruneSafetyDetail(db:Database,before:number):number {
 return db.transaction(()=>{
   const rows=db.query("SELECT id,payload FROM safety_records WHERE observed_at<? AND detail_pruned=0 LIMIT 1000").all(before) as {id:string;payload:string}[];
   for(const row of rows){
     const entry=JSON.parse(row.payload).occurrence?.entry;
     db.query("UPDATE safety_records SET payload=?,detail_pruned=1 WHERE id=?").run(JSON.stringify({sha256:new Bun.CryptoHasher("sha256").update(row.payload).digest("hex"),...(entry?{entry}:{})}),row.id);
   }
   return rows.length;
 }).immediate();
}

/** Two serialized commits bracket a queued write. A crash between them leaves
 * the exact durable pending identity and reserved terminal capacity intact. */
export function reserveSafetyWrite(db:Database,turnId:string,requestId:string,bytes:number,terminalOccurrenceId?:string):void {
 db.transaction(()=>{const c=collection(db,turnId);if(!c)throw new SafetyUnavailable("Safety reservation requires a collection");live(db,c,terminalOccurrenceId!==undefined);
 if(terminalOccurrenceId&&!db.query("SELECT 1 FROM safety_records WHERE id=? AND collection_id=? AND kind='occurrence'").get(terminalOccurrenceId,c.id))throw new SafetyUnavailable("Safety terminal reservation identity mismatch");
 const prior=one<{bytes:number}|null>(db,"SELECT bytes FROM safety_pending WHERE id=?",requestId);if(prior){if(prior.bytes!==bytes)throw new SafetyUnavailable("Conflicting safety reservation");return;}
 const global=one<{n:number;bytes:number}>(db,"SELECT COUNT(*) n,COALESCE(SUM(bytes),0) bytes FROM safety_pending");
 const {scope,args}=safetyScope(db,turnId,c.session_id);
 const local=one<{n:number;bytes:number}>(db,`SELECT COUNT(*) n,COALESCE(SUM(p.bytes),0) bytes FROM safety_pending p JOIN safety_collections c ON c.id=p.collection_id
  WHERE ${scope}`,...args);
 if(global.n>=SAFETY_LIMITS.brainPending||global.bytes+bytes>SAFETY_LIMITS.brainPendingBytes||local.n>=SAFETY_LIMITS.sessionPending||local.bytes+bytes>SAFETY_LIMITS.sessionPendingBytes)
  throw new SafetyUnavailable("Safety pending capacity exhausted");
 const rows=terminalOccurrenceId?0:4,reserved=terminalOccurrenceId?0:bytes+VERDICT_BYTES+2*TERMINAL_BYTES;
 capacity(db,c,rows,reserved);
 db.query("INSERT INTO safety_pending VALUES(?,?,?,?,?)").run(requestId,c.id,bytes,rows,reserved);advance(db);
 }).immediate();
}
export function releaseSafetyWrite(db:Database,id:string):void {db.query("DELETE FROM safety_pending WHERE id=?").run(id);advance(db);}
export function migrateSafetyHistory(db:Database):void {
 type Legacy={id:number;session_id:string|null;turn_id:string|null;at:number;kind:"taint";payload:string;schema_version:number;actor:GovernanceEventRow["actor"];model:string|null;profile:GovernanceEventRow["profile"];dedupe_key:string|null};
 let after=0;
 for(;;){
  const rows=db.query<Legacy,[number]>(`SELECT g.* FROM governance_events g WHERE g.kind='taint' AND g.id>?
    AND NOT EXISTS(SELECT 1 FROM safety_legacy_events m WHERE m.event_id=g.id)
    AND NOT EXISTS(SELECT 1 FROM safety_retired_turns t WHERE t.turn_id=g.turn_id)
    AND NOT EXISTS(SELECT 1 FROM chat_retired_identities t WHERE t.kind='session' AND t.id=g.session_id) ORDER BY g.id LIMIT 100`).all(after);
  if(!rows.length)return;
  for(const r of rows){try{db.transaction(()=>{
    const recordId=appendSafetyEvent(db,{sessionId:r.session_id,turnId:r.turn_id,at:r.at,kind:r.kind,payload:r.payload,version:r.schema_version,actor:r.actor,model:r.model,profile:r.profile,dedupeKey:r.dedupe_key});
    db.query("INSERT INTO safety_legacy_events VALUES(?,?)").run(r.id,recordId!);
   }).immediate();after=r.id;}catch{latchSafety(db,r.turn_id,"capacity");return;}}
 }
}
/** Bounded compact rows are for host tests/next slices, never authorization. */
export function safetyRecords(db:Database,sessionId:string,limit:number=100):{id:string;sequence:string;kind:string;state:string|null;detailPruned:boolean;occurrenceId:string;payload:unknown}[] {
 assertLive(db,[["session",sessionId]]);
 if(!Number.isInteger(limit)||limit<1||limit>100)throw new SafetyUnavailable("Safety detail limit must be 1-100");
 const rows=db.query(`SELECT * FROM (SELECT r.id,r.sequence,r.kind,r.state,r.detail_pruned,r.payload,r.occurrence_id FROM safety_records r
  JOIN safety_collections c ON c.id=r.collection_id WHERE c.session_id=?
  UNION ALL SELECT d.id,d.sequence,'safe_decision',NULL,0,json_object('occurrenceId',d.occurrence_id,
    'session',json_object('sessionId',d.session_id,'historyOwnerId',d.history_owner_id,'historyGeneration',d.generation),
    'principalId',d.principal_id,'requestId',d.request_id,'decidedAt',d.decided_at,'verdict',d.verdict,'channel',d.channel),d.occurrence_id
  FROM safety_decisions d WHERE d.session_id=?)
  ORDER BY length(sequence),sequence LIMIT ?`).all(sessionId,sessionId,limit) as RecordRow[];
 const result:ReturnType<typeof safetyRecords>=[];let bytes=0;
 for(const r of rows){const item={id:r.id,sequence:r.sequence,kind:r.kind,state:r.state,detailPruned:!!r.detail_pruned,occurrenceId:r.occurrence_id,payload:JSON.parse(r.payload)};
  const size=Buffer.byteLength(JSON.stringify(item));if(bytes+size>262144)break;bytes+=size;result.push(item);}
 return result;
}

/** Compatibility producers are explicit uninstrumented epochs, never clean. */
export function ensureSafetyEventCollection(db:Database,row:GovernanceEventRow):string {
 const turnId=row.turnId??`unbound_${crypto.randomUUID()}`;
 if(db.query("SELECT 1 FROM safety_retired_turns WHERE turn_id=?").get(turnId))throw new ChatRetiredError();
 let c=collection(db,turnId);
 if(!c){const id=crypto.randomUUID();beginSafetyCollection(db,{turnId,bindingId:id,principalId:null,sessionId:null,backendId:"unknown",at:row.at});
  db.query("UPDATE safety_collections SET session_id=?,gap='uninstrumented_backend_input' WHERE id=?").run(row.sessionId&&db.query("SELECT 1 FROM sessions WHERE id=?").get(row.sessionId)?row.sessionId:null,id);c=collection(db,turnId)!;}
 return c.turn_id;
}

/** Explicit host recovery after producers have stopped. Clears infrastructure
 * failure only; historical gaps and unresolved identities never become clean. */
export function recoverSafetyRecording(db:Database):void {
 const local=safetyQueue(db);
 if(local.pending.size||local.inflight)throw new SafetyUnavailable("Stop all safety producers before recovery");
 db.transaction(()=>{
  if(one<{n:number}>(db,"SELECT COUNT(*) n FROM safety_collections WHERE ended=0").n)throw new SafetyUnavailable("Stop all safety producers before recovery");
  const totals=meta(db);
  if(totals.used_rows+totals.scope_rows>=SAFETY_LIMITS.brainRows||totals.used_bytes+totals.scope_bytes>=SAFETY_LIMITS.brainBytes)throw new SafetyUnavailable("Safety capacity must be recovered first");
  // Reservations on ended epochs could never have released input: the event
  // and reservation consumption commit together. Retain the historical gap.
  if(local.unscopedLoss)db.query("UPDATE safety_collections SET gap=COALESCE(gap,'recording_failed_recovered')").run();
  else for(const turnId of local.lostTurns)db.query("UPDATE safety_collections SET gap=COALESCE(gap,'recording_failed_recovered') WHERE turn_id=?").run(turnId);
  db.query("UPDATE safety_collections SET gap=COALESCE(gap,'recording_failed_recovered') WHERE id IN (SELECT collection_id FROM safety_pending) OR failure IS NOT NULL").run();
  db.query("DELETE FROM safety_pending").run();
  db.query("UPDATE safety_emergency_reserve SET padding=zeroblob(65536) WHERE singleton=1").run();
  db.query("UPDATE safety_meta SET failed=0,reason=NULL WHERE singleton=1").run();advance(db);
 }).immediate();
 local.failed=false;local.lostTurns.clear();local.unscopedLoss=false;
}
