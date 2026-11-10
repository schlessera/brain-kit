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
  sessionId: string | null; backendId: string; sourceSessionId?: string; policyHash?: string|null; at: number;
  /** Begin under the brain-wide restriction: a permanent gap before any delivery. */
  restricted?: boolean }
interface Collection { id: string; turn_id: string; session_id: string | null; principal_id: string | null; history_owner_id: string | null;
  generation: string; backend_id: string; started_at: number; ended: number; acknowledged: string; gap: string | null; failure: string | null;
  policy_hash:string|null; start_revision: string; end_revision: string | null; restricted_begin: number; failure_cause: string | null }
interface Session { session_id: string; history_owner_id: string; generation: string; principal_id: string | null;
  classification: string; origin_turn: string | null; backend_id: string | null }
export class SafetyUnavailable extends Error { constructor(message: string) { super(message); } }
/** What a capacity refusal spent, so a refusal can say what frees it: `turn`
 * room frees itself (pending writes settle, or only this one record is too
 * big); `chat` room is that chat's for good; `brain` room is the server's. */
export type SafetyCapacityScope = "turn"|"chat"|"brain";
/** A capacity check refused the write. Only this class latches as `capacity`. */
export class SafetyCapacityExhausted extends SafetyUnavailable {
  constructor(message: string, readonly scope: SafetyCapacityScope) { super(message); }
}
/**
 * A turn refused before any of its input reached the model, because its
 * safety record could not be written. Nothing ran and nothing is latched, so
 * a retry can succeed. `paused` means the brain-wide recorder is failed and
 * even the restricted begin could not commit: the one case that refuses a
 * turn outright instead of running it restricted (#3812).
 */
export class SafetyRecordingUnavailable extends Error {
  readonly code = "safety_recording_unavailable";
  readonly beforeDelivery = true;
  /** A capacity check refused it: retrying waits for room, not for luck. */
  readonly capacity: boolean;
  /** Room retrying can never free: this chat's, or the whole brain's. It
   * outranks `paused`: recovery cannot make room either. */
  readonly full: "chat"|"brain"|null;
  constructor(readonly paused: boolean, cause?: unknown) {
    const capacity = cause instanceof SafetyCapacityExhausted || (cause as { name?: string } | null)?.name === "SafetyCapacityExhausted";
    // The scope is an own field, so it survives the write worker's boundary.
    const scope = capacity ? (cause as { scope?: unknown }).scope : undefined;
    const full = scope === "chat" || scope === "brain" ? scope : null;
    super(full === "chat" ? `This chat has no room left for safety records (${(cause as Error).message}), so this turn could not start. Nothing was sent. Start a new chat to continue.`
      : full === "brain" ? `This server has no room left for safety records (${(cause as Error).message}), so this turn could not start. Nothing was sent, and retrying or a new chat won't help.`
      : paused ? "Safety recording is paused on this server, so this turn could not start. Nothing was sent. The server recovers it automatically."
      : capacity ? `Safety recording has no room left (${(cause as Error).message}). Nothing was sent; try again shortly.`
      : "Safety recording failed before anything was sent. Nothing ran; try again.", { cause });
    this.capacity = capacity;
    this.full = full;
  }
}
const one = <T>(db: Database, sql: string, ...args: (string | number | null)[]) => db.query(sql).get(...args) as T;
const collection = (db: Database, turn: string) => one<Collection | null>(db,"SELECT * FROM safety_collections WHERE turn_id=?",turn);
const meta = (db: Database) => one<{revision:string;failed:number;reason:string|null;used_rows:number;used_bytes:number;scope_rows:number;scope_bytes:number}>(db,"SELECT * FROM safety_meta WHERE singleton=1");
export function advance(db: Database): string {
  const old=BigInt(meta(db).revision);
  if(old>=MAX_REVISION) throw new SafetyCapacityExhausted("Safety revision exhausted","brain");
  const next=String(old+1n); db.query("UPDATE safety_meta SET revision=? WHERE singleton=1").run(next); return next;
}

