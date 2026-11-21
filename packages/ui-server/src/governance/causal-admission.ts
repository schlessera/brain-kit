/** One host-owned causal view. Its revision is not a history/review cursor. */
import type {AdmissionSafety} from '@schlessera/brain-ui-sdk/internal';
import {Database} from 'bun:sqlite';
import type {GovernanceWrites} from './event-writes.js';
import {readCausalRoot} from './effective-safety.js';
import {safetyQueue} from './safety-queue.js';
import {safetyScopeTurns} from './safety-store.js';

export function createCausalAdmissionSafety(db:Database,root:AdmissionSafety,options:{turnId:string;sessionId:()=>string|null;
 writes:Pick<GovernanceWrites,'safety'>;own:()=>{ids:readonly string[];valid:boolean}}):AdmissionSafety {
 let observed:string|undefined,revision=0n,localGeneration=0n;const localIds=new WeakMap<object,string>();
 const read=()=>{
  const session=options.sessionId(),own=options.own(),state=readCausalRoot(root,own.valid?own.ids:[]);
  const turns=[...safetyScopeTurns(db,options.turnId,session)].sort();
  // Exclude only these immutable input occurrence rows. Decisions, exposure
  // transitions and every binding/collection append remain independent.
  const sequence=(db.query(`WITH scope AS (SELECT * FROM safety_collections WHERE turn_id IN (SELECT value FROM json_each(?))),
   evidence(sequence) AS (
    SELECT r.sequence FROM safety_records r JOIN scope c ON c.id=r.collection_id
      WHERE NOT(r.kind='occurrence' AND r.id IN (SELECT value FROM json_each(?)))
    UNION ALL SELECT d.sequence FROM safety_decisions d JOIN safety_records r ON r.id=d.occurrence_id JOIN scope c ON c.id=r.collection_id
    UNION ALL SELECT b.sequence FROM safety_bindings b JOIN scope c ON c.id=b.binding_id
    UNION ALL SELECT start_revision FROM scope
    UNION ALL SELECT end_revision FROM scope WHERE end_revision IS NOT NULL
   ) SELECT sequence FROM evidence ORDER BY length(sequence) DESC,sequence DESC LIMIT 1`).get(JSON.stringify(turns),JSON.stringify(own.ids)) as {sequence:string}|null)?.sequence??'0';
  const projection=options.writes.safety(options.turnId,session);
  // Unresolved totals/first occurrence/restriction can change solely because
  // of this call's own input. The immutable filtered sequence fences all
  // independent evidence instead. Coverage and pending/loss overlays remain.
  const scopedLocal=[...safetyQueue(db).pending].filter(item=>item.turnId!==null&&turns.includes(item.turnId)||session!==null&&item.sessionId===session);
  const ownLocal=scopedLocal.filter(item=>own.valid&&item.occurrenceId!==undefined&&own.ids.includes(item.occurrenceId));
  const ownReservations=new Set(ownLocal.flatMap(item=>item.reservationId?[item.reservationId]:[]));
  const pendingAll=db.query("SELECT p.id FROM safety_pending p JOIN safety_collections c ON c.id=p.collection_id WHERE c.turn_id IN (SELECT value FROM json_each(?)) ORDER BY p.id").all(JSON.stringify(turns)) as {id:string}[];
  const pending=pendingAll.filter(item=>!ownReservations.has(item.id));
  const independentLocal=scopedLocal.filter(item=>!ownLocal.includes(item));
  const pendingCount=Math.max(pending.length,independentLocal.length,projection.pendingCount-Math.max(ownLocal.length,pendingAll.length-pending.length));
  const localPending=independentLocal.map(item=>{
   let id=localIds.get(item);if(id===undefined){if(++localGeneration>18446744073709551615n)throw new Error('Causal pending generation exhausted');id=localGeneration.toString();localIds.set(item,id);}return id;
  }).sort();
  const marker=JSON.stringify([sequence,turns,projection.session,projection.coverage,pendingCount,pending,localPending,state.trustRevision,state.authorityEpoch,state.scope,state.policyHash,state.recordingAvailable,state.authorityCurrent,projection.reasons.filter(reason=>reason!=='unresolved'&&(reason!=='recording_pending'||pendingCount>0)),own.valid]);
  if(observed!==undefined&&observed!==marker){if(++revision>18446744073709551615n)throw new Error('Causal admission revision exhausted');}
  observed=marker;
  return {...state,evidenceRevision:revision.toString(),recordingAvailable:state.recordingAvailable&&own.valid};
 };
 return {read:()=>db.inTransaction?read():Database.prototype.transaction.call(db,read).deferred() as ReturnType<AdmissionSafety['read']>,subscribe:changed=>root.subscribe(changed)};
}
