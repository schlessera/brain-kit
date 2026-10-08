/** Independent role occurrence, parser-support and task-output denominators. */
import { expectedStart } from "./fixtures";
import { prepare, roles, type Prepared, type Report, type Role } from "./prototype";
import type { JevResult } from "../../../packages/core/src/lib/jev";
import { FIELDS, type Case } from "./workload";
export function choices(c: Case, p: Prepared) {
  return Object.fromEntries(FIELDS[c.domain].map(role => {
    const g = c.gold[role];
    if (g.role !== "span") return [role, g.role];
    const start = expectedStart(c.source, g);
    const candidate = p.candidates.find(x => x.start === start && x.text === g.text && x.kind === roles[role].kind);
    return [role, candidate ? String(candidate.index) : "unclear"];
  }));
}
export function grade(c: Case, p: Prepared, result: JevResult, report: Report) {
  return FIELDS[c.domain].map(role => {
    const g = c.gold[role], field = report[role], answer = result.answers?.[role];
    const start = g.role === "span" ? expectedStart(c.source, g) : null;
    const target = p.candidates.find(x => x.start === start && x.text === g.text && x.kind === roles[role].kind);
    const retrieved = g.role !== "span" ? null : Boolean(target);
    const chosen = answer?.type === "choice" && /^(0|[1-9]\d*)$/.test(answer.choice) ? p.candidates[Number(answer.choice)] : undefined;
    const roleCorrect = g.role === "span" ? Boolean(chosen && chosen.kind === roles[role].kind && chosen.start === start && chosen.text === g.text)
      : answer?.type === "choice" && answer.choice === g.role;
    const normalizedCorrect = field?.status === g.status && JSON.stringify(field?.value) === JSON.stringify(g.value) &&
      (g.role !== "span" || g.candidate === false || field?.provenance?.start === start && field?.provenance?.text === g.text);
    // Correct parser abstention is not completion of a semantically present field.
    const taskComplete = normalizedCorrect && (g.role === "none" || g.role === "span" && g.status === "selected");
    return { id: c.id, role, retrieved, roleCorrect, conditionalRoleDenominator: retrieved !== false,
      parserSupported: g.role === "span" ? g.status === "selected" : null, normalizedCorrect, taskComplete,
      needsFallback: !taskComplete,
      absentFieldError: g.role === "none" && field?.status === "selected", sourceHash: p.sourceHash,
      observedOccurrence: chosen ? { start: chosen.start, end: chosen.end, text: chosen.text } : null };
  });
}
export function input(c: Case) { return prepare(c.source,c.domain,c.context); }
/** Full-task outputs can exceed the bounded helper grammar; never grade them against helper abstention. */
export function gradeTask(c:Case, fields: Partial<Record<Role,{status:string;value:unknown;provenance:{start:number;text:string}|null}>>) {
  return FIELDS[c.domain].map(role=>{
    const g=c.gold[role], target=g.task??{status:g.status,value:g.value,rationale:"Author-specified field or explicit safe unknown"}, actual=fields[role];
    const occurrenceCorrect=g.role!=="span"||actual?.provenance?.start===expectedStart(c.source,g)&&actual?.provenance?.text===g.text;
    const correct=actual?.status===target.status&&JSON.stringify(actual?.value)===JSON.stringify(target.value)&&occurrenceCorrect;
    return{role,correct,occurrenceCorrect,expectedStatus:target.status,clarificationRequired:target.status==="unresolved",
      completed:correct&&target.status!=="unresolved",absentFieldError:g.role==="none"&&actual?.status==="selected"};
  });
}
