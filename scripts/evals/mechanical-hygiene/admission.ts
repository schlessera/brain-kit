/** Root-controlled private dispatch gate; metadata is never model instruction authority. */
import { readFileSync,lstatSync } from "node:fs";
import { sourceFreeze } from "./freeze";
import { hash } from "./protocol";
import { assertWriteDayUTC } from "./write-day";
import { rootPaidReference } from "./paid";
import { validateNativePaidPolicy } from "../native-paid-policy";
import { protocolSha } from "./protocol";
function protectedAuthority(path:string|undefined){
  if(!path)throw Error("Root-owned protected authority required");
  const stat=lstatSync(path);if(!stat.isFile()||stat.isSymbolicLink()||stat.uid!==process.getuid?.()||(stat.mode&0o077))throw Error("Private root ledger/intent required");
  return JSON.parse(readFileSync(path,"utf8"));
}
export function verifyHygieneAuthority(expected:{intentSha:string;ledgerSha:string}){
  const intent=protectedAuthority(process.env.BRAIN_HYGIENE_ADMISSION),expires=Date.parse(intent.expiresAt);
  if(!Number.isFinite(expires)||Date.now()>=expires)throw Error("Root serialized window expired before physical forwarding");
  if(hash(JSON.stringify(protectedAuthority(process.env.BRAIN_HYGIENE_LEDGER)))!==expected.ledgerSha||
    hash(JSON.stringify(intent))!==expected.intentSha)throw Error("Root ledger/intent changed before physical forwarding");
}
function assertDispatchAdmission(freezeSha:string,proofSha:string,planSha:string,purpose:"complementary-review"|"scored-comparison",writeDayUTC:string) {
  assertWriteDayUTC(writeDayUTC);
  if((purpose==="complementary-review"?process.env.BRAIN_LIVE_REVIEW:process.env.BRAIN_LIVE_EVAL)!=="842")throw Error("Explicit serialized842 native window required");
  const ledgerPath=process.env.BRAIN_HYGIENE_LEDGER,intentPath=process.env.BRAIN_HYGIENE_ADMISSION;
  if(!ledgerPath||!intentPath)throw Error("Root-owned protected actual-charge ledger and dispatch intent required");
  const ledger=protectedAuthority(ledgerPath),intent=protectedAuthority(intentPath);
  const allocations=Object.values(ledger.reservations??{}) as unknown[];
  if(ledger.capUsd!==150||ledger.perIssueCapUsd!==15||ledger.basis!=="actual additional billed charges"||(ledger.claudeDispatchHold&&intent.extraUsageAuthorized!==true)||ledger.reservations?.["842"]!==15||allocations.some(v=>typeof v!=="number"||!Number.isFinite(v)||v<0)||allocations.reduce<number>((sum,v)=>sum+Number(v),0)>150)throw Error("Actual-charge allocation or quota-hold prerequisite missing");
  const expiry=Date.parse(intent.expiresAt);
  const frozen=sourceFreeze(),root=rootPaidReference(),p=root.policy;
  const binding={freezeSha,inputSha:planSha,proofSha,protocolSha,runtimeSha:hash(JSON.stringify(frozen.runtime)),promptSha:p.promptSha};
  validateNativePaidPolicy(842,"live",p,binding);
  if(p.purpose!==(purpose==="complementary-review"?"review":"workflow")||p.remainingUpperUsd>ledger.reservations["842"]||intent.paidPolicySha!==root.sha||intent.extraUsageAuthorized!==true)throw Error("Matching protected root paid allocation required");
  if(intent.writeDayUTC!==writeDayUTC||intent.issue!==842||intent.purpose!==purpose||intent.subscriptionWindowOwner!==842||intent.sourceAuditApproved!==true||!Number.isFinite(expiry)||expiry<=Date.now()||expiry-Date.now()>12*60*60*1000||intent.freezeSha!==freezeSha||intent.proofSha!==proofSha||intent.planSha!==planSha||frozen.freezeSha!==freezeSha)throw Error("Protected exact-frozen review admission is absent, stale or mismatched");
  return{intentSha:hash(JSON.stringify(intent)),ledgerSha:hash(JSON.stringify(ledger)),paidPolicySha:root.sha,remainingUpperUsd:p.remainingUpperUsd,proofSha,planSha,reservedActualUsd:15,finalInvoiceSupplied:false};
}

export function assertReviewAdmission(freezeSha:string,proofSha:string,planSha:string,writeDayUTC:string){return assertDispatchAdmission(freezeSha,proofSha,planSha,"complementary-review",writeDayUTC);}
export interface ReviewArtifacts {effectsPath:string;proofPath:string;receipts:string[]}
export async function assertScoredAdmission(artifacts:ReviewArtifacts){
  const {completeReviewApproval}=await import("./review-approval");
  const inputs=completeReviewApproval(JSON.parse(readFileSync(artifacts.effectsPath,"utf8")),readFileSync(artifacts.proofPath,"utf8"),artifacts.receipts);
  return{...inputs,admission:assertDispatchAdmission(inputs.freezeSha,inputs.proofSha,inputs.planSha,"scored-comparison",inputs.writeDayUTC)};
}