/** Where a safety-recording failure was raised. */
export type SafetyFailureSite = "safetyBegin"|"safetyReserve"|"safetyCommit"|"record"|"safetyFail"|"safetyEnd"|"migrate"|"boot-pending"|"boot-obligation";
export type SafetyFailureReason = "recording_failed"|"capacity";
/** A failure's cause: identifiers and error text only, never message content. */
export interface SafetyFailureCause { errorClass:string; message:string; stack:string|null; site:SafetyFailureSite; turnId:string|null; at:number }
const clip=(text:string,bytes:number)=>{const buffer=Buffer.from(text);return buffer.length<=bytes?text:buffer.subarray(0,bytes).toString().replace(/�+$/,"");};
export function safetyFailureCause(error:unknown,site:SafetyFailureSite,turnId:string|null,at=Date.now()):SafetyFailureCause {
  const value=error instanceof Error?error:new Error(String(error));
  const named=value.constructor?.name;
  return {errorClass:clip(named&&named!=="Error"?named:value.name||"Error",128),message:clip(value.message,512),
    stack:value.stack?clip(value.stack.split("\n").slice(1,9).map(line=>line.trim()).join("\n"),2048):null,site,turnId,at};
}
/** Honest classification: `capacity` only when a capacity check refused the write. */
export function safetyFailureReason(error:unknown):SafetyFailureReason {
  // The name survives the write worker's boundary; only this module's class carries it.
  return error instanceof SafetyCapacityExhausted||(error as {name?:unknown}|null)?.name==="SafetyCapacityExhausted"?"capacity":"recording_failed";
}
/** One structured stderr line per latch, restriction or recovery. */
export function logSafetyRecording(body:string,attributes:Record<string,string|number|null>):void {
  try{process.stderr.write(`${JSON.stringify({severityText:body.includes("recovered")?"WARN":"ERROR",body,attributes})}\n`);}catch{/* Logging never changes containment. */}
}
const causeAttributes=(scope:string,reason:string,cause:SafetyFailureCause)=>({"safety.scope":scope,"safety.reason":reason,"safety.site":cause.site,
  "safety.turn_id":cause.turnId,"error.class":cause.errorClass,"error.message":cause.message});

/** Chat scope: marks only this turn's collection failed, with its first cause.
 * Returns false when the turn has no collection to carry the fact. */
export function failSafetyCollection(db:Database,turnId:string,reason:SafetyFailureReason,cause:SafetyFailureCause):boolean {
  const marked=db.transaction(()=>{
    const c=collection(db,turnId);if(!c)return false;
    db.query(`UPDATE safety_collections SET failure=CASE WHEN failure='capacity' THEN failure ELSE ? END,
      failure_cause=COALESCE(failure_cause,?) WHERE id=?`).run(reason,JSON.stringify(cause),c.id);
    advance(db);return true;
  }).immediate();
  if(marked)logSafetyRecording("safety recording failed for one chat",causeAttributes("chat",reason,cause));
  return marked;
}
/** Brain scope: the evidence store could not take a scoped fact. Uses the
 * emergency cells allocated before ingestion, never appended at overflow.
 * The first cause is kept; later latches only count. */
export function latchSafety(db:Database,turnId:string|null,reason:SafetyFailureReason,cause:SafetyFailureCause=safetyFailureCause(new Error("Safety recording latched"),"safetyFail",turnId),unscoped=false):void {
  db.transaction(()=>{
    db.query("UPDATE safety_emergency_reserve SET padding=zeroblob(0) WHERE singleton=1").run();
    db.query("UPDATE safety_meta SET failed=1,reason=CASE WHEN reason='capacity' THEN reason ELSE ? END WHERE singleton=1").run(reason);
    db.query(`INSERT INTO safety_latch(singleton,since,reason,site,turn_id,error_class,message,stack,unscoped,revision) VALUES(1,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(singleton) DO UPDATE SET count=count+1,unscoped=MAX(unscoped,excluded.unscoped)`).run(cause.at,reason,cause.site,cause.turnId,cause.errorClass,cause.message,cause.stack,unscoped?1:0,meta(db).revision);
    if(turnId) db.query("UPDATE safety_collections SET failure=CASE WHEN failure='capacity' THEN failure ELSE ? END,failure_cause=COALESCE(failure_cause,?) WHERE turn_id=?").run(reason,JSON.stringify(cause),turnId);
    if(BigInt(meta(db).revision)<MAX_REVISION)advance(db);
  }).immediate();
  logSafetyRecording("safety recording latched for the brain",causeAttributes("brain",reason,cause));
}
/** Contain a failure at the narrowest scope that durably takes it: the turn's
 * chat, else the brain. Throws only when neither fact could commit. */
export function recordSafetyFailure(db:Database,turnId:string|null,error:unknown,site:SafetyFailureSite,sessionId:string|null=null):"chat"|"brain" {
  const reason=safetyFailureReason(error),cause=safetyFailureCause(error,site,turnId);
  try {
    if(turnId&&failSafetyCollection(db,turnId,reason,cause))return "chat";
    if(sessionId&&failSafetySession(db,turnId,sessionId,reason,cause))return "chat";
  } catch(scoped) { cause.message=clip(`${cause.message}; chat fact failed: ${scoped instanceof Error?scoped.message:String(scoped)}`,512); }
  // No collection names the chat: the latch itself must remember that every
  // collection needs a gap, durably, so no recovery can clear it narrower.
  latchSafety(db,turnId,reason,cause,!(turnId&&collection(db,turnId)));
  return "brain";
}
/** A loss with no collection of its own, in a known chat: give that chat a
 * failed epoch, so its gap is durable without latching the brain. */
