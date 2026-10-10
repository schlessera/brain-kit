// Fresh complementary Claude-family input review; root schedules the shared subscription window.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { overageState } from "../note-disposition/review";
import { credentialFields } from "../../../packages/ui-backend-claude/src/subscription";
import { runtimeFreeze, sha } from "./freeze";
import { MODEL } from "./protocol";
import { buildReviewPacket } from "./review-packets";
import { DETECTION_DAY } from "./benchmark";
import { collectReviewArtifacts } from "./review-native";
import { validateReviewEvidence } from "./review-evidence";
import { validPaidPolicy } from "./review-policy";
export { protectedReviewPrompt } from "./review-native";

async function main() {
 if(process.env.BRAIN_LIVE_REVIEW!=="841")throw Error("Only explicitly root-queued841 review may dispatch");
 const [destination,proofPath,detectedPath,key,policyPath]=process.argv.slice(2);
 if(!destination||existsSync(destination)||!proofPath||!detectedPath||!key||!policyPath)throw Error("Fresh output/proof/detected/packet/root-paid-policy required");
 if(new Date().toISOString().slice(0,10)!==DETECTION_DAY)throw Error("Actual detection day differs; rebuild proof and all packets");
 const frozen=runtimeFreeze(),proofRaw=readFileSync(proofPath,"utf8"),detectedRaw=readFileSync(detectedPath,"utf8");
 const built=buildReviewPacket(frozen,detectedRaw,proofRaw,key),paidPolicy=JSON.parse(readFileSync(policyPath,"utf8"));
 const runtime={sdk:frozen.binaries.claude.sdkVersion,nativeSha:frozen.binaries.claude.sha256,nativeMode:frozen.binaries.claude.mode,bunSha:frozen.binaries.bun.sha256,bunVersion:Bun.version,bunMode:frozen.binaries.bun.mode};
 if(!validPaidPolicy(paidPolicy,{freezeSha:frozen.freezeSha,promptSha:built.promptSha,runtime,proofSha:sha(proofRaw),detectedSha:sha(detectedRaw),protocolSha:sha(JSON.stringify(frozen.protocol))}) || paidPolicy.detectedSha!==sha(detectedRaw) || paidPolicy.protocolSha!==sha(JSON.stringify(frozen.protocol)))throw Error("Root policy does not bind fresh exact packet/runtime/input/protocol");
 // Root supplies only this child's protected token; no credential-file fallback or discovery.
 const token=process.env.CLAUDE_CODE_OAUTH_TOKEN;if(!token)throw Error("Root-supplied subscription credential required");
 const collected=await collectReviewArtifacts({directory:destination,payload:built.payload,frozen,token,kind:"subscription-native-direct",fetch:globalThis.fetch,paidPolicy,proofSha:sha(proofRaw),proofRaw,detectedRaw,packetKey:key});
 const n=collected.native;
 const receipt:any={model:MODEL,freezeSha:frozen.freezeSha,detectedSha:sha(detectedRaw),benchmarkSha:frozen.benchmarkSha,protocolSha:sha(JSON.stringify(frozen.protocol)),
 packet:built.packet,reviewPlanSha:built.reviewPlanSha,promptSha:built.promptSha,verificationSha:sha(proofRaw),reviewDriverSha:frozen.sources["scripts/evals/audit-capabilities/review.ts"],
 result:n.result,apiEquivalent:n.apiEquivalent,childClosed:{code:n.exitCode,signal:n.signalCode},failure:n.failure,cleanupFailure:n.termination,
 credentials:credentialFields(n.account),promptReleased:n.promptReleased,rateLimits:n.rates.map((r:any)=>r.rate_limit_info),
 init:{model:n.init?.model,apiKeySource:n.init?.apiKeySource,cli:n.init?.claude_code_version},subscriptionOverageState:overageState(n.rates.map((r:any)=>r.rate_limit_info)),
 subscriptionIncrementalUsd:null,evidence:collected.evidence,approval:"NOT_APPROVED",protectiveSdkApiEquivalentThresholdUsd:3,protectiveThresholdIsActualChargeCap:false};
 receipt.approval=validateReviewEvidence({freezeSha:frozen.freezeSha,promptSha:built.promptSha,runtime,paidPolicy,proofSha:sha(proofRaw),detectedSha:sha(detectedRaw),protocolSha:sha(JSON.stringify(frozen.protocol))},receipt.evidence)?"APPROVED":"NOT_APPROVED";
 writeFileSync(join(destination,"receipt.json"),JSON.stringify(receipt,null,2),{mode:0o600});
 console.log(JSON.stringify({packet:key,approval:receipt.approval,evidenceManifestSha:collected.evidence.manifestSha,apiEquivalent:n.apiEquivalent,invoiceUsd:null}));
 if(receipt.approval!=="APPROVED")process.exitCode=1;
}
if(import.meta.main)await main();
