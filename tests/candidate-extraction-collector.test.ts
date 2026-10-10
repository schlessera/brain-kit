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
test("summary reports per-field denominators, label balance and the lexical arm's inventions",async()=>{
  const {summary}=await collect(1);
  // Gold classes are counted from the workload, not from any arm's output.
  expect(summary.labels.deadline).toEqual({span_supported:8,span_unsupported:3,none:1,unclear:3});
  expect(summary.labels.event_start.unclear).toBeGreaterThan(summary.labels.event_start.span_supported!*5);
  const scripted=summary.arms.scripted,lexical=summary.arms.lexical;
  expect(scripted.deadline.candidateRecall).toEqual({n:10,d:11,rate:10/11}); // held-relative prose date is the known miss
  expect(scripted.deadline.roleCorrectGivenRetrieved.rate).toBe(1);
  // 8 supported spans plus the explicit none complete the task; 3 unsupported spans and 3 unclear need fallback.
  expect(scripted.deadline.taskComplete.n).toBe(9);expect(scripted.deadline.fallback).toEqual({n:6,d:15,rate:6/15});
  expect(Object.values(scripted).every(f=>f.invented===0&&f.absentFieldErrors===0)).toBe(true);
  // The lexical comparator selects the guest-comment date in tune-instruction and the footer address in held-footer.
  expect(lexical.deadline.invented).toBe(1);expect(lexical.contact_email.invented).toBe(1);expect(lexical.contact_email.absentFieldErrors).toBe(1);
  expect(lexical.deadline.roleCorrectGivenRetrieved.n).toBeLessThan(scripted.deadline.roleCorrectGivenRetrieved.n);
  expect(lexical.salary.taskComplete.n).toBeLessThan(scripted.salary.taskComplete.n);
});
