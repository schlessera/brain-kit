/** Actual keyless client/consumer effects; no installed-workflow or semantic-performance claim. */
import { workload, FIELDS } from "./workload";
import { choices, grade, gradeTask, input } from "./grading";
import { conferenceResearch, jobResearch, lexicalChoices, sha256 } from "./prototype";
import { observedClient } from "./jev-observer";
import { scriptedResult } from "./run";
import { protocol } from "./protocol";
export async function collect(repetitions=3) {
  if(!Number.isSafeInteger(repetitions)||repetitions<1||repetitions>3)throw Error("Bounded1–3 keyless repetitions");
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
  return{issue:849,control:"authored selections through actual keyless Jev transport/parser and private report-only consumers",
    fixtureSha:sha256(JSON.stringify(workload)),protocolSha:sha256(JSON.stringify(protocol)),
    repetitions,observations:rows.length,physicalControlRequests:rows.reduce((n,r)=>n+r.rawPhysical.length,0),
    externalRequests:0,semanticApproval:null,calibratedLiveGates:null,completeInstalledWorkflowMeasured:false,
    live:{current:null,lexicalWithFallback:null,hybridWithFallback:null,allPhysicalUsage:null,actualBilledUsd:null,endToEndLatency:null,goNoGo:null},rows};
}
if(import.meta.main)console.log(JSON.stringify(await collect(),null,2));
