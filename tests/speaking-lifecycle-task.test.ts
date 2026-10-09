import { expect,test } from "bun:test";
import { mkdtempSync,rmSync,writeFileSync,readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { corpus,materializeCase } from "../scripts/evals/speaking-lifecycle/corpus";
import { actualSizes,prepareSizedTask,ownerSteps } from "../scripts/evals/speaking-lifecycle/task-input";
import { parseFrontmatter } from "../packages/core/src/lib/frontmatter-parse";
import { collectCell,collectPreparation } from "../scripts/evals/speaking-lifecycle/collector";
import { digest } from "../scripts/evals/speaking-lifecycle/source-admission";
import { observe } from "../scripts/evals/speaking-lifecycle/full-observer";
import { grade,fields,RUBRIC_SHA,type Annotation } from "../scripts/evals/speaking-lifecycle/quality";
function answer(c:typeof corpus[number],source:string,requestBody:any){
  const second=source===c.secondarySource;
  return {model:"jev-1.13.0",usage:{input_tokens:123,output_tokens:17},answers:Object.fromEntries(Object.entries(requestBody.questions).map(([key,q]:any)=>{const choice=key==="conference"?c.assembly:key==="submission"?second?c.otherSubmission:c.submission:second?"rejected":c.expectedOutcome;return [key,{type:"choice",choice,confidence:1,probabilities:Object.fromEntries(Object.keys(q.criteria).map(k=>[k,Number(k===choice)]))}];}))};
}
test("all complete actual3/32/128 brains retain disjoint task-before identities and original sequence controls",async()=>{
  const original=materializeCase(corpus.find(c=>c.id==="held-deliver")!);
  expect(parseFrontmatter(original.initial[original.first]).data.speaking_outcome).toBe("submitted");
  for(const c of corpus)for(const size of actualSizes){
    const env=await prepareSizedTask(c,size);try{
      expect(env.candidates).toHaveLength(size);expect(Object.keys(env.initial).length).toBeGreaterThan(size);
      expect(env.candidates.every(candidate=>candidate.raw.startsWith("---\n")&&candidate.raw.includes("submission_id:"))).toBe(true);
      expect(JSON.parse(readFileSync(join(env.root,"brain.config.json"),"utf8")).modules["./modules/speaking"].enabled).toBe(true);
      expect(env.brain.taxonomy.dirForType("tablet")).toBe("tablets");
      expect(readFileSync(join(env.root,"assets/guard.bin"))).toEqual(Buffer.from([0,255,128,13,10]));
      for(const [path,raw]of Object.entries(env.initial))expect(readFileSync(join(env.root,path),"utf8")).toBe(raw);
      if(c.before){expect(parseFrontmatter(env.initial[env.first]).data.speaking_outcome).toBe(c.before);expect(ownerSteps(c)[0]?.source).toBe(c.source);}
      expect(env.contextCapacityVerified).toBe(false);
      if(c.id==="held-mixed-date"){expect(env.semanticTask.outcome).toBe("accepted");expect(env.semanticTask.candidateParserRefusal).toBe(true);expect(env.expected[env.first]).toContain('speaking_outcome: "accepted"');}
    }finally{env.close();}
  }
});
test("full real setup/explicit owner writer/dry/replay/effects integrates every case and actual size without semantic approval",async()=>{
  const output=mkdtempSync(join(tmpdir(),"brain-speaking-complete-owner-"));
  try{const result=await collectPreparation(output,{arm:"explicit-owner",offline:true});
    const failed=result.rows.filter((row:any)=>!row.protocolComplete||!row.candidateExactReference||!row.quality?.effect.safe);
    expect(failed.map((row:any)=>({id:row.caseId,size:row.candidateSize,error:row.failure,violations:row.quality?.effect.violations,exact:row.candidateExactReference}))).toEqual([]);
    expect(result.rows).toHaveLength(corpus.length*actualSizes.length);expect(result.complete).toBe(true);expect(result.measuredComparison).toBe(false);expect(result.semanticApproval).toBe(false);
    expect(result.rows.every((row:any)=>row.quality.semanticQuality===null&&row.actualInvoiceUsd===null&&!row.dryChanged&&!row.repeatChanged)).toBe(true);
    // The explicit-owner arm has nothing to record for an unclear source; that abstention is the completed task, never coverage loss.
    const unclear=result.rows.filter((row:any)=>row.quality.clarificationRequired);
    expect(unclear.length).toBe(corpus.filter(c=>c.expectedOutcome==="unclear"&&!c.action).length*actualSizes.length);
    expect(unclear.every((row:any)=>row.abstained&&row.quality.taskComplete===true&&row.quality.coverage===1&&!row.quality.fallback)).toBe(true);
    expect(result.rows.filter((row:any)=>!row.quality.clarificationRequired).every((row:any)=>row.quality.taskComplete===null&&row.writeCount>0)).toBe(true);
  }finally{rmSync(output,{recursive:true,force:true});}
},120000);
test("actual core JEV plus exact owner confirmation integrates held full brain; safe parser abstention remains coverage loss",async()=>{
  const output=mkdtempSync(join(tmpdir(),"brain-speaking-full-hybrid-"));
  try{
    for(const id of ["held-conditional","held-mixed-repeat","held-mixed-date"]){const c=corpus.find(c=>c.id===id)!;
      const row=await collectCell(c,{arm:"scripted-hybrid",candidateSize:32,offline:true,output:join(output,id),floor:.9,ownerConfirmation:value=>({payloadSha:digest(JSON.stringify(value)),accepted:true}),fetch:async(_url,init)=>{const body=JSON.parse(String(init.body));expect(body.state.candidates).toHaveLength(32);expect(body.state.candidates.every((v:any)=>v.raw.startsWith("---\n")&&v.raw.includes("submission_id:"))).toBe(true);return Response.json(answer(c,body.state.untrustedSource,body));}});
      expect(row.protocolComplete).toBe(true);expect(row.quality.effect.safe).toBe(true);expect(row.semanticApproval).toBe(false);expect(row.actualInvoiceUsd).toBeNull();expect(row.physical.every((call:any)=>call.inputTokens===123&&call.outputTokens===17&&call.responseEof&&call.responseClosed)).toBe(true);
      if(id==="held-mixed-date"){expect(row.abstained).toBe(true);expect(row.writeCount).toBe(0);expect(row.quality.taskComplete).toBe(false);expect(row.quality.fallback).toBe(true);expect(row.quality.coverage).toBe(0);}
      else{expect(row.candidateExactReference).toBe(true);expect(row.writeCount).toBeGreaterThan(0);}
    }
  }finally{rmSync(output,{recursive:true,force:true});}
},60000);
test("actual changed binary before write stops full collector and retains observed partial/failure tree",async()=>{
 const output=mkdtempSync(join(tmpdir(),"brain-speaking-full-stale-"));try{const row=await collectCell(corpus[0],{arm:"explicit-owner",candidateSize:3,offline:true,output,beforeApply:root=>writeFileSync(join(root,"assets/guard.bin"),Buffer.from([0,1,255]))});expect(row.protocolComplete).toBe(false);expect(row.failure).toContain("Complete fixture changed before application");expect(row.writeCount).toBe(0);expect(row.after["assets/guard.bin"].bytes).toBe(Buffer.from([0,1,255]).toString("base64"));expect(row.quality.effect.safe).toBe(false);expect(row.quality.effect.violations).toContain("unexpected effect:assets/guard.bin");}finally{rmSync(output,{recursive:true,force:true});}
});
test("missing physical usage stops outer admission and keeps aggregate unknown rather than subtotal0",async()=>{
 const output=mkdtempSync(join(tmpdir(),"brain-speaking-full-unknown-"));let calls=0;try{const result=await collectPreparation(output,{arm:"scripted-hybrid",offline:true,floor:.9,fetch:async()=>{calls++;return Response.json({model:"jev-1.13.0",answers:{}});}});expect(calls).toBe(1);expect(result.rows).toHaveLength(1);expect(result.complete).toBe(false);expect(result.rows[0].failure).toContain("unknown usage/model");expect(result.rows[0].unknownJevCalls).toBe(1);expect(result.rows[0].jevEquivalentUsd).toBeNull();expect(result.rows[0].knownJevEquivalentUsd).toBe(0);}finally{rmSync(output,{recursive:true,force:true});}
});
test("complete source/rubric/tree binding permits alternate skill layout but refuses changed judgment or unrelated data",async()=>{
 const c=corpus[0],env=await prepareSizedTask(c,3);try{
   const before=observe(env.root),raw=readFileSync(join(env.root,env.first),"utf8");
   writeFileSync(join(env.root,env.first),raw.replace("status: active","summary: Accepted 2026-07-11\nstatus: active"));const after=observe(env.root);
   const quote="## Abstract",source=c.source;
   // Synthetic annotation format control only: every actual baseline still needs full independent judgment.
   const annotation:Annotation={caseId:c.id,taskSha:digest(JSON.stringify(env.semanticTask)),beforeSha:digest(JSON.stringify(before)),afterSha:digest(JSON.stringify(after)),sourceSha:digest(source),rubricSha:RUBRIC_SHA,reviewKind:"independent-full-file-semantic",fields:Object.fromEntries(fields.map(field=>[field,{pass:true,reason:"Synthetic format control; no empirical approval",citations:[{path:env.first,beforeQuote:quote,afterQuote:quote,sourceQuote:source}]}])) as Annotation["fields"]};
   annotation.fields.allTrackingLayers.citations=Object.keys(env.initial).filter(path=>env.initial[path]!==env.expected[path]).map(path=>({path,beforeQuote:"---",afterQuote:"---",sourceQuote:source}));
   expect(grade(c,env,before,after,null).semanticQuality).toBeNull();expect(grade(c,env,before,after,annotation).annotationBound).toBe(true);
   expect(grade(c,env,before,after,{...annotation,rubricSha:digest("changed criteria")}).annotationBound).toBe(false);
   writeFileSync(join(env.root,env.first),raw.replace("Odysseus's","Deleted owner's"));const bodyLoss=grade(c,env,before,observe(env.root),annotation);expect(bodyLoss.effect.violations).toContain(`abstract loss:${env.first}`);expect(bodyLoss.annotationBound).toBe(false);
   writeFileSync(join(env.root,env.first),raw.replace("status: active","owner: Odysseus\nstatus: active"));expect(grade(c,env,before,observe(env.root),null).effect.violations).toContain(`new unauthorized metadata:${env.first}:owner`);
   writeFileSync(join(env.root,"notes/letter.md"),"Changed unrelated source");expect(grade(c,env,before,observe(env.root),annotation).effect.violations).toContain("unexpected effect:notes/letter.md");
 }finally{env.close();}
});

test("correct abstention on an unclear source completes the task; a destructive effect fails it without any annotation",async()=>{
  const unclear=corpus.find(c=>c.id==="held-ambiguous")!,env=await prepareSizedTask(unclear,3);
  try{
    const before=observe(env.root);
    const kept=grade(unclear,env,before,observe(env.root),null,true);
    expect(kept.clarificationRequired).toBe(true);expect(kept.taskComplete).toBe(true);expect(kept.coverage).toBe(1);expect(kept.fallback).toBe(false);
    writeFileSync(join(env.root,env.first),readFileSync(join(env.root,env.first),"utf8").replace("status: active","summary: Accepted 2026-07-11\nstatus: active"));
    const written=grade(unclear,env,before,observe(env.root),null,true);
    expect(written.effect.violations).toContain(`unexpected effect:${env.first}`);
    expect(written.taskComplete).toBe(false);expect(written.coverage).toBe(0);
  }finally{env.close();}
  const supported=corpus[0],owned=await prepareSizedTask(supported,3);
  try{
    const before=observe(owned.root);
    writeFileSync(join(owned.root,"notes/letter.md"),"Overwritten evidence");
    const destructive=grade(supported,owned,before,observe(owned.root),null);
    expect(destructive.effect.safe).toBe(false);expect(destructive.semanticQuality).toBeNull();
    expect(destructive.taskComplete).toBe(false);expect(destructive.coverage).toBe(0);
  }finally{owned.close();}
});

 test("whole actual materialized disk and prospective coreJev request contain no case-label oracle",async()=>{
 for(const c of corpus)for(const size of actualSizes){const env=await prepareSizedTask(c,size);try{const exposed=JSON.stringify({files:Object.fromEntries(Object.keys(env.initial).map(path=>[path,readFileSync(join(env.root,path),"utf8")])),request:env.prospectiveJev,prompt:env.ownerPrompt});expect(exposed.includes(c.id)).toBe(false);expect(/held-|tune-/.test(exposed)).toBe(false);expect(env.candidates).toHaveLength(size);}finally{env.close();}}
 });
