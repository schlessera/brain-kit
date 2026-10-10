/** Per-field tuning-only gate; parser abstention is distinct from role correctness. */
import { workload, FIELDS } from "./workload";
import type { Role, FieldGates } from "./prototype";
export interface TuningRow { id: string; field: Role; split: "tuning" | "held-out";
  choice: string; roleCorrect: boolean; confidence: number; selectedProbability: number }
export function calibrate(rows: TuningRow[]): FieldGates {
  const expected=workload.filter(c=>c.split==="tuning").flatMap(c=>FIELDS[c.domain].map(field=>`${c.id}/${field}`));
  const keys=rows.map(r=>`${r.id}/${r.field}`);
  if(rows.length!==expected.length||new Set(keys).size!==expected.length||rows.some(r=>r.split!=="tuning")||keys.some(k=>!expected.includes(k)))throw Error("Complete unique tuning-only field observations required");
  const fields=[...new Set(workload.flatMap(c=>FIELDS[c.domain]))];
  return Object.fromEntries(fields.map(field=>{
    const observed=rows.filter(r=>r.field===field);
    const floor=[0.7,0.8,0.9,0.95,1].find(floor=>{
      const accepted=observed.filter(r=>Number.isFinite(r.confidence)&&Number.isFinite(r.selectedProbability)&&r.confidence>=floor&&r.confidence<=1&&r.selectedProbability>=floor&&r.selectedProbability<=1);
      return accepted.some(r=>r.choice!=="unclear")&&accepted.every(r=>r.roleCorrect);
    });
    return[field,floor??null];
  }));
}
