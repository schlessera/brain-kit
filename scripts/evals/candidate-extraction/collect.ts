/** Actual keyless client/consumer effects; no installed-workflow or semantic-performance claim. */
import { workload, FIELDS } from "./workload";
import { choices, grade, gradeTask, input } from "./grading";
import { conferenceResearch, jobResearch, lexicalChoices, sha256, type Role } from "./prototype";
import { observedClient } from "./jev-observer";
import { scriptedResult } from "./run";
import { protocol } from "./protocol";
type Graded=ReturnType<typeof grade>[number];
type ArmRows=Array<{fields:readonly Role[];graded:Graded[]}>;
/** Per-field counts an eventual live arm is compared on. Denominators are field observations over every repetition. */
export function summarize(rows:ArmRows){
  const fields=[...new Set(workload.flatMap(c=>FIELDS[c.domain]))];
  return Object.fromEntries(fields.map(field=>{
    const observed=rows.flatMap(r=>r.graded).filter(g=>g.role===field);
    const spans=observed.filter(g=>g.retrieved!==null),retrieved=spans.filter(g=>g.retrieved),conditional=observed.filter(g=>g.conditionalRoleDenominator);
    const ratio=(n:number,d:number)=>({n,d,rate:d?n/d:null});
    return[field,{observations:observed.length,
      candidateRecall:ratio(retrieved.length,spans.length),
      roleCorrectGivenRetrieved:ratio(conditional.filter(g=>g.roleCorrect).length,conditional.length),
      normalizedCorrect:ratio(observed.filter(g=>g.normalizedCorrect).length,observed.length),
      taskComplete:ratio(observed.filter(g=>g.taskComplete).length,observed.length),
      fallback:ratio(observed.filter(g=>g.needsFallback).length,observed.length),
      invented:observed.filter(g=>g.invented).length,absentFieldErrors:observed.filter(g=>g.absentFieldError).length}];
  }));
}
/** Gold class per field; the natural workload is dominated by omitted-evidence unclear labels. */
export function labelBalance(){
  const out:Record<string,Record<string,number>>={};
  for(const c of workload)for(const field of FIELDS[c.domain]){
    const g=c.gold[field]!,cls=g.role!=="span"?g.role:g.status==="selected"?"span_supported":"span_unsupported";
    const bucket=out[field]??={span_supported:0,span_unsupported:0,none:0,unclear:0};bucket[cls]=(bucket[cls]??0)+1;
  }
  return out;
}
export async function collect(repetitions=3) {
  if(!Number.isSafeInteger(repetitions)||repetitions<1||repetitions>3)throw Error("Bounded 1–3 keyless repetitions");
  const rows=[];
  for(const c of workload)for(let repetition=0;repetition<repetitions;repetition++) {
    const prepared=input(c), target=choices(c,prepared);
    const observed=observedClient(async()=>{
      const answers=Object.fromEntries(Object.entries(prepared.request.questions).map(([field,q])=>{
        if(q.type!=="choice")throw Error("Only frozen Choice transport");
        const choice=target[field]??"unclear";
        return[field,{type:"choice",choice,confidence:1,probabilities:Object.fromEntries(Object.keys(q.criteria).map(k=>[k,k===choice?1:0]))}];
      }));
      return Response.json({model:"jev-1.13.0",usage:{input_tokens:456,output_tokens:23},answers});
    });
    const started=performance.now(), selected=await observed.judge(prepared);
    const report=(c.domain==="cfp"?conferenceResearch(prepared,selected.result):jobResearch(prepared,selected.result)).fields;
    const lexicalResult=await scriptedResult(prepared,lexicalChoices(prepared));
    const lexical=(c.domain==="cfp"?conferenceResearch(prepared,lexicalResult):jobResearch(prepared,lexicalResult)).fields;
    rows.push({id:c.id,split:c.split,domain:c.domain,repetition,inputSha:sha256(JSON.stringify(prepared.request)),
      candidates:prepared.candidates.length,fields:FIELDS[c.domain],rawPhysical:observed.calls,
      controlled:grade(c,prepared,selected.result,report),controlledTask:gradeTask(c,report),
      lexical:grade(c,prepared,lexicalResult,lexical),lexicalTask:gradeTask(c,lexical),
      localControlMs:performance.now()-started,report,lexicalReport:lexical});
  }
  const summary={labels:labelBalance(),
    arms:{scripted:summarize(rows.map(r=>({fields:r.fields,graded:r.controlled}))),lexical:summarize(rows.map(r=>({fields:r.fields,graded:r.lexical})))}};
  return{issue:849,control:"authored selections through actual keyless Jev transport/parser and private report-only consumers",
    fixtureSha:sha256(JSON.stringify(workload)),protocolSha:sha256(JSON.stringify(protocol)),
    repetitions,observations:rows.length,physicalControlRequests:rows.reduce((n,r)=>n+r.rawPhysical.length,0),summary,
    externalRequests:0,semanticApproval:null,calibratedLiveGates:null,completeInstalledWorkflowMeasured:false,
    live:{current:null,lexicalWithFallback:null,hybridWithFallback:null,allPhysicalUsage:null,actualBilledUsd:null,endToEndLatency:null,goNoGo:null},rows};
}
if(import.meta.main)console.log(JSON.stringify(await collect(),null,2));
