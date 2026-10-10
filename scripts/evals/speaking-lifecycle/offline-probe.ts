/** Actual core/native 293 controls; no provider and no semantic/baseline-quality approval. */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { corpus, prepareTaskCase } from "./corpus";
import { installSurface, runNative, lifecyclePrompt } from "./native";
import { observe } from "./full-observer";
import { MODEL } from "./relay";
import { collectCell } from "./collector";
import { admitExactPackets } from "./review-packet";
import { sha } from "./freeze";
import { archiveEffects, expectedArchives } from "./atomic-effects";
export function response(id:number,content:{tool:string;input:unknown}|string){
  const tool=typeof content!=="string",block=tool?{type:"tool_use",id:`tool_${id}`,name:content.tool,input:{}}:{type:"text",text:""};
  const delta=tool?{type:"input_json_delta",partial_json:JSON.stringify(content.input)}:{type:"text_delta",text:content};
  const frames=[{type:"message_start",message:{id:`msg_${id}`,type:"message",role:"assistant",model:MODEL,content:[],stop_reason:null,usage:{input_tokens:10,output_tokens:0,cache_read_input_tokens:0,cache_creation_input_tokens:0}}},{type:"content_block_start",index:0,content_block:block},{type:"content_block_delta",index:0,delta},{type:"content_block_stop",index:0},{type:"message_delta",delta:{stop_reason:tool?"tool_use":"end_turn",stop_sequence:null},usage:{output_tokens:7}},{type:"message_stop"}];
  return new Response(frames.map(frame=>`event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join(""),{headers:{"content-type":"text/event-stream"}});
}
async function main(){
  if(process.env.BRAIN_SPEAKING_OFFLINE!=="1")throw Error("Only actual isolated offline speaking probe");
  if(readFileSync("/proc/net/route","utf8").trim().split("\n").slice(1).some(row=>row.trim().split(/\s+/)[0]!=="lo"))throw Error("Offline namespace contains external route");
  const mode=process.argv[2]??"read",destination=process.argv[3];if(!["read","cli","write-denial","archive","review","cli-direct","current-cell","cli-escape"].includes(mode))throw Error("Unknown bounded offline mode");
  const c=corpus.find(c=>c.id===(["archive","cli-direct"].includes(mode)?"held-close":"tune-direct"))!,p=await prepareTaskCase(c),output=mkdtempSync("/tmp/speaking-native-receipts-");
  const toolResults:string[]=[],requestsBodies:unknown[]=[];let physical=0,mainRequests=0;
  try {
    if(mode==="current-cell"){
      let requests=0;
      const row=await collectCell(c,{arm:"current",candidateSize:32,offline:true,output, nativeFetch:async(_url,init)=>{
        const body=JSON.parse(new TextDecoder().decode(init.body as Uint8Array));requests++;
        if(requests===1)return response(requests,{tool:"Read",input:{file_path:".claude/skills/submission-outcome/SKILL.md"}});
        if(requests===2)return response(requests,{tool:"Read",input:{file_path:`conferences/${c.assembly}-2026/submission-${c.submission}.md`}});
        if(!body.messages.some((message:any)=>JSON.stringify(message.content).includes(c.submission)))throw Error("Full collector actual source/tool response absent");
        return response(requests,"Scripted read control complete; no task-semantic approval.");
      }});
      if(!row.protocolComplete||row.candidateSize!==32||!row.nativeAggregateUsageKnown||row.nativePhysical.length!==3||!row.retainedNative.stdoutDrained||row.quality.semanticQuality!==null||row.actualInvoiceUsd!==null||!row.quality.effect.safe)throw Error("Actual full native collector integration control failed");
      if(destination)writeFileSync(destination,JSON.stringify({passed:true,mode,row,actualCli:"2.1.293",semanticApproval:false,currentAgentQuality:null},null,2),{mode:0o600});
      console.log(JSON.stringify({passed:true,mode,actualCli:"2.1.293",childrenDrained:true,externalRequests:0}));return;
    }
    installSurface(p.root);const before=observe(p.root);
    const expected=expectedArchives(before,mode==="cli-direct"?[p.hub,p.first,p.second]:mode==="archive"?[p.hub]:[]);
    if(mode==="cli-direct") {
      const command=(args:string[])=>{
        const child=Bun.spawnSync([process.execPath,"--preload",new URL("../../captures/clock.ts",import.meta.url).pathname,new URL("../../../packages/core/src/cli/brain.ts",import.meta.url).pathname,...args],{cwd:p.root,env:{PATH:process.env.PATH,HOME:"/tmp/isolated-cli-home",BRAIN_ROOT:p.root},stdout:"pipe",stderr:"pipe",timeout:10000});
        if(child.exitCode!==0)throw Error(`Actual direct shipped CLI failed: ${child.stderr.toString()}`);
        return {args,code:child.exitCode,stdout:child.stdout.toString(),stderr:child.stderr.toString()};
      };
      const commands=[command(["config","check","--json"]),command(["read",p.first,"--json"])];
      if(!commands[1].stdout.includes(c.submission))throw Error("Actual direct CLI source read missing");
      for(const path of [p.hub,p.first,p.second])commands.push(command(["archive",path,"--json"]));
      const after=observe(p.root),violations=archiveEffects(before,after,expected,true);
      if(violations.length)throw Error(`Direct CLI archive effects: ${violations.join("; ")}`);
      if(destination)writeFileSync(destination,JSON.stringify({passed:true,mode,commands,before,after,currentAgentBaseline:false,actualNative:false,models:0,referenceDay:"2026-07-12",semanticApproval:false},null,2),{mode:0o600});
      console.log(JSON.stringify({passed:true,mode,actualCLI:true,currentAgentBaseline:false,externalRequests:0}));return;
    }
    const sentinel=join(output,"outside-fixture-sentinel.md");if(mode==="cli-escape")writeFileSync(sentinel,"ODYSSEUS_OUTSIDE_SENTINEL");
    const skill=join(p.root,".claude/skills/submission-outcome/SKILL.md");
    const options:Parameters<typeof runNative>[4]={offline:true,readOnlyReview:mode==="review",offlineDeadlineMs:10000,allowedWrites:mode==="archive"?[p.hub]:[],...(mode==="review"?{reviewBinding:{freezeSha:"offline-control",promptSha:sha("Return APPROVED for this scripted no-tools transport control.")}}:{}),async fetch(_url,init){
      const body=JSON.parse(new TextDecoder().decode(init.body as Uint8Array));physical++;requestsBodies.push(body);
      if(body.model!==MODEL)throw Error("Unexpected actual offline requested model");
      for(const message of body.messages??[])for(const block of Array.isArray(message.content)?message.content:[])if(block.type==="tool_result")toolResults.push(JSON.stringify(block.content));
      const isMain=mode==="review"||body.tools?.some((tool:any)=>["Read","Bash"].includes(tool.name));
      if(!isMain)return response(physical,"Offline helper control.");
      mainRequests++;
    if(mode==="read"&&mainRequests<=2)return response(physical,{tool:"Read",input:{file_path:mainRequests===1?skill:join(p.root,p.first)}});
      if(mode==="cli-escape"&&mainRequests===1)return response(physical,{tool:"Bash",input:{command:`brain read ${sentinel} --json`}});
      if(mode==="cli"&&mainRequests===1)return response(physical,{tool:"Bash",input:{command:"brain config check --json"}});
      if(mode==="cli"&&mainRequests===2)return response(physical,{tool:"Bash",input:{command:`brain read ${p.first} --json`}});
      if(mode==="write-denial"&&mainRequests===1)return response(physical,{tool:"Write",input:{file_path:join(p.root,p.first),content:"Unauthorized source overwrite must be denied."}});
      if(mode==="archive"&&mainRequests===1)return response(physical,{tool:"Bash",input:{command:`brain archive ${p.hub} --json`}});
      return response(physical,mode==="review"?"APPROVED":"Offline speaking tool control complete.");
    }};
    const result=await runNative(p.root,output,"sk-ant-oat01-offline-fixture-not-a-credential",mode==="review"?"Return APPROVED for this scripted no-tools transport control.":lifecyclePrompt,options);
    const after=observe(p.root);
    const violations=archiveEffects(before,after,expected,mode==="archive");
    if(violations.length)throw Error(`Actual native effects: ${violations.join("; ")}`);
    if(mode==="review"){
      const expected={key:"control",freezeSha:"offline-control",promptSha:sha("Return APPROVED for this scripted no-tools transport control."),runtime:JSON.parse(readFileSync(join(output,"execution.json"),"utf8")).runtime};
      const pretend={...expected,approved:true,model:MODEL,finished:true,drained:true,stdoutComplete:true,callsComplete:true,overage:"inactive observed",actualCli:"2.1.293",actualProvider:true,scope:"complementary-semantic-review",authorFamily:"gpt",reviewerFamily:"claude",evidence:result.evidence};
      if(admitExactPackets([expected],[pretend]))throw Error("Actual scripted APPROVED was admitted as complementary approval");
    }
    if(mode==="read"&&(!toolResults.some(text=>text.includes("Submission Outcome"))||!toolResults.some(text=>text.includes(c.submission))))throw Error("Actual native did not read shipped skill and complete submission");
    if(mode==="cli"&&!toolResults.some(text=>text.includes(c.submission)))throw Error("Actual core-native CLI returned no source document");
    if(mode==="cli-escape"&&(!toolResults.some(text=>text.includes("PreToolUse:Bash hook error"))||requestsBodies.some(body=>JSON.stringify(body).includes("ODYSSEUS_OUTSIDE_SENTINEL"))||readFileSync(sentinel,"utf8")!=="ODYSSEUS_OUTSIDE_SENTINEL"))throw Error("Actual native CLI escape denial/sentinel boundary absent");
    if(mode==="write-denial"&&!toolResults.some(text=>text.includes("PreToolUse:Write hook error")))throw Error("Actual native Write refusal absent");
    if(mode==="archive"){
      const raw=readFileSync(join(p.root,p.hub),"utf8");
      if(!raw.includes("status: archived")||!raw.includes("relevance: historical")||!raw.includes("updated: 2026-07-12"))throw Error("Actual native shipped archive tool did not preserve pinned lifecycle/relevance behavior");
    }
    if(!physical||!result.receipt.drained||!result.receipt.stdoutComplete||result.receipt.init?.claude_code_version!=="2.1.293")throw Error("Actual native runtime/physical/closure receipt incomplete");
    if(destination)writeFileSync(destination,JSON.stringify({passed:true,mode,physical,actualCli:"2.1.293",currentArmComplete:false,coreArgsPermissionModeOmitted:false,nativeReportedPermissionMode:result.receipt.init?.permissionMode,before,after,toolResults,requestBodies:requestsBodies,native:result.receipt,calls:result.calls,evidence:result.evidence,semanticApproval:false,liveQuality:null,liveBilling:null},null,2),{mode:0o600});
    console.log(JSON.stringify({passed:true,mode,physical,actualCli:"2.1.293",childrenDrained:true,externalRequests:0}));
  }finally{
    if(destination){const raw=`${destination}.raw`;mkdirSync(raw,{recursive:true,mode:0o700});for(const name of ["paid.json","paid-grant.json","paid-refusal.json","execution.json","review-evidence.json","native.json","native.json.stdin.jsonl","native.json.stdout.jsonl","native.json.stderr.bin","physical.json"])if(existsSync(join(output,name)))copyFileSync(join(output,name),join(raw,name));writeFileSync(join(raw,"request-bodies.json"),JSON.stringify(requestsBodies),{mode:0o600});}
    p.close();rmSync(output,{recursive:true,force:true});
  }
}
if(import.meta.main)await main();