function failSafetySession(db:Database,turnId:string|null,sessionId:string,reason:SafetyFailureReason,cause:SafetyFailureCause):boolean {
  return db.transaction(()=>{
    if(!db.query("SELECT 1 FROM sessions WHERE id=?").get(sessionId))return false;
    const owned=turnId??`lost_${crypto.randomUUID().replaceAll("-","")}`;
    ensureSafetyEventCollection(db,{sessionId,turnId:owned,at:cause.at} as GovernanceEventRow);
    if(!failSafetyCollection(db,owned,reason,cause))return false;
    if(!turnId)db.query("UPDATE safety_collections SET ended=1,end_revision=COALESCE(end_revision,?) WHERE turn_id=?").run(advance(db),owned);
    return true;
  }).immediate();
}
function live(db:Database,c:Collection,reserved=false):void {
  assertLive(db,[["session",c.session_id],["dialogue_owner",c.history_owner_id]]);
  const owner=c.history_owner_id?one<{generation:number}|null>(db,"SELECT generation FROM dialogue_owners WHERE id=?",c.history_owner_id):null;
  if(owner&&String(owner.generation)!==c.generation)throw new SafetyUnavailable("Safety history generation changed");
  if(c.ended)throw new SafetyUnavailable("Safety collection ended; late input refused");
  // A collection begun restricted already carries its permanent gap: the
  // brain-wide latch cannot make its evidence any less complete.
  if(!reserved&&(c.failure||(meta(db).failed&&!c.restricted_begin)))throw new SafetyUnavailable("Safety collection requires recovery");
}
/** Room for collections not yet in a chat frees itself as open ones bind to
 * their chats and pending writes settle. Only ended unbound collections hold
 * it for good: the brain's room is spent only when they alone leave no room
 * for one more collection. */
