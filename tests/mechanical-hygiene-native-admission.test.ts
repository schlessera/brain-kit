import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runNativePhase } from "../scripts/evals/mechanical-hygiene/native-driver";
import { assertReviewAdmission,verifyHygieneAuthority } from "../scripts/evals/mechanical-hygiene/admission";
import {hash} from "../scripts/evals/mechanical-hygiene/protocol";

test("actual native entry refuses the root quota hold before setup or any credential/transport use",async()=>{
  const root=mkdtempSync("/tmp/hygiene-admission-control-"),ledger=join(root,"ledger.json"),intent=join(root,"intent.json");
  const keys=["BRAIN_LIVE_REVIEW","BRAIN_HYGIENE_LEDGER","BRAIN_HYGIENE_ADMISSION"] as const,old=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
  try{
    process.env.BRAIN_LIVE_REVIEW="842";process.env.BRAIN_HYGIENE_LEDGER=ledger;process.env.BRAIN_HYGIENE_ADMISSION=intent;
    writeFileSync(ledger,JSON.stringify({capUsd:150,perIssueCapUsd:15,basis:"actual additional billed charges",reservations:{842:15},claudeDispatchHold:{reason:"Controlled unavailable quota"}}),{mode:0o600});
    // This is deliberately a scoped admission control. It never releases a
    // prompt or creates a provider-capable subprocess, even under mutation.
    writeFileSync(intent,JSON.stringify({issue:842,purpose:"complementary-review",subscriptionWindowOwner:842,quotaRecovered:true,extraUsageDisabled:true,sourceAuditApproved:true,expiresAt:new Date(Date.now()+60000).toISOString(),freezeSha:"stale",proofSha:"proof",planSha:"plan"}),{mode:0o600});
    expect(()=>assertReviewAdmission("stale","proof","plan",new Date().toISOString().slice(0,10))).toThrow("quota-hold prerequisite");
    let physical=0;
    await expect(runNativePhase({root:"/missing-setup-must-not-run",source:"/missing-source-must-not-run",destination:join(root,"must-not-exist"),phase:"dry-run",token:"controlled-not-a-credential",offline:false,purpose:"complementary-review",reviewBinding:{writeDayUTC:new Date().toISOString().slice(0,10),freezeSha:"stale",proofSha:"proof",planSha:"plan"},physicalFetch:async()=>{physical++;throw Error("Unexpected physical call");}})).rejects.toThrow("quota-hold prerequisite");
    expect(physical).toBe(0);
  }finally{for(const key of keys)if(old[key]===undefined)delete process.env[key];else process.env[key]=old[key];rmSync(root,{recursive:true,force:true});}
});
test("literal root authority changes stop the lowest physical request method",async()=>{
  const root=mkdtempSync("/tmp/hygiene-authority-control-"),ledger=join(root,"ledger.json"),intent=join(root,"intent.json");
  const keys=["BRAIN_HYGIENE_LEDGER","BRAIN_HYGIENE_ADMISSION"] as const,old=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
  let forwarded=0;
  try{
    const l={remainingUpperUsd:15},i={subscriptionWindowOwner:842,expiresAt:new Date(Date.now()+60000).toISOString()};writeFileSync(ledger,JSON.stringify(l),{mode:0o600});writeFileSync(intent,JSON.stringify(i),{mode:0o600});
    process.env.BRAIN_HYGIENE_LEDGER=ledger;process.env.BRAIN_HYGIENE_ADMISSION=intent;
    const expected={ledgerSha:hash(JSON.stringify(l)),intentSha:hash(JSON.stringify(i))};
    const dispatch=async(authority=expected)=>{verifyHygieneAuthority(authority);forwarded++;};
    await dispatch();expect(forwarded).toBe(1);
    writeFileSync(ledger,JSON.stringify({remainingUpperUsd:.01}));await expect(dispatch()).rejects.toThrow("Root ledger/intent changed");expect(forwarded).toBe(1);
    writeFileSync(ledger,JSON.stringify(l));writeFileSync(intent,JSON.stringify({...i,subscriptionWindowOwner:843}));await expect(dispatch()).rejects.toThrow("Root ledger/intent changed");expect(forwarded).toBe(1);
    const expired={...i,expiresAt:new Date(0).toISOString()};writeFileSync(intent,JSON.stringify(expired));
    await expect(dispatch({...expected,intentSha:hash(JSON.stringify(expired))})).rejects.toThrow("Root serialized window expired");expect(forwarded).toBe(1);
  }finally{for(const key of keys)if(old[key]===undefined)delete process.env[key];else process.env[key]=old[key];rmSync(root,{recursive:true,force:true});}
});
