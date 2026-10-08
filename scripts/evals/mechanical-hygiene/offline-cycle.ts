/** Actual complete collector path with scripted responses; never semantic approval. */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { workload } from "./workload";
import { effectCandidates } from "./effect-candidates";
import { collectActualCycle } from "./native-cycle";
import { response } from "./offline-native";
async function main(){
  if(process.env.BRAIN_HYGIENE_OFFLINE!=="1")throw Error("Explicit offline namespace required");
  const [out,id,sizeRaw]=process.argv.slice(2),size=Number(sizeRaw),fixture=workload.find(f=>f.id===id);
  if(!out||!fixture||![20,1000].includes(size)||fixture.timezone!==Intl.DateTimeFormat().resolvedOptions().timeZone)throw Error("Require fresh output/exact case/actual size/timezone");
  const candidate=(await effectCandidates(id,size)).rows[0],source=new URL("../../../",import.meta.url).pathname;
  const unexpected=process.argv.includes("--controlled-unexpected-write");
  const tools:Record<string,unknown[]>={};let complete=false;
  try{
    const result=await collectActualCycle({caseId:id,size,destination:out,source,token:`sk-ant-oat01-${"o".repeat(95)}AA`,offline:true,candidate,
      controlledTransport(phase,root){
        let step=0,physical=0;tools[phase]=[];
        const fixes=phase==="apply"?Object.keys(fixture.expected).filter(path=>fixture.expected[path]!==fixture.files[path]).map(path=>({path,fix:"Normalize the authored date or Status disagreement."})):[];
        const steps:Array<{name:string;input:unknown}>=[{name:"Bash",input:{command:"brain hygiene reconcile --dry-run --json"}},{name:"Bash",input:{command:"brain hygiene list --json"}},{name:"Bash",input:{command:"brain config check"}}];
        if(phase==="apply")for(const fix of fixes){steps.push({name:"Read",input:{file_path:join(root,fix.path)}});steps.push({name:"Write",input:{file_path:join(root,fix.path),content:fixture.expected[fix.path]}});}
        if(unexpected&&phase==="apply")steps.push({name:"Write",input:{file_path:join(root,"context/unapproved.md"),content:"Odysseus authored an unapproved extra file.\n"}});
        steps.push({name:"Write",input:{file_path:join(root,".brain/scratch/hygiene-extra.json"),content:"[]"}});
        if(phase!=="dry-run")steps.push({name:"Write",input:{file_path:join(root,".brain/scratch/hygiene-fixed.json"),content:JSON.stringify(fixes)}});
        steps.push({name:"Bash",input:{command:phase==="dry-run"?"brain hygiene reconcile --extra .brain/scratch/hygiene-extra.json --dry-run --json":"brain hygiene reconcile --extra .brain/scratch/hygiene-extra.json --fixed .brain/scratch/hygiene-fixed.json --json"}});
        return async(_url,init)=>{
          physical++;const request=JSON.parse(typeof init.body==="string"?init.body:new TextDecoder().decode(init.body as Uint8Array));
          for(const message of request.messages??[])for(const block of Array.isArray(message.content)?message.content:[])if(block.type==="tool_result")tools[phase].push(block);
          return response(physical,request.tools?.some((tool:any)=>tool.name==="Bash")?steps[step++]:undefined);
        };
      }});
    for(const row of result.rows){
      if(!row.receipt?.tools.length||!row.receipt.tools.every(tool=>tool.allowed))throw Error("Actual collector did not exercise its contained native tool path");
      if(!JSON.stringify(tools[row.phase]).includes("detected"))throw Error("Actual clock-controlled CLI detection result absent");
    }
    complete=true;console.log(JSON.stringify({passed:true,actualNative:true,semanticApproval:false,cli:result.rows[0].receipt!.runtimePair.cli,sdk:result.rows[0].receipt!.runtimePair.sdk,documents:size,case:id,workerTimezone:fixture.timezone,phases:result.rows.length,physical:result.rows.reduce((sum,row)=>sum+row.receipt!.native.calls.length,0),externalRequests:0}));
  }finally{
    mkdirSync(out,{recursive:true,mode:0o700});writeFileSync(join(out,"control-summary.json"),JSON.stringify({complete,semanticApproval:false,documents:size,case:id,workerTimezone:fixture.timezone}),{mode:0o600});
  }
}
if(import.meta.main)await main();
