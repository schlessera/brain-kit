/** Source-bound lifecycle paid-review admission; original core comparison remains prospective. */
import {readFileSync,lstatSync} from "node:fs";
import {join} from "node:path";
import {bundledClaudeBinary} from "../../../packages/core/src/providers/agents/claude-binary";
import {ownedClosure,closureDigest} from "./closure";
import {freshCases,referenceFiles} from "./fresh-corpus";
import {protocol,currentPrompt} from "./protocol";
import {openNativePaidEntry,protectedNativeJson} from "../native-paid-entry";
import {digest,type NativePaidPolicy} from "../native-paid-policy";
export const lifecycleSource=join(import.meta.dir,"../../..");
export function lifecyclePaidFreeze(){
  const closure=ownedClosure(lifecycleSource),sdk=Bun.resolveSync("@anthropic-ai/claude-agent-sdk",join(lifecycleSource,"packages/ui-backend-claude/src"));
  const native=bundledClaudeBinary(sdk);if(!native)throw Error("Installed native lifecycle runtime missing");
  const sdkVersion=JSON.parse(readFileSync(join(sdk,"../package.json"),"utf8")).version;
  if(sdkVersion!=="0.3.293"||Bun.version!=="1.4.2")throw Error("Original lifecycle SDK/Bun pin changed");
  const manifest=JSON.parse(readFileSync(join(sdk,"../manifest.json"),"utf8")),entry=manifest.platforms?.[`${process.platform}-${process.arch}`];
  if(manifest.version!=="2.1.293"||entry?.checksum!==digest(readFileSync(native))||entry?.size!==lstatSync(native).size)throw Error("Original lifecycle native vendor manifest differs");
  const runtime={sdk:sdkVersion,nativeSha:digest(readFileSync(native)),nativeMode:lstatSync(native).mode&0o7777,
    bunVersion:Bun.version,bunSha:digest(readFileSync(process.execPath)),bunMode:lstatSync(process.execPath).mode&0o7777};
  const inputs=freshCases.map(f=>({...f,checkpoints:f.checkpoints.map(c=>({...c,referenceFiles:referenceFiles(f,c),currentPrompt:currentPrompt(f,c)}))}));
  return {closure,runtime,freezeSha:closureDigest(closure),inputSha:digest(JSON.stringify(inputs)),protocolSha:digest(JSON.stringify(protocol))};
}
export function openLifecyclePaid(options:{output:string;prompt:string;offline:boolean;frozen:ReturnType<typeof lifecyclePaidFreeze>;proofSha?:string;offlinePolicy?:NativePaidPolicy}){
  const f=options.frozen;let proofSha=options.proofSha??digest("offline845 stable keyless proof");
  if(!options.offline){
    const proof=protectedNativeJson(process.env.BRAIN_LIFECYCLE_PAID_PROOF);
    if(proof.value.freezeSha!==f.freezeSha||proof.value.testsExitCode!==0||proof.value.typecheckExitCode!==0||proof.value.lintExitCode!==0||
      proof.value.originalNativeExitCode!==0||proof.value.paidNativeExitCodes?.["paid-extra"]!==0)throw Error("Exact current lifecycle keyless proof required");
    proofSha=proof.sha;if(proofSha!==options.proofSha)throw Error("Root lifecycle proof binding differs");
  }
  const binding={freezeSha:f.freezeSha,inputSha:f.inputSha,protocolSha:f.protocolSha,runtimeSha:digest(JSON.stringify(f.runtime)),proofSha,promptSha:digest(options.prompt)};
  return openNativePaidEntry({issue:845,prefix:"BRAIN_LIFECYCLE",offline:options.offline,purpose:"review",binding,output:options.output,
    offlinePolicy:options.offlinePolicy,save:()=>{},verifySource(){if(lifecyclePaidFreeze().freezeSha!==f.freezeSha)throw Error("Complete lifecycle source/runtime changed before paid forwarding");}});
}
