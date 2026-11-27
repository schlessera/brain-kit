import type { SafetyRecord } from "@schlessera/brain-ui-sdk/protocol";

type SafetyOccurrence = Extract<SafetyRecord,{kind:"occurrence"}>;
export interface SafetyEvidence {
  occurrence:SafetyOccurrence;
  exposure:Extract<SafetyRecord,{kind:"exposure"}>["state"];
  decision:Extract<SafetyRecord,{kind:"safe_decision"}>|null;
  /** The host's verdict on the input's tool (#4513): `"unknown"` when it saw
   * differently named calls under the joined tool-use ID. Never inferred here. */
  attribution:"unknown"|null;
}
const cache=new WeakMap<Record<string,SafetyRecord>,Map<string,SafetyEvidence>>();
const tools=new WeakMap<Record<string,SafetyRecord>,Map<string,SafetyEvidence[]>>();
/** Immutable IDs join evidence. Names, timing, arguments and adjacency never do. */
export function safetyEvidence(records:Record<string,SafetyRecord>):Map<string,SafetyEvidence> {
  const old=cache.get(records);if(old)return old;
  const entries=new Map<string,SafetyEvidence>(),latest=new Map<string,bigint>();
  for(const r of Object.values(records))if(r.kind==="occurrence"){
    entries.set(r.id,{occurrence:r,exposure:r.exposure,decision:null,attribution:null});latest.set(r.id,BigInt(r.sequence));
  }
  const reused=new Set<string>();
  for(const r of Object.values(records)){
    if(r.kind==="attribution"){reused.add(r.toolUseId===null?`${r.bindingId}\0*`:`${r.bindingId}\0${r.toolUseId}`);continue;}
    const entry=entries.get(r.occurrenceId);if(!entry)continue;
    if(r.kind==="safe_decision")entry.decision=r;
    if(r.kind==="exposure"&&BigInt(r.sequence)>latest.get(r.occurrenceId)!){entry.exposure=r.state;latest.set(r.occurrenceId,BigInt(r.sequence));}
  }
  // `*`: the host lost track of IDs in that turn, so none of its tools is proven.
  for(const e of entries.values())if(e.occurrence.entry&&(reused.has(`${e.occurrence.bindingId}\0*`)||reused.has(`${e.occurrence.bindingId}\0${e.occurrence.entry.toolUseId}`)))e.attribution="unknown";
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
