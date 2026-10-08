/** Explicitly keyless whole-collector control. Run in an offline namespace. */
import { lstatSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { measureLiveSurface } from "./measure-turn-surface-live";
import goldens from "./fixtures/turn-surface-live-cases.json";
import { captureSurface } from "./capture-turn-surface";
import { observedSkills } from "./turn-surface-skills";
import { deferredToolNames } from "./turn-surface-token-groups";
const model="claude-sonnet-5-5",root=resolve(import.meta.dir,".."),scratch=mkdtempSync(join(tmpdir(),"surface-whole-control-"));
const sha=(value:string|Buffer)=>createHash("sha256").update(value).digest("hex");
const caseIds=["voyage-procedure","timber-procedure","crew-procedure","mast-explanation","quote-card"];
const seen: Array<{model:string;tools:string[];skills:string;main:boolean}>=[];
const layouts:Array<{id:string;arm:string;skills:string[];byteHashes:Record<string,string>}>=[];
const selected=goldens.cases.filter(test=>caseIds.includes(test.id)),arms=["baseline","hint","load-set","hard-prune"];
const cells=selected.flatMap((test,index)=>[...arms.slice(index%4),...arms.slice(0,index%4)].map(arm=>({test,arm})));
let jevAttempts=0;
function answer(model:string,sequence:number,call?:{name:string;input:unknown}){
 const events=[
  {type:"message_start",message:{id:`msg_control_${sequence}`,type:"message",role:"assistant",model,content:[],stop_reason:null,
   stop_sequence:null,usage:{input_tokens:1,output_tokens:1}}},
  {type:"content_block_start",index:0,content_block:call?{type:"tool_use",id:`tool_control_${sequence}`,name:call.name,input:{}}:{type:"text",text:""}},
  {type:"content_block_delta",index:0,delta:call?{type:"input_json_delta",partial_json:JSON.stringify(call.input)}:
   {type:"text_delta",text:"Historical inspection before Thrinacia: check the mast. Keep the Bear on your left; twenty pine trees, Calypso supplies tools. A mast supports the sail."}},
  {type:"content_block_stop",index:0},{type:"message_delta",delta:{stop_reason:call?"tool_use":"end_turn",stop_sequence:null},usage:{output_tokens:11}},
  {type:"message_stop"}];
 return new Response(events.map(event=>`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),{headers:{"content-type":"text/event-stream"}});
}
const server=Bun.serve({hostname:"127.0.0.1",port:0,async fetch(request){
 const path=new URL(request.url).pathname;
 if(path!=="/v1/systemone"&&path!=="/v1/messages")return Response.json({});
 const body=await request.json() as Record<string,any>;
 if(path==="/v1/systemone"){
  jevAttempts++;
  const golden=goldens.cases.find(test=>test.prompt===body.state.request)!;
  if(!golden)throw Error("Control saw unexpected prompt");
  const desired={tool:golden.id==="quote-card"?"mcp__brain-ui__show_block":golden.neededSkill?"mcp__brain__brain_read":null,skill:golden.neededSkill};
  const answers:Record<string,any>={};
  for(const [key,question] of Object.entries(body.questions) as Array<[string,any]>){
   const kind=key.includes("skill")?"skill":"tool",picked=desired[kind];
   if(question.type==="choice"){
    const names=Object.keys(question.criteria),choice=picked&&names.includes(picked)?picked:names[0];
    answers[key]={type:"choice",choice,confidence:1,probabilities:Object.fromEntries(names.map(name=>[name,name===choice?1:0]))};
   }else answers[key]={type:"noul",noul:key.startsWith("needs_")?Number(Boolean(picked)):Number(key.endsWith(`:${picked}`))};
  }
  return Response.json({model:"jev-1.13.0",usage:{input_tokens:20,output_tokens:0},answers});
 }
 const tools=(body.tools??[]).map((tool:any)=>tool.name),messages=JSON.stringify(body.messages),main=tools.includes("Read");
 seen.push({model:body.model,tools,skills:messages,main});
 const golden=main?goldens.cases.find(test=>messages.includes(test.prompt)):undefined;
 let call:{name:string;input:unknown}|undefined;
 const calls=(body.messages??[]).flatMap((message:any)=>Array.isArray(message.content)?message.content:[]).filter((part:any)=>part.type==="tool_use");
 if(main&&calls.length===0){
  const cell=cells[layouts.length];
  if(!cell||cell.test.id!==golden?.id)throw Error("Control cell order changed");
  const environment=(body.messages??[]).flatMap((message:any)=>Array.isArray(message.content)?message.content:[]).find((part:any)=>part.text?.includes("Primary working directory:"))?.text;
  const fixture=environment?.match(/Primary working directory: ([^\n]+)/)?.[1];
  if(!fixture?.startsWith(join(tmpdir(),"turn-surface-fixture-")))throw Error("Control fixture location missing");
  const names=readdirSync(join(fixture,".claude/skills")).sort(),wanted=cell.arm==="hard-prune"?(golden?.neededSkill?[golden.neededSkill]:[]):["crew-log","shipbuilding","voyage-plan"];
  if(JSON.stringify(names)!==JSON.stringify(wanted))throw Error(`Wrong owned skill layout:${cell.arm}`);
  const byteHashes:Record<string,string>={};
  for(const name of names){
   if(!lstatSync(join(fixture,".claude/skills",name)).isDirectory())throw Error("Emitted skill remains a symlink");
   const emitted=readFileSync(join(fixture,".claude/skills",name,"SKILL.md")),source=readFileSync(join(fixture,".agents/skills",name,"SKILL.md"));
   if(!emitted.equals(source))throw Error("Skill bytes changed");byteHashes[name]=sha(emitted);
  }
  layouts.push({id:golden!.id,arm:cell.arm,skills:names,byteHashes});
 }
 if(golden?.neededSkill&&!calls.some((part:any)=>part.name==="Skill"))call={name:"Skill",input:{skill:golden.neededSkill}};
 else if(golden?.neededSkill&&!calls.some((part:any)=>part.name==="mcp__brain__brain_read"))call=tools.includes("mcp__brain__brain_read")
  ?{name:"mcp__brain__brain_read",input:{path:"studies/star-bearings.md"}}:{name:"ToolSearch",input:{query:"select:mcp__brain__brain_read"}};
 else if(golden?.id==="quote-card"&&!calls.some((part:any)=>part.name==="mcp__brain-ui__show_block"))call={name:"mcp__brain-ui__show_block",input:{block:{kind:"quote",quote:"Keep the Bear on your left through the night"}}};
 return answer(body.model,seen.length,call);
}});
try{
 const capture=await captureSurface({corpus:true,decision:Promise.resolve({arm:"baseline",routed:false,tools:[],skills:[]})});
 const catalogue={runtime:capture.runtime,skills:observedSkills(capture.request),builtinTools:capture.request.tools.filter(tool=>!tool.name.startsWith("mcp__")),deferredToolNames:deferredToolNames(capture.request)};
 const cataloguePath=join(scratch,"catalogue.json");writeFileSync(cataloguePath,JSON.stringify(catalogue));
 const sourceFiles=["scripts/measure-turn-surface-live.ts","scripts/turn-surface-fixture.ts","scripts/turn-surface-overlap.ts","scripts/turn-surface-observation.ts","scripts/turn-surface-admission.ts"];
 const manifestPath=join(scratch,"manifest.json"),reviewPath=join(scratch,"review.json"),outPath=join(scratch,"control.json");
 writeFileSync(manifestPath,JSON.stringify({sourceCommit:"explicit-offline-working-tree",files:Object.fromEntries(sourceFiles.map(path=>[path,sha(readFileSync(join(root,path)))])),catalogueSha:sha(readFileSync(cataloguePath)),reviewInputSha:"offline-scripted-input"}));
 writeFileSync(reviewPath,JSON.stringify({evidence:"offline-scripted-semantic-gate",inputSha:"offline-scripted-input",init:{model,apiKeySource:"none"},account:{tokenSource:"CLAUDE_CODE_OAUTH_TOKEN",apiProvider:"firstParty"},overageReported:false,
  result:{subtype:"success",result:"APPROVED scripted control only",modelUsage:{[model]:{inputTokens:1,outputTokens:1,cacheReadInputTokens:0,cacheCreationInputTokens:0}}}}));
 await measureLiveSurface({manifestPath,reviewPath,cataloguePath,outPath,offline:{nativeBaseUrl:`http://127.0.0.1:${server.port}`,jevEndpoint:`http://127.0.0.1:${server.port}/v1/systemone`,caseIds,repetitions:1}});
 const report=JSON.parse(readFileSync(outPath,"utf8"));
 if(report.evidence!=="offline-scripted-full-collector-control"||report.rows.length!==20||layouts.length!==20||report.nativeProcessReceipts.length!==20
  ||report.rows.some((row:any)=>row.error||row.score.contentPass!==true))throw Error("Whole-collector control incomplete or wrongly scored");
 for(const arm of ["baseline","hint","load-set","hard-prune"]){
  const rows=report.rows.filter((row:any)=>row.arm===arm);
  if(rows.length!==5||rows.some((row:any)=>row.score.neededSkillHit===false||row.score.neededToolsHit===false))throw Error(`Control missed accepted execution:${arm}`);
 }
 if(!jevAttempts||seen.some(frame=>frame.model!==model))throw Error("Control did not observe pinned provider transports");
 if(process.argv[2])writeFileSync(process.argv[2],JSON.stringify({evidence:report.evidence,rows:report.rows,layouts,nativeProcessReceipts:report.nativeProcessReceipts,indexReceipt:report.indexReceipt,jevAttempts,nativeRequests:seen.length,models:[...new Set(seen.map(frame=>frame.model))],allNativeChildrenDrained:true},null,2)+"\n");
 console.log(JSON.stringify({evidence:report.evidence,rows:report.rows.length,jevAttempts,nativeRequests:seen.length,indexReceipt:report.indexReceipt,allNativeChildrenDrained:true}));
}finally{server.stop(true);}
