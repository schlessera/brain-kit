/** Private native root grant entry; each consumer supplies its original frozen binding. */
import {lstatSync,readFileSync,writeFileSync} from "node:fs";
import {join} from "node:path";
import {NativeBudget,PAID_AUTHORIZATION,digest,validateNativePaidPolicy,type NativePaidPolicy,type NativeIssue,type NativeReservation} from "./native-paid-policy";
import {consumeGrant,type GrantClaim} from "./native-grant";
import {type ReviewBinding} from "./native-pricing";
// Fixture preload replaces Date construction/now, but retains the intrinsic
// constructor on its prototype. Budget/authorization clocks stay real.
const WallDate=Date.prototype.constructor as DateConstructor;
export const nativeWallTime=()=>new WallDate().getTime();
export function protectedNativeJson(path:string|undefined){
  if(!path)throw Error("Explicit protected native authority file required");
  const stat=lstatSync(path);if(!stat.isFile()||stat.isSymbolicLink()||stat.uid!==process.getuid?.()||(stat.mode&0o077))throw Error("Private native authority file required");
  const raw=readFileSync(path);return{raw,value:JSON.parse(raw.toString("utf8")),sha:digest(raw)};
}
export interface NativePaidEvidence {policy:NativePaidPolicy;policySha:string;binding:ReviewBinding;startedAtUtc:string;grant:GrantClaim;entries:NativeReservation[];rootAuthority?:{ledgerPath:string;intentPath:string;ledgerSha:string;intentSha:string}}
export function verifyConsumedNativeGrant(e:NativePaidEvidence,output:string){
  validateNativePaidPolicy(e.policy.issue,e.policy.control,e.policy,e.binding,nativeWallTime());
  if(e.rootAuthority){
    const a=e.rootAuthority,ledger=protectedNativeJson(a.ledgerPath),intent=protectedNativeJson(a.intentPath),expires=Date.parse(intent.value.expiresAt);
    if(ledger.sha!==a.ledgerSha||intent.sha!==a.intentSha||!Number.isFinite(expires)||nativeWallTime()>=expires)throw Error("Root native authority changed or window expired before USER release");
  }
  const original=protectedNativeJson(e.policy.consumedMarkerPath),copy=readFileSync(join(output,"paid-grant.json"));
  if(!original.raw.equals(copy)||original.sha!==e.grant.sha||JSON.stringify(original.value)!==JSON.stringify(e.grant.marker)||
    e.grant.marker.policySha!==digest(JSON.stringify(e.policy))||e.grant.marker.bindingSha!==digest(JSON.stringify(e.binding)))throw Error("Consumed original native grant differs");
}
export function openNativePaidEntry(options:{issue:NativeIssue;prefix:string;offline:boolean;purpose:"review"|"workflow";binding:ReviewBinding;output:string;
  save:(e:NativePaidEvidence)=>void;verifySource:()=>void;offlinePolicy?:NativePaidPolicy;nativeUserContextSha?:string}){
  const {issue,prefix,offline,purpose,binding,output}=options,control=offline?"offline":"live";
  const paths={policy:process.env[`${prefix}_PAID_POLICY`],ledger:process.env[`${prefix}_LEDGER`],intent:process.env[`${prefix}_ADMISSION`]};
  let reference:ReturnType<typeof protectedNativeJson>|undefined,authority:{ledger:ReturnType<typeof protectedNativeJson>;intent:ReturnType<typeof protectedNativeJson>}|undefined;
  let policy:NativePaidPolicy;
  if(offline){
    const grantNonce=digest(`offline${issue}:${output}`),now=nativeWallTime();
    policy=options.offlinePolicy??{...binding,...(options.nativeUserContextSha?{nativeUserContextSha:options.nativeUserContextSha}:{}),version:1,issue,control,purpose,authorizationUrl:PAID_AUTHORIZATION,allowOverage:true,basis:"actual additional billed charges",perIssueCapUsd:15,aggregateCapUsd:150,remainingUpperUsd:15,canonicalModel:"claude-sonnet-5-5",maxPhysicalRequests:24,maxInputBytes:5_000_000,contextWindowTokens:1_000_000,maxOutputTokens:128000,inputUsdPerMillionUpper:8,outputUsdPerMillionUpper:20,invoiceUsd:null,grantNonce,consumedMarkerPath:join(output,`${grantNonce}.json`),issuedAt:new WallDate(now-1000).toISOString(),expiresAt:new WallDate(now+60000).toISOString()};
  }else{
    if(options.offlinePolicy)throw Error("Live entry refuses supplied synthetic policy");
    reference=protectedNativeJson(paths.policy);policy=reference.value;
    if(digest(JSON.stringify(policy))!==process.env[`${prefix}_PAID_POLICY_SHA`])throw Error("Exact root native policy SHA required");
    authority={ledger:protectedNativeJson(paths.ledger),intent:protectedNativeJson(paths.intent)};
    const ledger=authority.ledger.value,intent=authority.intent.value,allocations=Object.values(ledger.reservations??{}) as unknown[];
    if(ledger.capUsd!==150||ledger.perIssueCapUsd!==15||ledger.basis!==policy.basis||ledger.reservations?.[String(issue)]!==15||
      allocations.some(v=>typeof v!=="number"||!Number.isFinite(v)||v<0)||allocations.reduce<number>((sum,v)=>sum+Number(v),0)>150||
      intent.issue!==issue||intent.subscriptionWindowOwner!==issue||intent.extraUsageAuthorized!==true||intent.sourceAuditApproved!==true||intent.paidPolicySha!==digest(JSON.stringify(policy))||
      Object.entries(binding).some(([key,value])=>intent[key]!==value))throw Error("Matching existing root allocation/serialized window required");
  }
  validateNativePaidPolicy(issue,control,policy,binding,nativeWallTime());
  if(policy.nativeUserContextSha!==options.nativeUserContextSha)throw Error("Root native fixture instruction binding differs");
  if(policy.purpose!==purpose||policy.remainingUpperUsd<(1_000_000*8+128000*20)/1e6)throw Error("Native purpose/remaining allocation refuses USER release");
  const startedAtUtc=new WallDate().toISOString(),grant=consumeGrant(policy,binding,nativeWallTime());
  const evidence:NativePaidEvidence={policy,policySha:digest(JSON.stringify(policy)),binding,startedAtUtc,grant,entries:[],...(authority?{rootAuthority:{ledgerPath:paths.ledger!,intentPath:paths.intent!,ledgerSha:authority.ledger.sha,intentSha:authority.intent.sha}}:{})};
  writeFileSync(join(output,"paid-grant.json"),readFileSync(policy.consumedMarkerPath),{mode:0o600});
  const save=()=>{writeFileSync(join(output,"paid.json"),JSON.stringify(evidence,null,2),{mode:0o600});options.save(evidence);};
  const budget=new NativeBudget(issue,control,policy,binding,entries=>{evidence.entries=entries;save();},nativeWallTime);save();
  function beforeRelease(){
    verifyConsumedNativeGrant(evidence,output);
    if(reference&&protectedNativeJson(paths.policy).sha!==reference.sha)throw Error("Root native policy bytes changed");
    if(authority){
      const ledger=protectedNativeJson(paths.ledger),intent=protectedNativeJson(paths.intent);
      const expires=Date.parse(intent.value.expiresAt);
      if(ledger.sha!==authority.ledger.sha||intent.sha!==authority.intent.sha||!Number.isFinite(expires)||nativeWallTime()>=expires)throw Error("Root native authority changed or window expired");
    }
  }
  beforeRelease();return{evidence,budget,beforeRelease,verify(){options.verifySource();beforeRelease();}};
}
