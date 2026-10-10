/** Every exact lossless packet needs a real complete independent receipt. */
import { readFileSync } from "node:fs";
import {dirname,join} from "node:path";
import { buildReviewPackets } from "./review-packets";
import { assertNativeEvidence } from "./collector";
import { reconcilePhysicalUsage, runtime } from "./native-driver";
import { priceSonnet55Usage } from "../../measure-sonnet55-cost";
import {literalNativeFrames,digest} from "../native-paid-policy";
export function completeReviewApproval(effects:any[],proofRaw:string,paths:string[]){
  const built=buildReviewPackets(effects,proofRaw);
  if(paths.length!==built.packets.length)throw Error("Every exact-frozen packet approval remains required");
  const expected=new Map(built.packets.map(packet=>[packet.id,packet]));
  for(const path of paths){
    const review=JSON.parse(readFileSync(path,"utf8")),packet=expected.get(review.packetId);
    if(review.writeDayUTC!==built.plan.writeDayUTC||!packet||review.promptSha!==packet.promptSha||review.freezeSha!==built.freeze.freezeSha||review.proofSha!==built.plan.proofSha||review.planSha!==built.planSha||review.model!==runtime.model||review.approval!=="APPROVED"||review.failure)throw Error("Mismatched, duplicate, incomplete or unapproved packet receipt");
    expected.delete(review.packetId);const native=review.native;
    if(JSON.stringify(JSON.parse(readFileSync(join(dirname(path),"native/receipt.json"),"utf8")))!==JSON.stringify(native)||
      readFileSync(join(dirname(path),"native/native-stdout.jsonl")).toString("base64")!==native.rawNative?.stdoutBase64||
      readFileSync(join(dirname(path),"native/native-stderr.txt")).toString("base64")!==native.rawNative?.stderrBase64)throw Error("Review differs from protected actual native artifacts");
    assertNativeEvidence(native.native);
    if(!native.paid||native.paid.policy.control!=="live"||native.paid.policy.issue!==842||native.paid.policy.purpose!=="review")throw Error("Scripted or unbudgeted controls cannot supply semantic approval");
    const binding={freezeSha:built.freeze.freezeSha,inputSha:built.planSha,proofSha:built.plan.proofSha,protocolSha:built.freeze.protocolSha,runtimeSha:digest(JSON.stringify(built.freeze.runtime)),promptSha:packet.promptSha};
    if(JSON.stringify(native.paid.binding)!==JSON.stringify(binding)||JSON.stringify(native.paid)!==JSON.stringify(native.native.paid)||JSON.stringify(native.native.calls.map((call:any)=>call.literal))!==JSON.stringify(native.physicalCalls))throw Error("Root paid approval differs from exact current packet/physical evidence");
    literalNativeFrames(native);
    if(native.runtimePair.sdk!==runtime.sdk||native.runtimePair.cli!==runtime.cli||native.executionKind!=="live-subscription"||!native.admissionEvidence||JSON.stringify(native.admissionEvidence)!==JSON.stringify(review.admission))throw Error("Scripted controls cannot supply independent model-family approval");
    if(native.writeDayUTC!==built.plan.writeDayUTC||native.physicalWriteDayUTC!==built.plan.writeDayUTC||native.writeDayRefused||!native.promptReleased||!native.settingsChecked||native.accountRoute?.accepted!==true||native.accountRoute?.tokenSource!=="CLAUDE_CODE_OAUTH_TOKEN"||native.accountRoute?.apiKeySource!=="none"||native.accountRoute?.apiProvider!=="firstParty"||native.init?.model!==runtime.model||native.init?.cli!==runtime.cli||native.init?.apiKeySource!=="none"||native.childClose?.code!==0||native.childClose?.signal!==null||native.forcedKill||!native.stdoutComplete||!native.stderrComplete||native.tools.length||native.result?.subtype!=="success"||native.result?.is_error||!/^APPROVED\b/.test(native.result?.result??""))throw Error("Real native review identity, tool-free approval or closure missing");
    reconcilePhysicalUsage(native.result,native.physicalCalls);
    if(JSON.stringify(priceSonnet55Usage(native.result))!==JSON.stringify(native.apiEquivalent))throw Error("Review usage price receipt differs from independent derivation");
    const promptSeen=native.physicalCalls.some((call:any)=>{
      const request=JSON.parse(call.requestBody);
      return request.messages?.some((message:any)=>message.role==="user"&&(message.content===packet.payload||Array.isArray(message.content)&&message.content.some((block:any)=>block.type==="text"&&block.text===packet.payload)));
    });
    if(!promptSeen)throw Error("Approval lacks the actual exact model-bound packet");
  }
  if(expected.size)throw Error("Missing packet approvals");
  return{writeDayUTC:built.plan.writeDayUTC,freezeSha:built.freeze.freezeSha,planSha:built.planSha,proofSha:built.plan.proofSha,complete:true as const};
}
