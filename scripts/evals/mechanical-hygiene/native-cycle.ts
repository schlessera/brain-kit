/** Full actual skill cycle. Provisional descriptions never become semantic approval. */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ReviewArtifacts } from "./admission";
import { prepare, cycle } from "./fixture";
import { workload } from "./workload";
import { phases, assertNativeEvidence } from "./collector";
import { observeTree, type TreeEvidence } from "./observer";
import { unchangedApproval, assessEffects, type EffectApproval } from "./effects";
import { installNativeSurface } from "./native-surface";
import { runNativePhase, type NativeOptions, type ActualNativeReceipt } from "./native-driver";
import { projectNativeLogDescriptions } from "./native-log-expectations";
import { assessNativeEffects } from "./native-effects";
import { assertNativeInput } from "./native-input";
import { assertWriteDayUTC, actualWriteDayUTC } from "./write-day";
export interface ActualPhaseRow {
  phase:typeof phases[number];before:TreeEvidence;after:TreeEvidence|null;
  receipt:ActualNativeReceipt|null;durationMs:number;harnessWallMs:number;effects:ReturnType<typeof assessNativeEffects>|null;
}
function withOperationalSurface(before:TreeEvidence, expected:EffectApproval){
  const result=structuredClone(expected);
  for(const [path,entry]of Object.entries(before))if(entry.kind==="file"&&!result[path]&&!path.startsWith("context/hygiene/"))result[path]={bytesBase64:entry.bytesBase64!,mode:entry.mode,changed:false};
  return result;
}
export async function collectActualCycle(options:{caseId:string;size:number;destination:string;source:string;token:string;candidate:any;
  offline:boolean;reviewArtifacts?:ReviewArtifacts;
  // Explicitly offline physical responses are recreated independently per phase.
  controlledTransport?:(phase:typeof phases[number],root:string)=>NonNullable<NativeOptions["physicalFetch"]>;
}){
  const fixture=workload.find(f=>f.id===options.caseId);
  if(!fixture||![20,1000].includes(options.size)||fixture.timezone!==Intl.DateTimeFormat().resolvedOptions().timeZone)throw Error("Actual case/size/worker timezone mismatch");
  if(options.candidate.fixture!==fixture.id||options.candidate.initialDocuments!==options.size||options.candidate.workerTimezone!==fixture.timezone)throw Error("Complete candidate effects do not match this native cell");
  assertWriteDayUTC(options.candidate.writeDayUTC);
  const env=prepare(fixture,options.size-Object.keys(fixture.files).length, options.candidate.writeDayUTC),rows:ActualPhaseRow[]=[];
  mkdirSync(options.destination,{mode:0o700});installNativeSurface(env.root,options.source,fixture);
  const save=(failure:string|null)=>writeFileSync(join(options.destination,"phases.json"),JSON.stringify({caseId:fixture.id,size:options.size,writeDayUTC:options.candidate.writeDayUTC,physicalWriteDayUTC:actualWriteDayUTC(),wallMtimeFindingsAreHarnessEffects:true,workerTimezone:fixture.timezone,executionKind:options.offline?"offline-scripted-control":"live-subscription",rows,failure,complete:rows.length===3&&!failure,descriptionSemanticApproval:false,finalInvoiceSupplied:false},null,2),{mode:0o600});
  let failure:string|null=null;
  try{
    for(const phase of phases){
      assertWriteDayUTC(options.candidate.writeDayUTC);
      const before=observeTree(env.root),started=performance.now();assertNativeInput(env.root,fixture.id,options.size,phase,before);
      const row:ActualPhaseRow={phase,before,after:null,receipt:null,durationMs:0,harnessWallMs:0,effects:null};rows.push(row);save(null);
      row.receipt=await runNativePhase({root:env.root,source:options.source,destination:join(options.destination,phase),phase,token:options.token,offline:options.offline,purpose:options.offline?"offline-skill":"scored-skill",reviewArtifacts:options.reviewArtifacts,caseId:fixture.id,initialDocuments:options.size,inputEvidence:before,writeDayUTC:options.candidate.writeDayUTC,
        ...(options.offline?{physicalFetch:options.controlledTransport?.(phase,env.root),deadlineMs:15000}:{})});
      row.harnessWallMs=performance.now()-started;row.durationMs=row.receipt.durationMs;save(null);
      if(!row.receipt.native.ownedChildDrained)throw Error("Owned native writer has not closed; no post-write snapshot allowed");
      row.after=observeTree(env.root);save(null);
      let expected:EffectApproval;
      if(phase!=="apply")expected=unchangedApproval(before);
      else{
        const fixed=row.after[".brain/scratch/hygiene-fixed.json"];
        if(!fixed||fixed.kind!=="file")throw Error("Required actual fixed scratch receipt missing");
        const descriptions=JSON.parse(Buffer.from(fixed.bytesBase64!,"base64").toString("utf8"));
        const changed=Object.keys(fixture.expected).filter(path=>fixture.expected[path]!==fixture.files[path]);
        expected=projectNativeLogDescriptions(options.candidate.expectedFiles,changed,descriptions).expected;
      }
      row.effects=assessNativeEffects(env.root,before,row.after,withOperationalSurface(before,expected),phase);save(null);
      assertWriteDayUTC(options.candidate.writeDayUTC);
      assertNativeEvidence(row.receipt.native);
      if(!row.effects.accepted)throw Error(`Unapproved complete native ${phase} effects: ${row.effects.problems.join("; ")}`);
    }
    return{rows,complete:true as const,descriptionSemanticApproval:false as const};
  }catch(error){failure=String(error);save(failure);throw error;}
  finally{save(failure);env.close();}
}

