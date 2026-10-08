import { expect, test } from "bun:test";
import { calibrate, type TuningRow } from "../scripts/evals/candidate-extraction/calibration";
import { workload, FIELDS } from "../scripts/evals/candidate-extraction/workload";
function rows(): TuningRow[] {
  return workload.filter(c=>c.split==="tuning").flatMap(c=>FIELDS[c.domain].map(field=>({
    id:c.id,field,split:"tuning" as const,choice:c.gold[field].role==="span"?"0":c.gold[field].role,
    roleCorrect:true,confidence:.99,selectedProbability:.99,
  })));
}
test("per-field gates require confidence and selected probability from complete tuning-only observations",()=>{
  const observed=rows(); expect(observed.length).toBeGreaterThan(30);
  const low=observed.find(r=>r.field==="deadline"&&r.choice==="0")!;
  low.roleCorrect=false;low.selectedProbability=.75;
  expect(calibrate(observed).deadline).toBe(.8);
  low.selectedProbability=.99;low.confidence=.75;
  expect(calibrate(observed).deadline).toBe(.8);
});
test("unsupported tuning outcomes cannot create a positive field gate",()=>{
  const observed=rows();
  for(const row of observed.filter(r=>r.field==="salary")) {row.choice="unclear";row.roleCorrect=true;}
  expect(calibrate(observed).salary).toBeNull();
  for(const row of observed.filter(r=>r.field==="salary")) {row.choice="0";row.roleCorrect=false;}
  expect(calibrate(observed).salary).toBeNull();
});
test("missing, duplicate, relabelled held-out and out-of-range data cannot manufacture calibration",()=>{
  const observed=rows();
  expect(()=>calibrate(observed.slice(1))).toThrow("Complete unique tuning-only");
  expect(()=>calibrate([observed[0]!,...observed.slice(0,-1)])).toThrow("Complete unique tuning-only");
  expect(()=>calibrate([{...observed[0]!,split:"held-out"},...observed.slice(1)])).toThrow("Complete unique tuning-only");
  expect(()=>calibrate([{...observed[0]!,id:workload.find(c=>c.split==="held-out")!.id},...observed.slice(1)])).toThrow("Complete unique tuning-only");
  for(const row of observed.filter(r=>r.field==="salary"))row.selectedProbability=1.2;
  expect(calibrate(observed).salary).toBeNull();
});