function unboundScope(db:Database):SafetyCapacityScope {
  const ended=one<{n:number;bytes:number}>(db,`SELECT COUNT(*) n,COALESCE((SELECT SUM(r.reserved_bytes) FROM safety_records r
    JOIN safety_collections c ON c.id=r.collection_id WHERE c.session_id IS NULL AND c.ended=1),0) bytes
    FROM safety_collections WHERE session_id IS NULL AND ended=1`);
  return ended.n>=SAFETY_LIMITS.unbound||ended.bytes+(ended.n+1)*2048>SAFETY_LIMITS.unboundBytes?"brain":"turn";
}
function capacity(db:Database,c:Collection,rows:number,bytes:number):void {
  const all=meta(db);
  const {scope,args}=safetyScope(db,c.turn_id,c.session_id);
  const used=one<{rows:number;bytes:number}>(db,`SELECT COALESCE(SUM(r.reserved_rows),0) rows,COALESCE(SUM(r.reserved_bytes),0) bytes
    FROM safety_records r JOIN safety_collections c ON c.id=r.collection_id WHERE ${scope}`,...args);
  const pending=one<{rows:number;bytes:number}>(db,`SELECT COALESCE(SUM(p.rows),0) rows,COALESCE(SUM(p.reserved_bytes),0) bytes FROM safety_pending p`);
  const localPending=one<{rows:number;bytes:number}>(db,`SELECT COALESCE(SUM(p.rows),0) rows,COALESCE(SUM(p.reserved_bytes),0) bytes
    FROM safety_pending p JOIN safety_collections c ON c.id=p.collection_id WHERE ${scope}`,...args);
  // Room held only by pending writes frees itself as they settle.
  if(all.used_rows+all.scope_rows+rows>SAFETY_LIMITS.brainRows||all.used_bytes+all.scope_bytes+bytes>SAFETY_LIMITS.brainBytes)
    throw new SafetyCapacityExhausted("Safety ledger capacity exhausted","brain");
  if(used.rows+rows>SAFETY_LIMITS.sessionRows||used.bytes+bytes>SAFETY_LIMITS.sessionBytes)
    throw new SafetyCapacityExhausted("Safety ledger capacity exhausted","chat");
  if(all.used_rows+all.scope_rows+pending.rows+rows>SAFETY_LIMITS.brainRows||all.used_bytes+all.scope_bytes+pending.bytes+bytes>SAFETY_LIMITS.brainBytes
    ||used.rows+localPending.rows+rows>SAFETY_LIMITS.sessionRows||used.bytes+localPending.bytes+bytes>SAFETY_LIMITS.sessionBytes)
    throw new SafetyCapacityExhausted("Safety ledger capacity exhausted","turn");
  if(c.session_id===null){
    const unbound=one<{bytes:number}>(db,`SELECT COALESCE(SUM(r.reserved_bytes),0) bytes FROM safety_records r
      JOIN safety_collections c ON c.id=r.collection_id WHERE c.session_id IS NULL`);
    if(unbound.bytes+pending.bytes+bytes+one<{n:number}>(db,"SELECT COUNT(*) n FROM safety_collections WHERE session_id IS NULL").n*2048>SAFETY_LIMITS.unboundBytes)throw new SafetyCapacityExhausted("Safety unbound byte capacity exhausted",unboundScope(db));
  }
}
/** Must commit before any first-turn bytes or tool execution. Callbacks cannot create a session. */
export function beginSafetyCollection(db:Database,input:SafetyCollectionInput):string {
 return db.transaction(()=>{
  for(const id of [input.turnId,input.bindingId,input.backendId,input.sessionId,input.historyOwnerId,input.principalId]){
    if(id!==null&&id!==undefined&&!/^[A-Za-z0-9_-]{1,128}$/.test(id))throw new SafetyUnavailable("Invalid bounded safety identity");
  }
  if(!Number.isSafeInteger(input.at)||input.at<0)throw new SafetyUnavailable("Invalid safety clock");
  // While the brain-wide recorder is failed, a new turn still runs, restricted:
  // its collection carries a permanent gap before any input is delivered, so
  // nothing it loses can ever make its chat look complete (#3812).
  const restricted=!!input.restricted||!!meta(db).failed;
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
  if(n.n>=(input.sessionId?SAFETY_LIMITS.epochs:SAFETY_LIMITS.unbound))throw new SafetyCapacityExhausted("Safety coverage capacity exhausted",input.sessionId?"chat":unboundScope(db));
  if(input.sessionId===null){
    const unbound=one<{bytes:number}>(db,`SELECT COALESCE(SUM(r.reserved_bytes),0) bytes FROM safety_records r JOIN safety_collections c ON c.id=r.collection_id WHERE c.session_id IS NULL`);
    const pending=one<{bytes:number}>(db,`SELECT COALESCE(SUM(p.reserved_bytes),0) bytes FROM safety_pending p JOIN safety_collections c ON c.id=p.collection_id WHERE c.session_id IS NULL`);
    if(unbound.bytes+pending.bytes+(n.n+1)*2048>SAFETY_LIMITS.unboundBytes)throw new SafetyCapacityExhausted("Safety unbound byte capacity exhausted",unboundScope(db));
  }
  const ledger=meta(db),pending=one<{rows:number;bytes:number}>(db,"SELECT COALESCE(SUM(rows),0) rows,COALESCE(SUM(reserved_bytes),0) bytes FROM safety_pending");
  if(ledger.used_rows+ledger.scope_rows+pending.rows+1>SAFETY_LIMITS.brainRows||ledger.used_bytes+ledger.scope_bytes+pending.bytes+2048>SAFETY_LIMITS.brainBytes)
    throw new SafetyCapacityExhausted("Safety identity capacity exhausted",ledger.used_rows+ledger.scope_rows+1>SAFETY_LIMITS.brainRows||ledger.used_bytes+ledger.scope_bytes+2048>SAFETY_LIMITS.brainBytes?"brain":"turn");
  if(owner&&one<{n:number}>(db,"SELECT COUNT(*) n FROM safety_collections WHERE history_owner_id=? AND generation=?",owner,generation).n>=128)throw new SafetyCapacityExhausted("Safety coverage capacity exhausted","chat");
  if(input.policyHash!==undefined&&input.policyHash!==null&&!/^[a-f0-9]{64}$/.test(input.policyHash))throw new SafetyUnavailable("Invalid safety policy hash");
  const gap=restricted?"recording_failed":uncollectedOwner?"missing_history_owner_collection":input.sessionId&&!session?.principal_id?"unknown_history_owner":session?.backend_id&&session.backend_id!==input.backendId?"backend_history_not_reconstructed":null;
  db.query(`INSERT INTO safety_collections(id,turn_id,session_id,principal_id,history_owner_id,generation,backend_id,started_at,gap,start_revision)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(input.bindingId,input.turnId,input.sessionId,input.principalId,owner,generation,input.backendId,input.at,gap,advance(db));
  db.query("UPDATE safety_collections SET policy_hash=?,restricted_begin=? WHERE id=?").run(input.policyHash??null,restricted?1:0,input.bindingId);
  db.query("UPDATE safety_meta SET scope_rows=scope_rows+1,scope_bytes=scope_bytes+2048 WHERE singleton=1").run();
  if(input.sessionId)bindSafetyCollection(db,input.turnId,input.sessionId);
  if(input.sourceSessionId){
    const sourceOwner=one<{principal_id:string|null}|null>(db,"SELECT principal_id FROM safety_sessions WHERE session_id=?",input.sourceSessionId);
    if(sourceOwner?.principal_id&&sourceOwner.principal_id!==input.principalId)throw new SafetyUnavailable("Safety fork history ownership mismatch");
    safetyProjection(db,null,input.sourceSessionId); // Also validates retirement.
    db.query("UPDATE safety_collections SET gap=CASE WHEN restricted_begin=1 THEN gap ELSE 'inherited_history_not_reconstructed' END WHERE id=?").run(input.bindingId);
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
 if(epochs.n>128)throw new SafetyCapacityExhausted("Safety binding coverage capacity exhausted","chat");
 const totals=one<{rows:number;bytes:number}>(db,`SELECT COALESCE(SUM(r.reserved_rows),0) rows,COALESCE(SUM(r.reserved_bytes),0) bytes FROM safety_records r
  JOIN safety_collections c ON c.id=r.collection_id WHERE ${scope}`,...args);
 const pending=one<{rows:number;bytes:number;count:number;serializedBytes:number}>(db,`SELECT COALESCE(SUM(p.rows),0) rows,COALESCE(SUM(p.reserved_bytes),0) bytes,
  COUNT(*) count,COALESCE(SUM(p.bytes),0) serializedBytes FROM safety_pending p
  JOIN safety_collections c ON c.id=p.collection_id WHERE ${scope}`,...args);
 if(totals.rows+pending.rows>SAFETY_LIMITS.sessionRows||totals.bytes+pending.bytes>SAFETY_LIMITS.sessionBytes)
  throw new SafetyCapacityExhausted("Safety binding capacity exhausted",totals.rows>SAFETY_LIMITS.sessionRows||totals.bytes>SAFETY_LIMITS.sessionBytes?"chat":"turn");
 if(pending.count>SAFETY_LIMITS.sessionPending||pending.serializedBytes>SAFETY_LIMITS.sessionPendingBytes)throw new SafetyCapacityExhausted("Safety binding pending capacity exhausted","turn");
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
 if(bytes>SAFETY_LIMITS.occurrenceBytes)throw new SafetyCapacityExhausted("Safety occurrence byte limit exceeded","turn");
 const previous=one<RecordRow|null>(db,"SELECT * FROM safety_records WHERE id=?",id);
 if(previous){if(previous.collection_id!==c.id||(previous.detail_pruned ? previous.payload!==JSON.stringify({sha256:new Bun.CryptoHasher("sha256").update(json).digest("hex")}) : previous.payload!==json))throw new SafetyUnavailable("Conflicting safety occurrence identity");return;}
 const rows=kind==="occurrence"?(state==="finalized"?2:4):0,
   reserved=kind==="occurrence"?bytes+VERDICT_BYTES+(state==="finalized"?0:2*TERMINAL_BYTES):0;
 if(kind==="exposure"&&bytes>TERMINAL_BYTES)throw new SafetyCapacityExhausted("Safety terminal reserve exceeded","turn");
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
/** A collection may hold this many calls that still owe their results. */
const OBLIGATIONS = 2048;
const clipText=(text:string)=>clip(text.replace(/[\u0000-\u001f\u007f]/g," "),128);
/**
 * A tool call admitted before it runs owes its result's record (#3812). It
 * is owed until that record is durable; no refusal discharges it, since none
 * proves an admitted call did not run. Owing it is restrictive only: it needs
 * no healthy recorder, only an open collection to gap if the result never
 * comes.
 */
export function openSafetyObligation(db:Database,turnId:string,id:string,toolUseId:string,tool:string,at=Date.now()):void {
 db.transaction(()=>{
  if(!/^[A-Za-z0-9_-]{1,128}$/.test(id))throw new SafetyUnavailable("Invalid safety obligation identity");
  const c=collection(db,turnId);if(!c)throw new SafetyUnavailable("Safety obligation requires a collection");
  live(db,c,true);
  const prior=one<{collection_id:string}|null>(db,"SELECT collection_id FROM safety_obligations WHERE id=?",id);
  if(prior){if(prior.collection_id!==c.id)throw new SafetyUnavailable("Conflicting safety obligation");return;}
  if(one<{n:number}>(db,"SELECT COUNT(*) n FROM safety_obligations WHERE collection_id=?",c.id).n>=OBLIGATIONS)
   throw new SafetyCapacityExhausted("Safety obligation capacity exhausted","turn");
  db.query("INSERT INTO safety_obligations(id,collection_id,tool_use_id,tool,opened_at) VALUES(?,?,?,?,?)").run(id,c.id,clipText(toolUseId),clipText(tool),at);
 }).immediate();
}
/** Its result is durably recorded. Once the collection ended the call's gap
 * is already committed: nothing to do. */
export function dischargeSafetyObligation(db:Database,turnId:string,id:string):void {
 db.query("DELETE FROM safety_obligations WHERE id=? AND collection_id=(SELECT id FROM safety_collections WHERE turn_id=? AND ended=0)").run(id,turnId);
}
/** Every call still owing its result in these collections becomes their
 * chats' permanent gap, naming the first such call. Returns the causes. */
function gapOwedResults(db:Database,collectionId:string|null,site:SafetyFailureSite):SafetyFailureCause[] {
 // With one MIN(), SQLite takes the bare columns from that first-opened row.
 const owed=db.query<{collection_id:string;turn_id:string;n:number;tool:string;tool_use_id:string},[string|null,string|null]>(`SELECT o.collection_id,c.turn_id,COUNT(*) n,MIN(o.rowid) first,o.tool,o.tool_use_id
  FROM safety_obligations o JOIN safety_collections c ON c.id=o.collection_id WHERE ? IS NULL OR o.collection_id=? GROUP BY o.collection_id`).all(collectionId,collectionId);
 const causes:SafetyFailureCause[]=[];
 for(const row of owed){
  const cause=safetyFailureCause(new SafetyUnavailable(`A tool result was never recorded: ${row.tool} (${row.tool_use_id})${row.n>1?` and ${row.n-1} more`:""}`),site,row.turn_id);
  db.query("UPDATE safety_collections SET failure=COALESCE(failure,'recording_failed'),failure_cause=COALESCE(failure_cause,?) WHERE id=?").run(JSON.stringify(cause),row.collection_id);
  db.query("DELETE FROM safety_obligations WHERE collection_id=?").run(row.collection_id);
  causes.push(cause);
 }
 return causes;
}
const logOwed=(causes:SafetyFailureCause[])=>{for(const cause of causes)logSafetyRecording("safety recording failed for one chat",causeAttributes("chat","recording_failed",cause));};
export function endSafetyCollection(db:Database,turnId:string):void {
 const owed=db.transaction(()=>{const c=collection(db,turnId);if(!c||c.ended)return [];
 // Lost/incomplete hooks leave exposures open and therefore unresolved.
 db.query("UPDATE safety_collections SET ended=1,end_revision=? WHERE id=?").run(advance(db),c.id);
 // A reservation still open at the end can never commit: an ended epoch
 // refuses late input. Its possibly delivered input becomes this chat's
 // permanent gap, so the chat runs restricted instead of staying pending.
 if(one<{n:number}>(db,"SELECT COUNT(*) n FROM safety_pending WHERE collection_id=?",c.id).n){
  db.query("UPDATE safety_collections SET failure=COALESCE(failure,'recording_failed'),gap=COALESCE(gap,'recording_failed_recovered') WHERE id=?").run(c.id);
  db.query("DELETE FROM safety_pending WHERE collection_id=?").run(c.id);
 }
 // A call that still owes its result may have run, and the runtime may keep
 // its output in its session, whether the turn was cancelled, aborted or
 // never got a result hook. Nothing records it now: its chat keeps the gap.
 return gapOwedResults(db,c.id,"safetyEnd");
 }).immediate();
 logOwed(owed);
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
 const owed=db.transaction(()=>{
  const n=one<{n:number}>(db,"SELECT COUNT(*) n FROM safety_collections WHERE ended=0").n;
  if(n){db.query("UPDATE safety_collections SET gap=COALESCE(gap,'host_restart_unknown'),ended=1,end_revision=? WHERE ended=0").run(advance(db));}
  // A call that owed its result when the process died may have run: its
  // chat keeps the gap, as if its collection had ended with it owed.
  const owed=gapOwedResults(db,null,"boot-obligation");
  if(owed.length&&!n)advance(db);
  if(one<{n:number}>(db,"SELECT COUNT(*) n FROM safety_pending").n)
   latchSafety(db,null,"recording_failed",safetyFailureCause(new SafetyUnavailable("Safety reservations were pending at restart"),"boot-pending",null));
  return owed;
 }).immediate();
 logOwed(owed);
}
/** Prune only display bytes; identity, counts and reserved audit capacity survive. */
export function pruneSafetyDetail(db:Database,before:number):number {
 return db.transaction(()=>{
   const rows=db.query("SELECT id,payload FROM safety_records WHERE observed_at<? AND detail_pruned=0 LIMIT 1000").all(before) as {id:string;payload:string}[];
   for(const row of rows)db.query("UPDATE safety_records SET payload=?,detail_pruned=1 WHERE id=?").run(JSON.stringify({sha256:new Bun.CryptoHasher("sha256").update(row.payload).digest("hex")}),row.id);
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
  throw new SafetyCapacityExhausted("Safety pending capacity exhausted","turn");
 const rows=terminalOccurrenceId?0:4,reserved=terminalOccurrenceId?0:bytes+VERDICT_BYTES+2*TERMINAL_BYTES;
 capacity(db,c,rows,reserved);
 db.query("INSERT INTO safety_pending VALUES(?,?,?,?,?)").run(requestId,c.id,bytes,rows,reserved);advance(db);
 }).immediate();
}
export function releaseSafetyWrite(db:Database,id:string):void {db.query("DELETE FROM safety_pending WHERE id=?").run(id);advance(db);}
/** Appends legacy taint rows. A row that cannot be appended gives its turn a
 * permanent gap instead; only when even that fails is the brain latched.
 * Returns false while some legacy row has neither its record nor its gap. */
export function migrateSafetyHistory(db:Database):boolean {
 let complete=true;
 type Legacy={id:number;session_id:string|null;turn_id:string|null;at:number;kind:"taint";payload:string;schema_version:number;actor:GovernanceEventRow["actor"];model:string|null;profile:GovernanceEventRow["profile"];dedupe_key:string|null};
 let after=0;
 for(;;){
  const rows=db.query<Legacy,[number]>(`SELECT g.* FROM governance_events g WHERE g.kind='taint' AND g.id>?
    AND NOT EXISTS(SELECT 1 FROM safety_legacy_events m WHERE m.event_id=g.id)
    AND NOT EXISTS(SELECT 1 FROM safety_retired_turns t WHERE t.turn_id=g.turn_id)
    AND NOT EXISTS(SELECT 1 FROM chat_retired_identities t WHERE t.kind='session' AND t.id=g.session_id) ORDER BY g.id LIMIT 100`).all(after);
  if(!rows.length)return complete;
  for(const r of rows){try{db.transaction(()=>{
    const recordId=appendSafetyEvent(db,{sessionId:r.session_id,turnId:r.turn_id,at:r.at,kind:r.kind,payload:r.payload,version:r.schema_version,actor:r.actor,model:r.model,profile:r.profile,dedupeKey:r.dedupe_key});
    db.query("INSERT INTO safety_legacy_events VALUES(?,?)").run(r.id,recordId!);
   }).immediate();}catch(error){
    const turnId=r.turn_id??`legacy_event_${r.id}`,reason=safetyFailureReason(error),cause=safetyFailureCause(error,"migrate",turnId);
    try{db.transaction(()=>{
      ensureSafetyEventCollection(db,{sessionId:r.session_id,turnId,at:r.at,kind:r.kind,payload:r.payload,version:r.schema_version,actor:r.actor,model:r.model,profile:r.profile,dedupeKey:r.dedupe_key});
      failSafetyCollection(db,turnId,reason,cause);
      db.query("UPDATE safety_collections SET ended=1,end_revision=COALESCE(end_revision,?) WHERE turn_id=?").run(advance(db),turnId);
     }).immediate();}
    catch(scoped){
      if(scoped instanceof ChatRetiredError){after=r.id;continue;}
      complete=false;
      try{latchSafety(db,r.turn_id,reason,cause,true);}catch{/* The unmigrated row is retried; the next boot latches again. */}
      return complete;
    }
   }
   after=r.id;}
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

export type SafetyRecoveryTrigger = "boot"|"automatic"|"owner";
export interface SafetyRecovery { recovered:boolean; trigger:SafetyRecoveryTrigger; actor:string; at:number; gapped:number; cause:SafetyLatchCause|null }
export interface SafetyLatchCause { reason:string; site:string; turnId:string|null; errorClass:string; message:string; stack:string|null; since:number; count:number }
const latchCause=(db:Database):SafetyLatchCause|null=>{
 const row=one<{since:number;reason:string;site:string;turn_id:string|null;error_class:string;message:string;stack:string|null;count:number}|null>(db,"SELECT * FROM safety_latch WHERE singleton=1");
 return row?{reason:row.reason,site:row.site,turnId:row.turn_id,errorClass:row.error_class,message:row.message,stack:row.stack,since:row.since,count:row.count}:null;
};
/** What the owner sees about the brain-wide recorder (#3810). `cause.durable`
 * is false while only this process holds it, its notice not yet committed. */
export interface SafetyRecordingStatus { latched:boolean; since:number|null; reason:string|null; cause:(SafetyLatchCause&{durable:boolean})|null; retained:boolean; lastRecovery:Omit<SafetyRecovery,"recovered">|null }
export function safetyRecordingStatus(db:Database):SafetyRecordingStatus {
 return Database.prototype.transaction.call(db,()=>{
  const m=meta(db),local=safetyQueue(db),durable=latchCause(db),lost=local.lossCause;
  const cause=durable?{...durable,durable:true}:local.failed&&lost?{reason:"recording_failed",site:lost.site,turnId:lost.turnId,
   errorClass:lost.errorClass,message:lost.message,stack:null,since:lost.at,count:lost.count,durable:false}:null;
  const last=one<{at:number;trigger:SafetyRecoveryTrigger;actor:string;cause:string|null;gapped:number}|null>(db,"SELECT * FROM safety_recoveries ORDER BY id DESC LIMIT 1");
  return {latched:!!m.failed||local.failed,since:cause?.since??null,reason:m.failed?(m.reason??"recording_failed"):local.failed?"recording_failed":null,cause,
   retained:local.failed&&!m.failed,
   lastRecovery:last?{trigger:last.trigger,actor:last.actor,at:last.at,gapped:last.gapped,cause:last.cause?JSON.parse(last.cause) as SafetyLatchCause:null}:null};
 }).deferred() as SafetyRecordingStatus;
}

/**
 * Clears the brain-wide recorder failure once its gap facts are durable.
 * Historical gaps and unresolved identities never become clean: every turn
 * whose evidence may be lost keeps a permanent `recording_failed_recovered`
 * gap, so its chat stays restricted until reviewed.
 *
 * `owner` and `boot` recovery require every producer to have stopped.
 * `automatic` recovery runs beside turns begun restricted after the latch it
 * clears, each with a permanent gap. Every other producer was in flight when
 * that latch was set, failed or not, or begun restricted under an earlier
 * latch, and must end first (#3812).
 */
export function recoverSafetyRecording(db:Database,options:{trigger?:SafetyRecoveryTrigger;actor?:string}={}):SafetyRecovery {
 const local=safetyQueue(db),trigger=options.trigger??"owner",actor=options.actor??"host",at=Date.now();
 const automatic=trigger==="automatic";
 // The earliest latch still set, durable or in process. A producer begun
 // restricted under an earlier, recovered latch predates this one.
 const since=()=>{
  const durable=one<{revision:string}|null>(db,"SELECT revision FROM safety_latch WHERE singleton=1")?.revision;
  const marks=[durable,local.failed?local.latchRevision??MAX_REVISION.toString():undefined].filter((r):r is string=>r!==undefined).map(r=>BigInt(r));
  return marks.length?marks.reduce((a,b)=>a<b?a:b):null;
 };
 const begunRestricted=(c:{restricted_begin:number;start_revision:string}|null,latch:bigint|null)=>!!c?.restricted_begin&&(latch===null||BigInt(c.start_revision)>latch);
 const collectionOf=(turnId:string|null)=>turnId===null?null:one<{restricted_begin:number;start_revision:string}|null>(db,"SELECT restricted_begin,start_revision FROM safety_collections WHERE turn_id=?",turnId);
 if(automatic?(()=>{const latch=since();return [...local.pending].some(p=>!begunRestricted(collectionOf(p.turnId),latch));})():(local.pending.size||local.inflight))
  throw new SafetyUnavailable("Stop all safety producers before recovery");
 let cause:SafetyLatchCause|null=null,gapped=0,recovered=false;
 db.transaction(()=>{
  const open=db.query<{restricted_begin:number;start_revision:string},[]>("SELECT restricted_begin,start_revision FROM safety_collections WHERE ended=0").all();
  const latch=since();
  if(automatic?open.some(c=>!begunRestricted(c,latch)):open.length)
   throw new SafetyUnavailable("Stop all safety producers before recovery");
  const totals=meta(db);
  if(!totals.failed&&!local.failed&&!one<{n:number}>(db,"SELECT COUNT(*) n FROM safety_pending").n)return;
  if(totals.used_rows+totals.scope_rows>=SAFETY_LIMITS.brainRows||totals.used_bytes+totals.scope_bytes>=SAFETY_LIMITS.brainBytes)throw new SafetyCapacityExhausted("Safety capacity must be recovered first","brain");
  const lost=local.lossCause;
  cause=latchCause(db)??(local.failed?{reason:"recording_failed",site:lost?.site??"retained",turnId:lost?.turnId??null,errorClass:lost?.errorClass??"SafetyUnavailable",
   message:lost?`${lost.message} (retained in process; its durable notice could not commit)`:"Only this process retained the loss; its durable notice could not commit.",
   stack:null,since:lost?.at??at,count:lost?.count??1}:null);
  const unscoped=local.unscopedLoss||!!one<{unscoped:number}|null>(db,"SELECT unscoped FROM safety_latch WHERE singleton=1")?.unscoped;
  const gap=(sql:string,...args:string[])=>{gapped+=db.query(`UPDATE safety_collections SET gap=COALESCE(gap,'recording_failed_recovered') WHERE gap IS NULL AND (${sql})`).run(...args).changes;};
  // Reservations on ended epochs could never have released input: the event
  // and reservation consumption commit together. Retain the historical gap.
  if(unscoped)gap("1=1");
  else for(const turnId of local.lostTurns)gap("turn_id=?",turnId);
  gap("id IN (SELECT collection_id FROM safety_pending) OR failure IS NOT NULL");
  // An open collection's reservation may still commit: it is already
  // gapped, and its own end resolves whatever stays pending.
  db.query("DELETE FROM safety_pending WHERE collection_id IN (SELECT id FROM safety_collections WHERE ended=1)").run();
  db.query("UPDATE safety_emergency_reserve SET padding=zeroblob(65536) WHERE singleton=1").run();
  db.query("UPDATE safety_meta SET failed=0,reason=NULL WHERE singleton=1").run();
  db.query("DELETE FROM safety_latch").run();
  db.query("INSERT INTO safety_recoveries(at,trigger,actor,scope,cause,gapped) VALUES(?,?,?,'brain',?,?)").run(at,trigger,actor,cause?JSON.stringify(cause):null,gapped);
  db.query("DELETE FROM safety_recoveries WHERE id NOT IN (SELECT id FROM safety_recoveries ORDER BY id DESC LIMIT 100)").run();
  advance(db);recovered=true;
 }).immediate();
 if(recovered){
  local.failed=false;local.latchRevision=null;local.lostTurns.clear();local.unscopedLoss=false;local.lossCause=null;
  const c=cause as SafetyLatchCause|null;
  logSafetyRecording("safety recording recovered for the brain",{"safety.scope":"brain","safety.trigger":trigger,"safety.actor":actor,"safety.gapped":gapped,
   "safety.reason":c?.reason??null,"safety.site":c?.site??null,"error.class":c?.errorClass??null,"error.message":c?.message??null});
 }
 return {recovered,trigger,actor,at,gapped,cause};
}
