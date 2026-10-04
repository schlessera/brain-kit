/** Offline runtime controls. Agent/JEV calls and comparative savings are unmeasured. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { classificationDrafts, fixtures, FIXTURE_SHA, prepare, run, snapshot } from "./fixtures";
import { capture, questions } from "./prototype";
import { createHash } from "node:crypto";

const percentile = (values: number[], fraction: number) => values.toSorted((a,b)=>a-b)[Math.ceil(values.length*fraction)-1];
export async function report(repeats=3) {
  const results=[];
  const timing:Record<string,number[]>={deterministic:[],scriptedHybrid:[]};
  for(const hybrid of [false,true]) {
    let exact=0,dryDiff=0,repeatDiff=0,untouchedMtimeChurn=0;
    const cases=[];
    for(const fixture of fixtures) {
      const env=prepare(fixture);
      try {
        const before=snapshot(env);
        await run(env,fixture,true,hybrid);
        dryDiff+=Number(JSON.stringify(before)!==JSON.stringify(snapshot(env)));
        const started=performance.now();
        const outcomes=[];
        for(const step of fixture.steps){
          outcomes.push(...await run(env,{...fixture,steps:[step]},false,hybrid));
          const once=snapshot(env);
          await run(env,{...fixture,steps:[step]},false,hybrid);
          repeatDiff+=Number(JSON.stringify(once)!==JSON.stringify(snapshot(env)));
        }
        const elapsed=performance.now()-started;
        const agreement=Object.entries(env.expected).every(([path,raw])=>readFileSync(join(env.root,path),"utf8")===raw);
        exact+=Number(agreement);
        const touched=[...new Set(outcomes.flatMap(o=>o.applied.written))];
        const after=snapshot(env);
        untouchedMtimeChurn+=Object.keys(env.initial).filter(p=>!touched.includes(p)&&before[p].mtimeMs!==after[p].mtimeMs).length;
        cases.push({id:fixture.id,exact:agreement,writes:touched,refused:outcomes.flatMap(o=>o.proposed.refused),elapsedIncludingStepRepeatsMs:elapsed});
      } finally {env.close();}
    }
    results.push({arm:hybrid?"scripted hybrid control":"explicit deterministic input",exact,cases:fixtures.length,dryDiff,repeatDiff,untouchedMtimeChurn,details:cases});
    for(let i=0;i<repeats;i++) {
      const fixture=fixtures[4],env=prepare(fixture);
      try{const started=performance.now();await run(env,fixture,false,hybrid);timing[hybrid?"scriptedHybrid":"deterministic"].push(performance.now()-started);}finally{env.close();}
    }
  }
  const env=prepare(fixtures[4]);
  let requestSha;
  try{requestSha=createHash("sha256").update(JSON.stringify(classificationDrafts.map(f=>questions(capture(env.root,env.taxonomy),f.source)))).digest("hex");}finally{env.close();}
  return {fixtureSha256:FIXTURE_SHA,requestSha256:requestSha,classificationDraftCount:classificationDrafts.length,runtime:{bun:Bun.version,documents:13,repeats,timing:Object.fromEntries(Object.entries(timing).map(([arm,samples])=>[arm,{samples,p50:percentile(samples,.5),p95:percentile(samples,.95)}]))},results,model:{actualAgent:null,actualJev:null,targetPrecision:null,outcomePrecision:null,tokens:null,cost:null,cache:null,retries:null,fallbacks:null},inferenceCalls:0};
}
if(import.meta.main) console.log(JSON.stringify(await report(),null,2));
