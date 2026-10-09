/** Concrete842 root allocation and consumed grant; importing this module dispatches nothing. */
import { readFileSync,lstatSync,writeFileSync } from "node:fs";
import { dirname,join } from "node:path";
import { NativeBudget,PAID_AUTHORIZATION,digest,validateNativePaidPolicy,type NativePaidPolicy,type NativeReservation } from "../native-paid-policy";
import { consumeGrant,validGrantEvidence,type GrantClaim } from "../../../packages/ui-server/evals/triage/experiment/grant";
import { type ReviewBinding } from "../../../packages/ui-server/evals/triage/experiment/paid-policy";
import { sourceFreeze } from "./freeze";
import { protocolSha } from "./protocol";

export function rootPaidReference(){
  const path=process.env.BRAIN_HYGIENE_PAID_POLICY,expected=process.env.BRAIN_HYGIENE_PAID_POLICY_SHA;
  if(!path||!expected)throw Error("Explicit root paid policy file and SHA required");
  const stat=lstatSync(path);if(!stat.isFile()||stat.isSymbolicLink()||stat.uid!==process.getuid?.()||(stat.mode&0o077))throw Error("Private root paid policy required");
  const raw=readFileSync(path,"utf8"),policy:NativePaidPolicy=JSON.parse(raw),sha=digest(JSON.stringify(policy));
  if(sha!==expected)throw Error("Root paid policy changed");return{policy,sha,rawSha:digest(raw)};
}
export interface HygienePaidEvidence {
  policy:NativePaidPolicy;policySha:string;binding:ReviewBinding;startedAtUtc:string;grant:GrantClaim;
  entries:NativeReservation[];
}
export function openHygienePaid(options:{offline:boolean;reviewing:boolean;prompt:string;destination:string;
  proofSha?:string;planSha?:string;save:(evidence:HygienePaidEvidence)=>void;policy?:NativePaidPolicy}){
  const frozen=sourceFreeze(),control=options.offline?"offline":"live",purpose=options.reviewing?"review":"workflow";
  const binding:ReviewBinding={freezeSha:frozen.freezeSha,inputSha:options.planSha??digest("offline842 input"),
    proofSha:options.proofSha??digest("offline842 proof"),protocolSha,runtimeSha:digest(JSON.stringify(frozen.runtime)),promptSha:digest(options.prompt)};
  let policy:NativePaidPolicy,reference:ReturnType<typeof rootPaidReference>|undefined;
  if(options.offline){
    const nonce=digest(`offline842:${options.destination}`);
    policy=options.policy??{...binding,version:1,issue:842,control,purpose,authorizationUrl:PAID_AUTHORIZATION,allowOverage:true,
      basis:"actual additional billed charges",perIssueCapUsd:15,aggregateCapUsd:150,remainingUpperUsd:15,canonicalModel:"claude-sonnet-5-5",
      maxPhysicalRequests:24,maxInputBytes:5_000_000,contextWindowTokens:1_000_000,maxOutputTokens:128000,inputUsdPerMillionUpper:8,outputUsdPerMillionUpper:20,invoiceUsd:null,
      grantNonce:nonce,consumedMarkerPath:join(dirname(options.destination),`${nonce}.json`),issuedAt:new Date(Date.now()-1000).toISOString(),expiresAt:new Date(Date.now()+60000).toISOString()};
  }else{if(options.policy)throw Error("Live root allocation must come from the protected literal policy");reference=rootPaidReference();policy=reference.policy;}
  validateNativePaidPolicy(842,control,policy,binding);if(policy.purpose!==purpose)throw Error("Root native purpose differs from reviewed entry");
  // No USER release unless the allocation holds the supported output maximum.
  // The relay reserves the exact physical max_tokens before forwarding.
  if(policy.remainingUpperUsd<(1_000_000*8+128000*20)/1e6)throw Error("Native allocation insufficient before prompt release");
  const startedAtUtc=new Date().toISOString(),grant=consumeGrant(policy,binding);
  const evidence:HygienePaidEvidence={policy,policySha:digest(JSON.stringify(policy)),binding,startedAtUtc,grant,entries:[]};
  writeFileSync(join(options.destination,"paid-grant.json"),readFileSync(policy.consumedMarkerPath),{mode:0o600});
  const budget=new NativeBudget(842,control,policy,binding,entries=>{evidence.entries=entries;options.save(evidence);});options.save(evidence);
  function beforeRelease(){
    validateNativePaidPolicy(842,control,policy,binding);
    if(reference&&rootPaidReference().rawSha!==reference.rawSha)throw Error("Root policy bytes changed before physical forwarding");
    if(!validGrantEvidence(policy,binding,readFileSync(join(options.destination,"paid-grant.json")),grant.sha,startedAtUtc,Date.now()))throw Error("Exact consumed native grant changed before forwarding");
  }
  return{budget,evidence,beforeRelease,verify(){
    if(sourceFreeze().freezeSha!==frozen.freezeSha)throw Error("Current complete source/runtime changed before physical forwarding");beforeRelease();
  }};
}
