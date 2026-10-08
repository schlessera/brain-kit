/** Serialized fresh comparison; imports dispatch nothing and quota hold vetoes entry. */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assertScoredAdmission, type ReviewArtifacts } from "./admission";
import { collectActualCycle, collectPrototypeCycle } from "./native-cycle";
import { workload } from "./workload";
import { hash, protocolSha } from "./protocol";
export function comparisonSchedule(){
  const schedule:Array<{caseId:string;size:number;repetition:number;arm:"current-skill"|"mechanical-prototype";timezone:string}>=[];
  for(let repetition=0;repetition<3;repetition++)for(let sizeIndex=0;sizeIndex<2;sizeIndex++)for(let offset=0;offset<workload.length;offset++){
    const index=(offset+repetition)%workload.length,fixture=workload[index],size=[20,1000][sizeIndex];
    const arms:Array<"current-skill"|"mechanical-prototype">=(index+repetition+sizeIndex)%2?["mechanical-prototype","current-skill"]:["current-skill","mechanical-prototype"];
    for(const arm of arms)schedule.push({caseId:fixture.id,size,repetition,arm,timezone:fixture.timezone});
  }
  return schedule;
}
function artifacts(effectsPath:string,proofPath:string,reviewDirectory:string):ReviewArtifacts{
  const receipts=readdirSync(reviewDirectory).sort().map(name=>join(reviewDirectory,name,"review.json"));
  return{effectsPath,proofPath,receipts};
}
async function main(){
  const worker=process.argv[2]==="--worker";
  const args=process.argv.slice(worker?3:2),[destination,effectsPath,proofPath,reviewDirectory,arm,caseId,sizeRaw,repRaw]=args;
  if(!destination||existsSync(destination)||!effectsPath||!proofPath||!reviewDirectory)throw Error("Require fresh destination and complete exact-frozen effects/proof/real review receipts");
  const reviewed=artifacts(effectsPath,proofPath,reviewDirectory),admission=await assertScoredAdmission(reviewed);
  const effects=JSON.parse(readFileSync(effectsPath,"utf8")),schedule=comparisonSchedule(),scheduleSha=hash(JSON.stringify(schedule));
  if(worker){
    const size=Number(sizeRaw),repetition=Number(repRaw),item=schedule.find(item=>item.arm===arm&&item.caseId===caseId&&item.size===size&&item.repetition===repetition);
    if(!item||item.timezone!==Intl.DateTimeFormat().resolvedOptions().timeZone)throw Error("Unknown cell or actual worker timezone mismatch");
    const candidate=effects.find((row:any)=>row.fixture===caseId&&row.initialDocuments===size);
    if(!candidate)throw Error("Missing complete matched effects");
    if(arm==="mechanical-prototype"){
      mkdirSync(destination,{mode:0o700});const result=await collectPrototypeCycle(caseId,size,candidate);
      writeFileSync(join(destination,"phases.json"),JSON.stringify({...item,...result,protocolSha,scheduleSha,admission,executionKind:"keyless-mechanical-prototype",semanticApproval:false},null,2),{mode:0o600});
    }else{
      // Source/semantic/root-budget gates pass before reading existing login.
      const token=process.env.CLAUDE_CODE_OAUTH_TOKEN??JSON.parse(readFileSync(join(process.env.HOME!,".claude/.credentials.json"),"utf8"))?.claudeAiOauth?.accessToken;
      if(typeof token!=="string"||!token.trim())throw Error("Protected subscription access absent");
      await collectActualCycle({caseId,size,destination,source:new URL("../../../",import.meta.url).pathname,token,candidate,offline:false,reviewArtifacts:reviewed});
    }
    return;
  }
  mkdirSync(destination,{mode:0o700});const rows:Array<unknown>=[];
  const save=(failure:string|null)=>writeFileSync(join(destination,"comparison.json"),JSON.stringify({protocolSha,scheduleSha,schedule,admission,rows,failure,transportComplete:!failure&&rows.length===schedule.length,comparisonComplete:false,descriptionSemanticApproval:false,adoption:"not decided",actualAdditionalBilledUsd:null,finalInvoiceSupplied:false},null,2),{mode:0o600});
  save(null);
  for(const [index,item]of schedule.entries()){
    const path=join(destination,`cell-${String(index+1).padStart(3,"0")}`),child=Bun.spawn([process.execPath,import.meta.filename,"--worker",path,effectsPath,proofPath,reviewDirectory,item.arm,item.caseId,String(item.size),String(item.repetition)],{
      cwd:new URL("../../../",import.meta.url).pathname,
      env:{PATH:`${join(process.execPath,"..")}:/usr/bin:/bin`,HOME:process.env.HOME!,TZ:item.timezone,BRAIN_LIVE_EVAL:"842",BRAIN_HYGIENE_LEDGER:process.env.BRAIN_HYGIENE_LEDGER!,BRAIN_HYGIENE_ADMISSION:process.env.BRAIN_HYGIENE_ADMISSION!},stdout:"pipe",stderr:"pipe"});
    const [stdout,stderr,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
    writeFileSync(join(destination,`cell-${index+1}.worker.txt`),JSON.stringify({code,stdout,stderr}),{mode:0o600});
    rows.push({...item,index,exitCode:code,receiptSha:existsSync(join(path,"phases.json"))?hash(readFileSync(join(path,"phases.json"))):null});
    save(code?"A cell failed; complete preserved receipt requires inspection and future admission stopped":null);
    if(code)throw Error("Comparison cell failed; no automatic retry or changed inputs/bounds");
  }
  console.log(JSON.stringify({cells:rows.length,nativeCycles:108,prototypeCycles:108,transportComplete:true,comparisonComplete:false,descriptionSemanticApproval:false,providerSpendReceipt:null}));
}
if(import.meta.main)await main();
