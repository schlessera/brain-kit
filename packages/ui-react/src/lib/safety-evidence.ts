import type { SafetyRecord } from "@schlessera/brain-ui-sdk/protocol";

type SafetyOccurrence = Extract<SafetyRecord,{kind:"occurrence"}>;
export interface SafetyEvidence {
  occurrence:SafetyOccurrence;
  exposure:SafetyOccurrence["exposure"];
  decision:Extract<SafetyRecord,{kind:"safe_decision"}>|null;
}
const cache=new WeakMap<Record<string,SafetyRecord>,Map<string,SafetyEvidence>>();
const tools=new WeakMap<Record<string,SafetyRecord>,Map<string,SafetyEvidence[]>>();
/** Immutable IDs join evidence. Names, timing, arguments and adjacency never do. */
export function safetyEvidence(records:Record<string,SafetyRecord>):Map<string,SafetyEvidence> {
  const old=cache.get(records);if(old)return old;
  const entries=new Map<string,SafetyEvidence>(),latest=new Map<string,bigint>();
  for(const r of Object.values(records))if(r.kind==="occurrence"){
    entries.set(r.id,{occurrence:r,exposure:r.exposure,decision:null});latest.set(r.id,BigInt(r.sequence));
  }
  for(const r of Object.values(records)){
    const entry=entries.get(r.occurrenceId);if(!entry)continue;
    if(r.kind==="safe_decision")entry.decision=r;
    if(r.kind==="exposure"&&BigInt(r.sequence)>latest.get(r.occurrenceId)!){entry.exposure=r.state;latest.set(r.occurrenceId,BigInt(r.sequence));}
  }
  const index=new Map<string,SafetyEvidence[]>();
  for(const e of entries.values())if(e.occurrence.entry){const key=`${e.occurrence.turnId}\0${e.occurrence.entry.toolUseId}`,group=index.get(key)??[];group.push(e);index.set(key,group);}
  cache.set(records,entries);tools.set(records,index);return entries;
}
export function entryEvidence(records:Record<string,SafetyRecord>,turnId:string|undefined,toolIds:readonly string[]):SafetyEvidence[] {
  if(!turnId)return [];
  safetyEvidence(records);
  const index=tools.get(records)!;
  return [...new Set(toolIds)].flatMap(id=>index.get(`${turnId}\0${id}`)??[]);
}
