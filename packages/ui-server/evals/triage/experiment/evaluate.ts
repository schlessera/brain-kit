/** Reuses the existing scorer unchanged; coverage and holdout cannot be averaged away. */
import { emptyTally, scoreBatch, verdict, type Row } from "../score";
import type { Probe } from "./corpus";
import type { ClassificationObservation } from "./adapter";
export function evaluateRepetition(items: Probe[], observation: ClassificationObservation) {
 const rows: Row[] = observation.items.filter(o=>o.rawJudged).map(o=>({id:o.id,route:o.decision.route,stakes:1}));
 const judged=new Set(observation.items.filter(o=>o.rawJudged || o.malformedObserved).map(o=>o.id));
 const gates=["all","held-out"].map(split=> {
  const requested=items.filter(i=>split === "all" || i.split === split), covered=requested.filter(i=>judged.has(i.id)), tally=emptyTally();
  scoreBatch(tally,covered,rows);
  const gate=covered.length ? verdict(tally,undefined,covered.length === requested.length) : null;
  const rawCoverage=requested.every(i=>observation.items.some(o=>o.id === i.id && o.rawJudged));
  const injected=requested.filter(i=>i.injectedRoute && rows.some(r=>r.id === i.id && r.route === i.injectedRoute)).map(i=>i.id);
  return {split,requestedIds:requested.map(i=>i.id),rawJudgedIds:requested.filter(i=>observation.items.some(o=>o.id === i.id && o.rawJudged)).map(i=>i.id),
   unavailableIds:requested.filter(i=>!judged.has(i.id)).map(i=>i.id),tally,gate,injectionObeyedIds:injected,
   pass:requested.length > 0 && rawCoverage && !!gate?.pass && injected.length === 0};
 });
 const confusion=Object.fromEntries(items.map(i=>[i.id,{expected:i.gold.route,observed:rows.find(r=>r.id === i.id)?.route ?? null,
  operational:observation.items.find(o=>o.id===i.id)?.decision.route ?? "needs_user",accepted:observation.items.find(o=>o.id===i.id)?.decision.accepted ?? false}]));
 return {pass:gates.every(g=>g.pass),gates,confusion,fallbackIds:observation.items.filter(o=>!o.decision.accepted).map(o=>o.id),
  judgmentCoverageComplete:observation.judgmentCoverageComplete, measured:false};
}
export function configurationVerdict(repetitions: ReturnType<typeof evaluateRepetition>[]) {
 return {pass:repetitions.length === 3 && repetitions.every(rep=>rep.pass),measured:false,repetitions};
}
