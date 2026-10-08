import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runNativePhase } from "../scripts/evals/mechanical-hygiene/native-driver";
import { assertReviewAdmission } from "../scripts/evals/mechanical-hygiene/admission";

test("actual native entry refuses the root quota hold before setup or any credential/transport use",async()=>{
  const root=mkdtempSync("/tmp/hygiene-admission-control-"),ledger=join(root,"ledger.json"),intent=join(root,"intent.json");
  const keys=["BRAIN_LIVE_REVIEW","BRAIN_HYGIENE_LEDGER","BRAIN_HYGIENE_ADMISSION"] as const,old=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
  try{
    process.env.BRAIN_LIVE_REVIEW="842";process.env.BRAIN_HYGIENE_LEDGER=ledger;process.env.BRAIN_HYGIENE_ADMISSION=intent;
    writeFileSync(ledger,JSON.stringify({capUsd:150,perIssueCapUsd:15,basis:"actual additional billed charges",reservations:{842:15},claudeDispatchHold:{reason:"Controlled unavailable quota"}}),{mode:0o600});
    // This is deliberately a scoped admission control. It never releases a
    // prompt or creates a provider-capable subprocess, even under mutation.
    writeFileSync(intent,JSON.stringify({issue:842,purpose:"complementary-review",subscriptionWindowOwner:842,quotaRecovered:true,extraUsageDisabled:true,sourceAuditApproved:true,expiresAt:new Date(Date.now()+60000).toISOString(),freezeSha:"stale",proofSha:"proof",planSha:"plan"}),{mode:0o600});
    expect(()=>assertReviewAdmission("stale","proof","plan")).toThrow("quota-hold prerequisite");
    let physical=0;
    await expect(runNativePhase({root:"/missing-setup-must-not-run",source:"/missing-source-must-not-run",destination:join(root,"must-not-exist"),phase:"dry-run",token:"controlled-not-a-credential",offline:false,purpose:"complementary-review",reviewBinding:{freezeSha:"stale",proofSha:"proof",planSha:"plan"},physicalFetch:async()=>{physical++;throw Error("Unexpected physical call");}})).rejects.toThrow("quota-hold prerequisite");
    expect(physical).toBe(0);
  }finally{for(const key of keys)if(old[key]===undefined)delete process.env[key];else process.env[key]=old[key];rmSync(root,{recursive:true,force:true});}
});
