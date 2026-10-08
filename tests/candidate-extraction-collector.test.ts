import {expect,test} from "bun:test";
import {collect} from "../scripts/evals/candidate-extraction/collect";
test("whole fresh workload retains raw physical controls and full-task fallback denominators",async()=>{
  const result=await collect(1);expect(result.observations).toBe(24);expect(result.physicalControlRequests).toBe(24);
  expect(result.completeInstalledWorkflowMeasured).toBe(false);expect(result.live.goNoGo).toBeNull();
  for(const row of result.rows){
    expect(row.controlled.length).toBe(row.fields.length);expect(row.controlledTask.length).toBe(row.fields.length);
    expect(row.rawPhysical).toHaveLength(1);expect(row.rawPhysical[0]!.outputTokens).toBe(23);
    expect(Buffer.from(row.rawPhysical[0]!.responseBytes!,"base64").length).toBeGreaterThan(100);
    expect(row.rawPhysical[0]!.actualBilledUsd).toBeNull();
  }
  for(const [id,field] of [["tune-monthly","salary"],["held-relative","deadline"],["held-html-link","apply_url"]]){
    const row=result.rows.find(r=>r.id===id)!;
    expect(row.controlledTask.find(r=>r.role===field)!.completed).toBe(false);
    expect(row.controlled.find(r=>r.role===field)!.needsFallback).toBe(true);
  }
});
