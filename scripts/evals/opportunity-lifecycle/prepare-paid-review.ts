/** Complete lossless lifecycle review preparation. No approval or provider transport. */
import {existsSync,mkdirSync,readFileSync,writeFileSync} from "node:fs";
import {join,resolve} from "node:path";
import {lifecyclePaidFreeze,lifecycleSource} from "./paid";
import {prepare} from "./prepare";
import {digest} from "../native-paid-policy";
export function preparePaidReview(destination:string,proofPath:string){
  const output=resolve(destination);if(output===resolve(lifecycleSource)||output.startsWith(resolve(lifecycleSource)+"/")||existsSync(output))throw Error("Fresh protected artifact directory outside source required");
  const frozen=lifecyclePaidFreeze(),proofRaw=readFileSync(proofPath),proof=JSON.parse(proofRaw.toString());
  if(proof.freezeSha!==frozen.freezeSha||proof.testsExitCode!==0||proof.typecheckExitCode!==0||proof.lintExitCode!==0||proof.originalNativeExitCode!==0||
    proof.paidNativeExitCodes?.["paid-extra"]!==0)throw Error("Exact current successful lifecycle keyless proof required");
  mkdirSync(output,{mode:0o700});const prepared=prepare(join(output,"inputs"));
  const corpus=JSON.parse(readFileSync(join(output,"inputs/corpus.json"),"utf8")),completeCases=corpus.length,
    completeCheckpoints=corpus.reduce((n:number,f:any)=>n+f.checkpoints.length,0);
  if(completeCases!==16||completeCheckpoints!==24)throw Error("Original complete lifecycle matrix changed");
  // Literal original whole-tree/runtime identity is included losslessly alongside every complete behavioral source.
  const documents:Array<{path:string;raw:Buffer}>=[{path:"proof.json",raw:proofRaw},{path:"paid-freeze.json",raw:Buffer.from(JSON.stringify(frozen))}];
  for(const name of ["corpus.json","schema.json","protocol.json","manifest.json"])documents.push({path:`inputs/${name}`,raw:readFileSync(join(output,"inputs",name))});
  const files=Object.entries(frozen.closure).filter(([path,entry])=>entry.kind==="file"&&(
    path.startsWith("packages/core/src/")||path.startsWith("packages/core/skills/")||path.startsWith("packages/module-jobs/src/")||path.startsWith("packages/module-jobs/skills/")||
    path.startsWith("scripts/evals/opportunity-lifecycle/")||/^scripts\/evals\/native-(?:paid-entry|paid-policy|pricing|grant)\.ts$/.test(path)||
    path==="scripts/measure-sonnet55-cost.ts"||path==="packages/ui-backend-claude/src/subscription.ts"||
    /^tests\/opportunity-lifecycle.*\.test\.ts$/.test(path)||/^tests\/native-(?:paid-policy|grant)\.test\.ts$/.test(path)));
  for(const [path] of files)documents.push({path,raw:readFileSync(join(lifecycleSource,path))});
  const entries:any[]=[],packets:any[]=[];let current:any[]=[];
  const flush=()=>{if(!current.length)return;const id=`lifecycle-${String(packets.length+1).padStart(3,"0")}`,payload=JSON.stringify({issue:845,freezeSha:frozen.freezeSha,proofSha:digest(proofRaw),semanticApproval:false,parts:current});
    if(Buffer.byteLength(payload)>400000)throw Error("Lossless packet bound exceeded");writeFileSync(join(output,`${id}.json`),payload,{mode:0o600});packets.push({id,sha:digest(payload),bytes:Buffer.byteLength(payload)});current=[];};
  for(const {path,raw} of documents){
    entries.push({path,sha:digest(raw),bytes:raw.length,parts:Math.max(1,Math.ceil(raw.length/220000))});
    for(let offset=0;offset<raw.length||offset===0;offset+=220000){const part={path,offset,fullBytes:raw.length,fullSha:digest(raw),bytesBase64:raw.subarray(offset,offset+220000).toString("base64")};
      if(Buffer.byteLength(JSON.stringify(current))+Buffer.byteLength(JSON.stringify(part))>370000)flush();current.push(part);}
  }
  flush();if(lifecyclePaidFreeze().freezeSha!==frozen.freezeSha)throw Error("Whole lifecycle source/runtime changed during packet preparation");
  const manifest={issue:845,freezeSha:frozen.freezeSha,inputSha:frozen.inputSha,protocolSha:frozen.protocolSha,proofSha:digest(proofRaw),prepared,
    completeCases,completeCheckpoints,files:entries,packets,scope:"complete core/jobs/private behavioral source plus lossless entire original owned-tree/runtime identity and complete new corpus/schema/protocol; compiled dependency bytes remain vendor/runtime hash identities",semanticApproval:false,providerRequests:0};
  writeFileSync(join(output,"review-plan.json"),JSON.stringify(manifest,null,2),{mode:0o600});return manifest;
}
if(import.meta.main){if(!process.argv[2]||!process.argv[3])throw Error("Fresh output and current proof required");const p=preparePaidReview(process.argv[2],process.argv[3]);console.log(JSON.stringify({files:p.files.length,packets:p.packets.length,maxPacketBytes:Math.max(...p.packets.map(p=>p.bytes)),freezeSha:p.freezeSha,semanticApproval:false,providerRequests:0}));}
