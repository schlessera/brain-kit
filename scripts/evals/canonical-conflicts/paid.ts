/** Concrete843 binding to its unchanged corpus, protocol, runtime and stable keyless proof. */
import {readFileSync} from "node:fs";
import {join} from "node:path";
import {freeze,sha} from "./freeze";
import {openNativePaidEntry,protectedNativeJson,type NativePaidEvidence} from "../native-paid-entry";
import {type ReviewBinding} from "../../../packages/ui-server/evals/triage/experiment/paid-policy";
import {type RuntimeIdentity} from "./review-evidence";
import {type NativePaidPolicy} from "../native-paid-policy";
export function openCanonicalPaid(options:{root:string;output:string;offline:boolean;review:boolean;prompt:string;runtime:RuntimeIdentity;frozen:ReturnType<typeof freeze>;
  proofSha?:string;offlinePolicy?:NativePaidPolicy}){
  const f=options.frozen;
  let proofSha=options.proofSha??sha("offline843 keyless proof");
  if(!options.offline){
    const proof=protectedNativeJson(process.env.BRAIN_CANONICAL_PAID_PROOF).value;
    if(proof.freezeSha!==f.freezeSha||proof.testsExitCode!==0||proof.typecheckExitCode!==0||proof.lintExitCode!==0||
      ["read","finding","write-denial","review"].some(mode=>proof.nativeExitCodes?.[mode]!==0))throw Error("Exact current843 keyless proof required before paid dispatch");
    proofSha=sha(JSON.stringify(proof));if(options.proofSha!==proofSha)throw Error("Root review binding differs from actual keyless proof");
  }
  const binding:ReviewBinding={freezeSha:f.freezeSha,inputSha:f.manifest.fixtureSha,protocolSha:f.manifest.protocolSha,
    runtimeSha:sha(JSON.stringify(options.runtime)),proofSha,promptSha:sha(options.prompt)};
  return openNativePaidEntry({issue:843,prefix:"BRAIN_CANONICAL",offline:options.offline,purpose:options.review?"review":"workflow",
    binding,output:options.output,nativeUserContextSha:sha(nativeFixtureInstructions(options.root)),offlinePolicy:options.offlinePolicy,save:()=>{},verifySource(){if(freeze().freezeSha!==f.freezeSha)throw Error("Current complete843 source/runtime changed before physical forwarding");}});
}
export type CanonicalPaidEvidence=NativePaidEvidence;

/** Exact native293 project-instruction block; original fixture instructions stay unchanged. */
export function nativeFixtureInstructions(root:string){
  return `<system-reminder>\nCodebase and user instructions are shown below. Be sure to adhere to these instructions. IMPORTANT: These instructions OVERRIDE any default behavior and you MUST follow them exactly as written.\n\nContents of ${join(root,"AGENTS.md")} (project instructions, checked into the codebase):\n\n${readFileSync(join(root,"AGENTS.md"),"utf8").trimEnd()}\n</system-reminder>\n`;
}
