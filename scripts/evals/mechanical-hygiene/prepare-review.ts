/** Fresh full cases/size/TZ dossiers and lossless packets. No provider transport. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { workload } from "./workload";
import { actualWriteDayUTC, assertWriteDayUTC } from "./write-day";
import { sourceFreeze, source } from "./freeze";
import { buildReviewPackets } from "./review-packets";
async function main(){
  const [destination,proofPath]=process.argv.slice(2);
  if(!destination||existsSync(destination)||!proofPath)throw Error("Require fresh protected destination and exact stable keyless proof");
  const writeDayUTC=actualWriteDayUTC();
  const freeze=sourceFreeze(),proofRaw=readFileSync(proofPath,"utf8");
  if(JSON.parse(proofRaw).freezeSha!==freeze.freezeSha)throw Error("Proof belongs to different source");
  mkdirSync(destination,{mode:0o700});mkdirSync(join(destination,"home"),{mode:0o700});
  const tasks=workload.flatMap(fixture=>[20,1000].map(size=>({fixture,size}))),rows:any[]=Array(tasks.length);
  let next=0;
  async function worker(){
    for(;;){const index=next++;if(index>=tasks.length)return;const {fixture,size}=tasks[index];
      const path=join(destination,`${fixture.id}-${size}.json`);
      const child=Bun.spawn([process.execPath,"scripts/evals/mechanical-hygiene/effect-candidates.ts",path,fixture.id,String(size)],{cwd:source,env:{PATH:`${join(process.execPath,"..")}:/usr/bin:/bin`,HOME:join(destination,"home"),TZ:fixture.timezone},stdout:"pipe",stderr:"pipe"});
      const [stdout,stderr,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
      writeFileSync(join(destination,`${fixture.id}-${size}.worker.txt`),JSON.stringify({code,stdout,stderr}),{mode:0o600});
      if(code!==0)throw Error(`Actual timezone effect worker failed: ${fixture.id}/${size}`);
      const result=JSON.parse(readFileSync(path,"utf8"));if(result.rows.length!==1)throw Error("Case worker cardinality differs");rows[index]=result.rows[0];
    }
  }
  const settled=await Promise.allSettled([worker(),worker(),worker()]);
  if(settled.some(result=>result.status==="rejected"))throw Error("Full effect workers failed; inspect preserved private receipts");
  assertWriteDayUTC(writeDayUTC);
  if(rows.some(row=>row.writeDayUTC!==writeDayUTC))throw Error("Preparation workers crossed the actual UTC write date");
  if(sourceFreeze().freezeSha!==freeze.freezeSha)throw Error("Source changed while preparing complete inputs");
  writeFileSync(join(destination,"effects.json"),JSON.stringify(rows),{mode:0o600});
  const built=buildReviewPackets(rows,proofRaw);mkdirSync(join(destination,"packets"),{mode:0o700});
  for(const packet of built.packets)writeFileSync(join(destination,"packets",`${packet.id}.json`),packet.payload,{mode:0o600});
  writeFileSync(join(destination,"review-plan.json"),JSON.stringify({...built.plan,planSha:built.planSha},null,2),{mode:0o600});
  writeFileSync(join(destination,"freeze.json"),JSON.stringify(freeze,null,2),{mode:0o600});
  writeFileSync(join(destination,"proof.json"),proofRaw,{mode:0o600});
  console.log(JSON.stringify({cases:workload.length,actualSizes:[20,1000],completeRows:rows.length,packets:built.packets.length,maxPacketBytes:Math.max(...built.packets.map(packet=>packet.bytes)),freezeSha:freeze.freezeSha,planSha:built.planSha,semanticApproval:false,providerCalls:0}));
}
if(import.meta.main)await main();
