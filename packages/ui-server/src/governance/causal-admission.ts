/** One host-owned causal view. Its revision is not a history/review cursor. */
import {retainSettledAdmission,type AdmissionSafety} from '@schlessera/brain-ui-sdk/internal';
import {Database} from 'bun:sqlite';
import type {GovernanceWrites} from './event-writes.js';
import {readCausalRoot} from './effective-safety.js';
import {safetyQueue} from './safety-queue.js';
import {safetyScopeTurns} from './safety-store.js';

export function createCausalAdmissionSafety(db:Database,root:AdmissionSafety,options:{turnId:string;sessionId:()=>string|null;
 writes:Pick<GovernanceWrites,'safety'>;own:()=>{ids:readonly string[];valid:boolean}}):AdmissionSafety {
 let observed:string|undefined,revision=0n,localGeneration=0n;const localIds=new WeakMap<object,string>();
 const settledByBaseline=new Map<string,Set<string>>();
 const baselines=new Map<string,{sequence:string;coverage:string;turns:string;externalRevision:string|null}>();
 const sequenceWithout=(turns:readonly string[],ids:readonly string[]) => (db.query(`WITH scope AS (SELECT * FROM safety_collections WHERE turn_id IN (SELECT value FROM json_each(?))), evidence(sequence) AS (
 SELECT r.sequence FROM safety_records r JOIN scope c ON c.id=r.collection_id WHERE NOT(r.kind='occurrence' AND r.id IN (SELECT value FROM json_each(?)))
 UNION ALL SELECT d.sequence FROM safety_decisions d JOIN safety_records r ON r.id=d.occurrence_id JOIN scope c ON c.id=r.collection_id
 UNION ALL SELECT b.sequence FROM safety_bindings b JOIN scope c ON c.id=b.binding_id
 UNION ALL SELECT start_revision FROM scope UNION ALL SELECT end_revision FROM scope WHERE end_revision IS NOT NULL
 ) SELECT sequence FROM evidence ORDER BY length(sequence) DESC,sequence DESC LIMIT 1`).get(JSON.stringify(turns),JSON.stringify(ids)) as {sequence:string}|null)?.sequence??'0';
 const read=()=>{
  const session=options.sessionId(),own=options.own(),{state,externalRevision}=readCausalRoot(root,own.valid?own.ids:[]);
  const turns=[...safetyScopeTurns(db,options.turnId,session)].sort();
  // Exclude only these immutable input occurrence rows. Decisions, exposure
  // transitions and every binding/collection append remain independent.
  const sequence=sequenceWithout(turns,own.valid?own.ids:[]);
  const projection=options.writes.safety(options.turnId,session);
  // Unresolved totals/first occurrence/restriction can change solely because
  // of this call's own input. The immutable filtered sequence fences all
  // independent evidence instead. Coverage and pending/loss overlays remain.
  const scopedLocal=[...safetyQueue(db).pending].filter(item=>item.turnId!==null&&turns.includes(item.turnId)||session!==null&&item.sessionId===session);
  const ownLocal=scopedLocal.filter(item=>own.valid&&item.occurrenceId!==null&&own.ids.includes(item.occurrenceId));
  const ownReservations=new Set(ownLocal.flatMap(item=>[item.id]));
  const pendingAll=db.query("SELECT p.id FROM safety_pending p JOIN safety_collections c ON c.id=p.collection_id WHERE c.turn_id IN (SELECT value FROM json_each(?)) ORDER BY p.id").all(JSON.stringify(turns)) as {id:string}[];
  const pending=pendingAll.filter(item=>!ownReservations.has(item.id));
  const independentLocal=scopedLocal.filter(item=>!ownLocal.includes(item));
  const pendingCount=Math.max(pending.length,independentLocal.length,projection.pendingCount-Math.max(ownLocal.length,pendingAll.length-pending.length));
  const localPending=independentLocal.map(item=>{
   let id=localIds.get(item);if(id===undefined){if(++localGeneration>18446744073709551615n)throw new Error('Causal pending generation exhausted');id=localGeneration.toString();localIds.set(item,id);}return id;
  }).sort();
  const independentUnresolved=!!db.query(`SELECT 1 FROM safety_records r JOIN safety_collections c ON c.id=r.collection_id
    WHERE r.kind='occurrence' AND c.turn_id IN (SELECT value FROM json_each(?))
    AND r.id NOT IN (SELECT value FROM json_each(?))
    AND NOT EXISTS(SELECT 1 FROM safety_decisions d WHERE d.occurrence_id=r.id) LIMIT 1`).get(JSON.stringify(turns),JSON.stringify(own.valid?own.ids:[]));
  const reasons=projection.reasons.filter(reason=>reason==='unresolved'?independentUnresolved:reason!=='recording_pending'||pendingCount>0);
  // Only the concrete host reader can subtract own-input restriction. A
  // foreign root remains an independent, restrictive authority source.
  const restricted=!own.valid||independentUnresolved||pendingCount>0||reasons.length>0||externalRevision!==null&&state.restricted;
  const marker=JSON.stringify([sequence,externalRevision,restricted,turns,projection.session,projection.coverage,pendingCount,pending,localPending,state.trustRevision,state.authorityEpoch,state.scope,state.policyHash,state.recordingAvailable,state.authorityCurrent,reasons,own.valid]);
  if(observed!==undefined&&observed!==marker){if(++revision>18446744073709551615n)throw new Error('Causal admission revision exhausted');}
  observed=marker;
  if(baselines.size>=64&&!baselines.has(revision.toString())){const oldest=baselines.keys().next().value!;baselines.delete(oldest);settledByBaseline.delete(oldest);}
  baselines.set(revision.toString(),{sequence,coverage:JSON.stringify(projection.coverage),turns:JSON.stringify(turns),externalRevision});
  return {...state,restricted,evidenceRevision:revision.toString(),recordingAvailable:state.recordingAvailable&&own.valid};
 };
 const view:AdmissionSafety={read:()=>db.inTransaction?read():Database.prototype.transaction.call(db,read).deferred() as ReturnType<AdmissionSafety['read']>,
  *pendingRecording(before,signal){
   const baseline=before&&baselines.get(before.evidenceRevision),settled=new Set<string>();
   const ownPending=()=>{const own=options.own();return [...safetyQueue(db).pending].filter(item=>own.valid&&item.occurrenceId!==null&&own.ids.includes(item.occurrenceId)).map(item=>item.id);};
   for(const pending of root.pendingRecording?.(before,signal,ownPending)??[]){
    const turns=safetyScopeTurns(db,options.turnId,options.sessionId()),own=options.own();
    for(const item of safetyQueue(db).pending)if(item.occurrenceId&&item.turnId&&turns.has(item.turnId)&&!own.ids.includes(item.occurrenceId))settled.add(item.occurrenceId);
    yield pending;
   }
   if(!signal?.aborted&&before&&baseline&&baseline.externalRevision===null&&settled.size){
    const own=options.own(),turns=[...safetyScopeTurns(db,options.turnId,options.sessionId())].sort(),after=view.read();
    const allSettled=new Set([...(settledByBaseline.get(before.evidenceRevision)??[]),...settled]);
    const committed=[...allSettled].every(id=>!!db.query("SELECT 1 FROM safety_records WHERE id=? AND kind='occurrence'").get(id));
    const projection=options.writes.safety(options.turnId,options.sessionId());
    if(own.valid&&committed&&after.recordingAvailable&&JSON.stringify(turns)===baseline.turns&&JSON.stringify(projection.coverage)===baseline.coverage&&sequenceWithout(turns,[...own.ids,...allSettled])===baseline.sequence){
     retainSettledAdmission(view,before,after);settledByBaseline.set(before.evidenceRevision,allSettled);
    }
   }
  },subscribe:changed=>root.subscribe(changed)};
 return view;
}
