/** Explicit offline integration only. No live admission, calibration or quality result. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { corpus, type CorpusCase } from "./corpus";
import { actualSizes, prepareSizedTask, ownerSteps, taskOwnerWrites } from "./task-input";
import { capture, plan, type Decision } from "./prototype";
import { observe, captureGuard, guardedApply } from "./full-observer";
import { observedClient } from "./jev-observer";
import { proposal, confirm, digest } from "./source-admission";
import { grade, type Annotation } from "./quality";
import { installSurface, runNative } from "./native";
export type Arm="current"|"explicit-owner"|"scripted-hybrid";
export interface CellOptions{arm:Arm;candidateSize:3|32|128;offline:true;output:string;floor?:number|null;ownerConfirmation?:(decision:Decision)=>{payloadSha:string;accepted:true}|null;fetch?:Parameters<typeof observedClient>[0];nativeFetch?:NonNullable<Parameters<typeof runNative>[4]>["fetch"];annotation?:Annotation|null;beforeApply?:(root:string)=>void}
export async function collectCell(c:CorpusCase,options:CellOptions){
  if(options.offline!==true)throw Error("No live speaking collector admission exists");
  if(options.arm==="scripted-hybrid"&&!options.fetch)throw Error("Modeled hybrid requires its explicit injected transport");
  if(options.arm==="current"&&(process.env.BRAIN_SPEAKING_OFFLINE!=="1"||!options.nativeFetch))throw Error("Current native control requires the actual offline namespace");
  const env=await prepareSizedTask(c,options.candidateSize),setupStarted=performance.now();mkdirSync(options.output,{recursive:true,mode:0o700});
  const physical=options.fetch?observedClient(options.fetch,calls=>writeFileSync(join(options.output,"jev-physical.json"),JSON.stringify(calls,null,2),{mode:0o600})):null;
  const repeatRefusals:unknown[]=[];
  let failure:string|null=null,native:unknown=null,after:ReturnType<typeof observe>|null=null,before:ReturnType<typeof observe>|null=null,abstained=false,writeCount=0,humanConfirmations=0,proposedCount=0,dryChanged=false,repeatChanged=false;
  const started=performance.now();
  let setupMs:number|null=null;
  try{
    installSurface(env.root);setupMs=performance.now()-setupStarted;before=observe(env.root);
    const inputSha=digest(JSON.stringify({caseId:c.id,size:options.candidateSize,source:c.source,ownerPrompt:env.ownerPrompt,tree:before}));
    writeFileSync(join(options.output,"input.json"),JSON.stringify({caseId:c.id,size:options.candidateSize,source:c.source,ownerPrompt:env.ownerPrompt,semanticTask:env.semanticTask,inputSha,before,setupMs},null,2),{mode:0o600});
    if(options.arm==="current"){
      native=await runNative(env.root,options.output,"sk-ant-oat01-offline-fixture-not-a-credential",env.ownerPrompt,{offline:true,offlineDeadlineMs:10000,fetch:options.nativeFetch!,allowedWrites:taskOwnerWrites(env)});
    }else{
      const steps=ownerSteps(c);if(!steps.length)abstained=true;
      for(const step of steps){
        let decision:Decision|null=step;
        if(options.arm==="scripted-hybrid"&&step.kind==="outcome"){
          const result=await physical!.judge(step.source,env.candidates);const unconfirmed=proposal(step.source,env.candidates,result.answers,options.floor??null);proposedCount+=Number(Boolean(unconfirmed));
          const owner=unconfirmed?options.ownerConfirmation?.(unconfirmed)??null:null;humanConfirmations+=Number(Boolean(owner));decision=unconfirmed?confirm(unconfirmed,owner):null;
        }else humanConfirmations++;
        if(!decision){abstained=true;continue;}
        const inputs=capture(env.root,env.brain.taxonomy),planned=await plan(inputs,env.brain.taxonomy,decision,env.paths,"2026-07-12"),sha=captureGuard(env.root);
        if(planned.refused.length)throw Error(`Candidate plan refusal: ${JSON.stringify(planned.refused)}`);
        const dryBefore=observe(env.root);guardedApply(env.root,planned,sha,true);dryChanged||=JSON.stringify(dryBefore)!==JSON.stringify(observe(env.root));
        options.beforeApply?.(env.root);const applied=guardedApply(env.root,planned,sha);
        if(applied.error||applied.stale.length)throw Error(`Candidate partial/stale application: ${JSON.stringify(applied)}`);
        writeCount+=applied.written.length;const once=observe(env.root),repeatPlan=await plan(capture(env.root,env.brain.taxonomy),env.brain.taxonomy,decision,env.paths,"2026-07-12");
        if(repeatPlan.refused.length)repeatRefusals.push(...repeatPlan.refused);
        const repeated=guardedApply(env.root,repeatPlan,captureGuard(env.root));if(repeated.error||repeated.stale.length)throw Error("Candidate repeat application failed");
        repeatChanged||=JSON.stringify(once)!==JSON.stringify(observe(env.root));
      }
    }
  }catch(error){failure=String(error);}
  finally{
    try{after=observe(env.root);}catch(error){failure??=String(error);}
    const retainedNative=existsSync(join(options.output,"native.json"))?JSON.parse(readFileSync(join(options.output,"native.json"),"utf8")):null;
    const nativePhysical=existsSync(join(options.output,"physical.json"))?JSON.parse(readFileSync(join(options.output,"physical.json"),"utf8")):[];
    const knownNativeEquivalent=nativePhysical.filter((call:any)=>call.forwarded&&call.apiEquivalent).reduce((sum:any,call:any)=>({lowerUsd:sum.lowerUsd+call.apiEquivalent.lowerUsd,upperUsd:sum.upperUsd+call.apiEquivalent.upperUsd}),{lowerUsd:0,upperUsd:0});
    const unknownNativeCalls=nativePhysical.filter((call:any)=>call.forwarded&&!call.apiEquivalent).length;
    const refusedNativeCalls=nativePhysical.filter((call:any)=>!call.forwarded).length;
    const quality=before&&after?grade(c,env,before,after,options.annotation??null,abstained):null;
    const candidateExactReference=after?Object.entries(env.expected).every(([path,raw])=>after![path]?.bytes===Buffer.from(raw).toString("base64")):null;
    const calls=physical?.calls??[];const unknownJevCalls=calls.filter(call=>call.priceDerivedUsd===null).length,knownJevEquivalentUsd=calls.reduce((sum,call)=>sum+(call.priceDerivedUsd??0),0);
    const row={executionKind:options.arm==="current"?"offline-native-scripted":"explicitly-modeled-offline",caseId:c.id,split:c.split,candidateSize:options.candidateSize,arm:options.arm,before,after,native,retainedNative,nativePhysical,knownNativeEquivalent,unknownNativeCalls,refusedNativeCalls,nativeEquivalent:unknownNativeCalls?null:knownNativeEquivalent,nativeAggregateUsageKnown:options.arm==="current"?Boolean(native&&!failure):null,physical:calls,failure,protocolComplete:!failure&&Boolean(before&&after)&&!dryChanged&&!repeatChanged&&(!physical||!physical.stopped),quality,candidateExactReference,semanticApproval:false,abstained,repeatRefusals,proposedCount,humanConfirmations,writeCount,dryChanged,repeatChanged,setupMs,elapsedIncludingSetupAndControlsMs:performance.now()-started,cacheUnknown:options.arm==="scripted-hybrid",actualInvoiceUsd:null,knownJevEquivalentUsd,unknownJevCalls,jevEquivalentUsd:unknownJevCalls?null:knownJevEquivalentUsd,liveQuality:null};
    writeFileSync(join(options.output,"cell.json"),JSON.stringify(row,null,2),{mode:0o600});env.close();
  }
  return JSON.parse(readFileSync(join(options.output,"cell.json"),"utf8"));
}
/** Modeled rows cannot become a measured comparison. Errors stop new admissions. */
export async function collectPreparation(output:string,options:Omit<CellOptions,"output"|"candidateSize">){
  const rows=[];outer:for(const c of corpus)for(const size of actualSizes){const row=await collectCell(c,{...options,candidateSize:size,output:join(output,`${c.id}-${size}`)});rows.push(row);if(!row.protocolComplete||row.quality?.effect.safe===false)break outer;if(size===128)continue;}
  return {rows,complete:rows.length===corpus.length*actualSizes.length&&rows.every(row=>row.protocolComplete),measuredComparison:false,semanticApproval:false,actualInvoiceUsd:null};
}
