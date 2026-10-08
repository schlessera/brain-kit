/** Future serialized complementary review. Quota hold is a hard gate, never bypassed. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildReviewPackets } from "./review-packets";
import { assertReviewAdmission } from "./admission";
import { runNativePhase } from "./native-driver";
import { assertNativeEvidence } from "./collector";
async function main(){
  const [destination,proofPath,effectsPath,packetId]=process.argv.slice(2);
  if(!destination||existsSync(destination)||!proofPath||!effectsPath||!packetId)throw Error("Require fresh protected destination and exact proof/effects/packetID");
  const proofRaw=readFileSync(proofPath,"utf8"),effects=JSON.parse(readFileSync(effectsPath,"utf8"));
  const built=buildReviewPackets(effects,proofRaw),packet=built.packets.find(p=>p.id===packetId);
  if(!packet)throw Error("Unknown complete review packet");
  const admission=assertReviewAdmission(built.freeze.freezeSha,built.plan.proofSha,built.planSha);
  // Only after the non-secret gates pass, read the existing approved login into
  // this process's memory. Never copy its credential file or print values.
  const token=process.env.CLAUDE_CODE_OAUTH_TOKEN??JSON.parse(readFileSync(join(process.env.HOME!,".claude/.credentials.json"),"utf8"))?.claudeAiOauth?.accessToken;
  if(typeof token!=="string"||!token.trim())throw Error("Protected subscription access absent");
  mkdirSync(destination,{mode:0o700});const root=join(destination,"review-root");mkdirSync(root,{mode:0o700});
  const native=await runNativePhase({root,source: new URL("../../../",import.meta.url).pathname,destination:join(destination,"native"),phase:"dry-run",token,offline:false,purpose:"complementary-review",reviewBinding:{freezeSha:built.freeze.freezeSha,proofSha:built.plan.proofSha,planSha:built.planSha},prompt:packet.payload,deadlineMs:180000});
  let failure:string|null=null;try{assertNativeEvidence(native.native);}catch(error){failure=String(error);}
  const approval=!failure&&/^APPROVED\b/.test(native.result?.result??"")&&!native.native.failure?"APPROVED":"NOT_APPROVED";
  const result={packetId,promptSha:packet.promptSha,freezeSha:built.freeze.freezeSha,proofSha:built.plan.proofSha,planSha:built.planSha,admission,model:"claude-sonnet-5-5",approval,native,failure,operationalSdkApiEquivalentLimitUsd:3,operationalLimitIsActualChargeCap:false,actualAdditionalBilledUsd:null,finalInvoiceSupplied:false};
  writeFileSync(join(destination,"review.json"),JSON.stringify(result,null,2),{mode:0o600});
  // Public output contains no account IDs, raw prompt/frames, balances or paths.
  console.log(JSON.stringify({packetId,promptSha:packet.promptSha,freezeSha:built.freeze.freezeSha,approval,model:result.model,apiEquivalent:native.apiEquivalent,overage:native.native.overage,ownedChildDrained:native.native.ownedChildDrained,failure:failure||native.native.failure?"Review receipt incomplete; inspect protected evidence":null}));
  if(approval!=="APPROVED")process.exitCode=1;
}
if(import.meta.main)await main();
