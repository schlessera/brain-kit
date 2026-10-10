import { expect, test } from "bun:test";
import { workload, FIELDS } from "../scripts/evals/candidate-extraction/workload";
import { choices, grade, gradeTask, input } from "../scripts/evals/candidate-extraction/grading";
import { conferenceResearch, domainRoles, jobResearch, type Role } from "../scripts/evals/candidate-extraction/prototype";
import { scriptedResult } from "../scripts/evals/candidate-extraction/run";
test("fresh natural cases freeze all fields with company/template and tuning coverage", () => {
  expect(workload).toHaveLength(24); expect(workload.filter(c=>c.split==="tuning")).toHaveLength(10);
  for(const key of ["id","entity","template","source"] as const) expect(new Set(workload.map(c=>c[key])).size).toBe(24);
  for(const domain of ["job","cfp"] as const) expect([...FIELDS[domain]].sort()).toEqual(domainRoles(domain).sort());
  for(const c of workload) {
    expect(Object.keys(c.gold).sort()).toEqual([...FIELDS[c.domain]].sort());
    const p=input(c); expect(p.request.model).toBe("jev-1.13.0"); expect(p.request.state).toHaveProperty("sourceContext",c.context);
    expect(JSON.stringify(p.request)).not.toContain('"gold"'); expect(JSON.stringify(p.request)).not.toContain('"split"');
  }
});
test.each(["tune-monthly","held-relative","held-html-link"])("%s: valid full-task fallback is distinct from correct helper abstention",async id=>{
  const c=workload.find(c=>c.id===id)!,p=input(c),result=await scriptedResult(p,choices(c,p));
  const fields=(c.domain==="cfp"?conferenceResearch(p,result):jobResearch(p,result)).fields;
  const role=Object.keys(c.gold).find(role=>c.gold[role].task)! as Role;
  expect(fields[role as keyof typeof fields]!.status).toBe("unresolved");
  expect(gradeTask(c,fields).find(r=>r.role===role)!.completed).toBe(false);
  const gold=c.gold[role],start=c.source.indexOf(gold.text!);
  const successful={status:gold.task!.status,value:gold.task!.value,provenance:{start,text:gold.text!}};
  const complete={...fields,[role]:successful};
  const row=gradeTask(c,complete).find(r=>r.role===role)!;
  expect(row.correct).toBe(true);expect(row.completed).toBe(true);
  if(id==="tune-monthly") {
    const wrong={...complete,[role]:{...successful,value:{...gold.task!.value as object,period:"year"}}};
    expect(gradeTask(c,wrong).find(r=>r.role===role)!.correct).toBe(false);
  }
});
test.each(workload)("$id: actual consumer separately grades role/span, parser support and task completion", async c => {
  const p=input(c), result=await scriptedResult(p,choices(c,p));
  const fields=(c.domain==="cfp"?conferenceResearch(p,result):jobResearch(p,result)).fields;
  const rows=grade(c,p,result,fields);
  expect(rows.length).toBe(FIELDS[c.domain].length);
  for(const row of rows) {
    expect(row.normalizedCorrect,`${c.id}/${row.role}`).toBe(true);
    expect(row.roleCorrect,`${c.id}/${row.role}`).toBe(row.retrieved!==false);
    if(row.parserSupported===false) { expect(row.taskComplete).toBe(false); expect(row.needsFallback).toBe(true); }
    if(c.gold[row.role].candidate===false) { expect(row.retrieved).toBe(false); expect(row.conditionalRoleDenominator).toBe(false); }
  }
});
test("equal normalized date at wrong source occurrence is a semantic role miss",async()=>{
  const c=workload.find(c=>c.id==="held-duplicate-date")!,p=input(c);
  const wanted=choices(c,p), wrong=p.candidates.find(x=>x.kind==="date")!;
  const result=await scriptedResult(p,{...wanted,deadline:String(wrong.index)});
  const row=grade(c,p,result,conferenceResearch(p,result).fields).find(r=>r.role==="deadline")!;
  expect(row.roleCorrect).toBe(false); expect(row.normalizedCorrect).toBe(false); expect(row.taskComplete).toBe(false);
});
test("an invented event date is an absent-field error, never perfect abstention",async()=>{
  const c=workload.find(c=>c.id==="held-no-event")!,p=input(c);
  const wrong=p.candidates.find(x=>x.text==="2028-08-01")!;
  const result=await scriptedResult(p,{...choices(c,p),event_start:String(wrong.index)});
  const row=grade(c,p,result,conferenceResearch(p,result).fields).find(r=>r.role==="event_start")!;
  expect(row.absentFieldError).toBe(true); expect(row.invented).toBe(true); expect(row.roleCorrect).toBe(false); expect(row.normalizedCorrect).toBe(false);
});
test("a selected injected date on an unclear gold is an invention, not an absent-field error",async()=>{
  const c=workload.find(c=>c.id==="tune-instruction")!,p=input(c);
  expect(c.gold.deadline!.role).toBe("unclear");
  const injected=p.candidates.find(x=>x.text==="2028-09-01")!;
  const result=await scriptedResult(p,{...choices(c,p),deadline:String(injected.index)});
  const fields=conferenceResearch(p,result).fields;
  expect(fields.deadline!.status).toBe("selected");
  const row=grade(c,p,result,fields).find(r=>r.role==="deadline")!;
  expect(row.invented).toBe(true); expect(row.absentFieldError).toBe(false); expect(row.roleCorrect).toBe(false);
  expect(gradeTask(c,fields).find(r=>r.role==="deadline")!.invented).toBe(true);
  const abstained=grade(c,p,await scriptedResult(p,choices(c,p)),conferenceResearch(p,await scriptedResult(p,choices(c,p))).fields).find(r=>r.role==="deadline")!;
  expect(abstained.invented).toBe(false);
});
