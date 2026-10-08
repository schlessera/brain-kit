/** Every exact lossless packet needs a real complete independent receipt. */
import { readFileSync } from "node:fs";
import { buildReviewPackets } from "./review-packets";
import { assertNativeEvidence } from "./collector";
import { reconcilePhysicalUsage, runtime } from "./native-driver";
import { priceSonnet55Usage } from "../../measure-sonnet55-cost";
export function completeReviewApproval(effects:any[],proofRaw:string,paths:string[]){
  const built=buildReviewPackets(effects,proofRaw);
  if(paths.length!==built.packets.length)throw Error("Every exact-frozen packet approval remains required");
  const expected=new Map(built.packets.map(packet=>[packet.id,packet]));
  for(const path of paths){
    const review=JSON.parse(readFileSync(path,"utf8")),packet=expected.get(review.packetId);
    if(!packet||review.promptSha!==packet.promptSha||review.freezeSha!==built.freeze.freezeSha||review.proofSha!==built.plan.proofSha||review.planSha!==built.planSha||review.model!==runtime.model||review.approval!=="APPROVED"||review.failure)throw Error("Mismatched, duplicate, incomplete or unapproved packet receipt");
    expected.delete(review.packetId);const native=review.native;
    assertNativeEvidence(native.native);
    if(native.runtimePair.sdk!==runtime.sdk||native.runtimePair.cli!==runtime.cli||native.executionKind!=="live-subscription"||!native.admissionEvidence||JSON.stringify(native.admissionEvidence)!==JSON.stringify(review.admission))throw Error("Scripted controls cannot supply independent model-family approval");
    if(!native.promptReleased||!native.settingsChecked||native.accountRoute?.accepted!==true||native.accountRoute?.tokenSource!=="CLAUDE_CODE_OAUTH_TOKEN"||native.accountRoute?.apiKeySource!=="none"||native.accountRoute?.apiProvider!=="firstParty"||native.init?.model!==runtime.model||native.init?.cli!==runtime.cli||native.init?.apiKeySource!=="none"||native.childClose?.code!==0||native.childClose?.signal!==null||native.forcedKill||!native.stdoutComplete||!native.stderrComplete||native.tools.length||native.result?.subtype!=="success"||native.result?.is_error||!/^APPROVED\b/.test(native.result?.result??""))throw Error("Real native review identity, tool-free approval or closure missing");
    reconcilePhysicalUsage(native.result,native.physicalCalls);
    if(JSON.stringify(priceSonnet55Usage(native.result))!==JSON.stringify(native.apiEquivalent))throw Error("Review usage price receipt differs from independent derivation");
    const promptSeen=native.physicalCalls.some((call:any)=>{
      const request=JSON.parse(call.requestBody);
      return request.messages?.some((message:any)=>message.role==="user"&&(message.content===packet.payload||Array.isArray(message.content)&&message.content.some((block:any)=>block.type==="text"&&block.text===packet.payload)));
    });
    if(!promptSeen)throw Error("Approval lacks the actual exact model-bound packet");
  }
  if(expected.size)throw Error("Missing packet approvals");
  return{freezeSha:built.freeze.freezeSha,planSha:built.planSha,proofSha:built.plan.proofSha,complete:true as const};
}