/** Matched exact fixture and phases; this arm contains no model or CLI-without-agent substitute. */
export async function collectPrototypeCycle(caseId:string,size:number,candidate:any,destination?:string){
  const fixture=workload.find(f=>f.id===caseId);
  if(!fixture||![20,1000].includes(size)||fixture.timezone!==Intl.DateTimeFormat().resolvedOptions().timeZone||candidate.fixture!==caseId||candidate.initialDocuments!==size)throw Error("Matched prototype case/size/timezone mismatch");
  assertWriteDayUTC(candidate.writeDayUTC);
  const env=prepare(fixture,size-Object.keys(fixture.files).length,candidate.writeDayUTC),rows:any[]=[];
  const save=(failure:string|null)=>{if(destination)writeFileSync(join(destination,"phases.json"),JSON.stringify({caseId,size,rows,failure,writeDayUTC:candidate.writeDayUTC,physicalWriteDayUTC:actualWriteDayUTC(),wallMtimeFindingsAreHarnessEffects:true,complete:rows.length===3&&!failure},null,2),{mode:0o600});};
  let failure:string|null=null;
  try{
    for(const phase of phases){
      const before=observeTree(env.root),started=performance.now(),row:any={phase,before,after:null,durationMs:0,effects:null,result:null,writeDayUTC:candidate.writeDayUTC,physicalWriteDayUTC:actualWriteDayUTC(),wallMtimeFindingsAreHarnessEffects:true,modelCalls:0};rows.push(row);save(null);
      try {
        row.result=await cycle(env,phase==="dry-run");row.durationMs=performance.now()-started;row.after=observeTree(env.root);
        const expected=phase==="apply"?candidate.expectedFiles:unchangedApproval(before);row.effects=assessEffects(before,row.after,expected);save(null);
        assertWriteDayUTC(candidate.writeDayUTC);
        if(!row.effects.accepted)throw Error("Matched prototype phase effects rejected");
      }catch(error){row.durationMs=performance.now()-started;row.after=observeTree(env.root);throw error;}
    }
    return{rows,complete:true as const};
  }catch(error){failure=String(error);save(failure);throw error;}
  finally{save(failure);env.close();}
}
