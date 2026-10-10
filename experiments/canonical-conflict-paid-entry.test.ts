import {expect,test} from "bun:test";
import {mkdtempSync,writeFileSync,rmSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {openNativePaidEntry,verifyConsumedNativeGrant} from "../scripts/evals/native-paid-entry";
import {NativeBudget,PAID_AUTHORIZATION,digest,type NativePaidPolicy} from "../scripts/evals/native-paid-policy";
const prompt="Odysseus complete review",context="Unchanged fixture instruction block";
const binding={freezeSha:digest("source"),inputSha:digest("input"),protocolSha:digest("protocol"),runtimeSha:digest("runtime"),proofSha:digest("proof"),promptSha:digest(prompt)};
function policy(directory:string):NativePaidPolicy{
  const now=Date.now(),grantNonce=digest(directory);
  return {...binding,version:1,issue:843,control:"offline",purpose:"review",authorizationUrl:PAID_AUTHORIZATION,allowOverage:true,basis:"actual additional billed charges",perIssueCapUsd:15,aggregateCapUsd:150,remainingUpperUsd:15,canonicalModel:"claude-sonnet-5-5",maxPhysicalRequests:24,maxInputBytes:5_000_000,contextWindowTokens:1_000_000,maxOutputTokens:128000,inputUsdPerMillionUpper:8,outputUsdPerMillionUpper:20,invoiceUsd:null,grantNonce,consumedMarkerPath:join(directory,grantNonce+".json"),issuedAt:new Date(now-1000).toISOString(),expiresAt:new Date(now+60000).toISOString()};
}
test("concrete USER release refuses original-grant replacement, reuse, wrong scope and insufficient reservation",()=>{
  const directory=mkdtempSync(join(tmpdir(),"canonical-grant-controls-"));
  try{
    const p=policy(directory),open=()=>openNativePaidEntry({issue:843,prefix:"CONTROL",offline:true,purpose:"review",binding,output:directory,offlinePolicy:p,save:()=>{},verifySource:()=>{}}),entry=open();
    expect(()=>entry.beforeRelease()).not.toThrow();expect(()=>open()).toThrow("EEXIST");
    writeFileSync(p.consumedMarkerPath,"{}",{mode:0o600});expect(()=>entry.beforeRelease()).toThrow("Consumed original native grant differs");
    for(const [i,change] of [{issue:844},{remainingUpperUsd:10},{inputSha:digest("other")},{expiresAt:new Date(0).toISOString()}].entries()){
      const nonce=digest(`${directory}:refusal:${i}`),fresh={...p,grantNonce:nonce,consumedMarkerPath:join(directory,nonce+".json"),...change} as NativePaidPolicy;
      expect(()=>openNativePaidEntry({issue:843,prefix:"CONTROL",offline:true,purpose:"review",binding,output:directory,offlinePolicy:fresh,save:()=>{},verifySource:()=>{}})).toThrow(i===1?"remaining allocation refuses USER":"mismatched");
    }
  }finally{rmSync(directory,{recursive:true,force:true});}
});
test("serialized root window and source are rechecked before USER and every physical forward",()=>{
  const directory=mkdtempSync(join(tmpdir(),"canonical-root-controls-")),prefix="BRAIN_CANONICAL_CONTROL",names=[`${prefix}_PAID_POLICY`,`${prefix}_PAID_POLICY_SHA`,`${prefix}_LEDGER`,`${prefix}_ADMISSION`],saved=names.map(n=>process.env[n]);
  try{
    const p={...policy(directory),control:"live" as const},policyPath=join(directory,"policy.json"),ledgerPath=join(directory,"ledger.json"),intentPath=join(directory,"intent.json");
    const intent={...binding,issue:843,subscriptionWindowOwner:843,extraUsageAuthorized:true,sourceAuditApproved:true,paidPolicySha:digest(JSON.stringify(p)),expiresAt:p.expiresAt};
    writeFileSync(policyPath,JSON.stringify(p),{mode:0o600});writeFileSync(ledgerPath,JSON.stringify({capUsd:150,perIssueCapUsd:15,basis:p.basis,reservations:{843:15}}),{mode:0o600});writeFileSync(intentPath,JSON.stringify(intent),{mode:0o600});
    [policyPath,digest(JSON.stringify(p)),ledgerPath,intentPath].forEach((v,i)=>process.env[names[i]!]=v);
    let current=true;const entry=openNativePaidEntry({issue:843,prefix,offline:false,purpose:"review",binding,output:directory,save:()=>{},verifySource(){if(!current)throw Error("Source changed");}});
    expect(()=>entry.verify()).not.toThrow();current=false;expect(()=>entry.verify()).toThrow("Source changed");current=true;
    const original=entry.evidence.rootAuthority!;
    writeFileSync(intentPath,JSON.stringify({...intent,expiresAt:new Date(0).toISOString()}),{mode:0o600});
    // Matching new bytes still cannot make an expired serialized window valid.
    const changed={...entry.evidence,rootAuthority:{...original,intentSha:digest(JSON.stringify({...intent,expiresAt:new Date(0).toISOString()}))}};
    expect(()=>verifyConsumedNativeGrant(changed,directory)).toThrow("window expired before USER");
    expect(()=>entry.beforeRelease()).toThrow("authority changed");
  }finally{names.forEach((n,i)=>{if(saved[i]===undefined)delete process.env[n];else process.env[n]=saved[i];});rmSync(directory,{recursive:true,force:true});}
});
test("native fixture context admits only its exact root-bound block and sole frozen prompt",()=>{
  const directory=mkdtempSync(join(tmpdir(),"canonical-context-controls-"));
  try{
    const p={...policy(directory),nativeUserContextSha:digest(context)},request=(blocks:any[])=>Buffer.from(JSON.stringify({model:p.canonicalModel,max_tokens:8000,tools:[],output_config:{effort:"low"},messages:[{role:"user",content:blocks}]}));
    const blocks=[{type:"text",text:context},{type:"text",text:prompt}],budget=()=>new NativeBudget(843,"offline",p,binding,()=>{});
    expect(budget().reserve(request(blocks))).toBe(0);
    for(const bad of [[{type:"text",text:"Changed fixture instruction"},blocks[1]],[...blocks,{type:"text",text:"Unreviewed instruction"}],[blocks[1],blocks[0]]])expect(()=>budget().reserve(request(bad))).toThrow("USER");
    expect(()=>new NativeBudget(842,"offline",{...p,issue:842},binding,()=>{})).toThrow("mismatched");
  }finally{rmSync(directory,{recursive:true,force:true});}
});
