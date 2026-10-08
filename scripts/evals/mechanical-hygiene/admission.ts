/** Root-controlled private dispatch gate; metadata is never model instruction authority. */
import { readFileSync } from "node:fs";
import { sourceFreeze } from "./freeze";
import { hash } from "./protocol";
import { assertWriteDayUTC } from "./write-day";
function assertDispatchAdmission(freezeSha:string,proofSha:string,planSha:string,purpose:"complementary-review"|"scored-comparison",writeDayUTC:string) {
  assertWriteDayUTC(writeDayUTC);
  if((purpose==="complementary-review"?process.env.BRAIN_LIVE_REVIEW:process.env.BRAIN_LIVE_EVAL)!=="842")throw Error("Explicit serialized842 native window required");
  const ledgerPath=process.env.BRAIN_HYGIENE_LEDGER,intentPath=process.env.BRAIN_HYGIENE_ADMISSION;
  if(!ledgerPath||!intentPath)throw Error("Root-owned protected actual-charge ledger and dispatch intent required");
  const ledger=JSON.parse(readFileSync(ledgerPath,"utf8")),intent=JSON.parse(readFileSync(intentPath,"utf8"));
  const allocations=Object.values(ledger.reservations??{}) as unknown[];
  if(ledger.capUsd!==150||ledger.perIssueCapUsd!==15||ledger.basis!=="actual additional billed charges"||ledger.claudeDispatchHold||ledger.reservations?.["842"]!==15||allocations.some(v=>typeof v!=="number"||!Number.isFinite(v)||v<0)||allocations.reduce<number>((sum,v)=>sum+Number(v),0)>150)throw Error("Actual-charge allocation or quota-hold prerequisite missing");
  const expiry=Date.parse(intent.expiresAt);
  if(intent.writeDayUTC!==writeDayUTC||intent.issue!==842||intent.purpose!==purpose||intent.subscriptionWindowOwner!==842||intent.quotaRecovered!==true||intent.extraUsageDisabled!==true||intent.sourceAuditApproved!==true||!Number.isFinite(expiry)||expiry<=Date.now()||expiry-Date.now()>12*60*60*1000||intent.freezeSha!==freezeSha||intent.proofSha!==proofSha||intent.planSha!==planSha||sourceFreeze().freezeSha!==freezeSha)throw Error("Protected exact-frozen review admission is absent, stale or mismatched");
  return{intentSha:hash(JSON.stringify(intent)),ledgerSha:hash(JSON.stringify(ledger)),reservedActualUsd:15,finalInvoiceSupplied:false};
}

export function assertReviewAdmission(freezeSha:string,proofSha:string,planSha:string,writeDayUTC:string){return assertDispatchAdmission(freezeSha,proofSha,planSha,"complementary-review",writeDayUTC);}
export interface ReviewArtifacts {effectsPath:string;proofPath:string;receipts:string[]}
export async function assertScoredAdmission(artifacts:ReviewArtifacts){
  const {completeReviewApproval}=await import("./review-approval");
  const inputs=completeReviewApproval(JSON.parse(readFileSync(artifacts.effectsPath,"utf8")),readFileSync(artifacts.proofPath,"utf8"),artifacts.receipts);
  return{...inputs,admission:assertDispatchAdmission(inputs.freezeSha,inputs.proofSha,inputs.planSha,"scored-comparison",inputs.writeDayUTC)};
}
