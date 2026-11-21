/** Production cron -> boundary.launch -> native publisher; copied inputs and mocked worker execution. */
import {expect,spyOn,test} from "bun:test";
import * as sdk from "@schlessera/brain-ui-sdk/internal";
import {mkdirSync,mkdtempSync,readdirSync,readFileSync,rmSync,writeFileSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {createHostBoundary} from "../src/brain/host-boundary.js";
import * as preparation from "../src/brain/maintenance-git.js";
import {nativeOutputFixture} from "../../ui-sdk/tests/helpers/native-output-fixture.js";
import {emitCrontab} from "../src/cron/emit.js";
import {runJob} from "../src/cron/run-job.js";
import {createUiDb} from "../src/db/client.js";
import {createActivityStore} from "../src/activity/store.js";
import {toWireEvent,toWireSpan} from "../src/activity/stream.js";
import {parseServerMessage} from "../../ui-sdk/src/schemas.js";

for(const mode of ["success","failed","truncated","missing-eof","human"] as const)test(`emitted maintain cron publishes and records the actual Git result: ${mode}`,async()=>{
 const root=mkdtempSync(join(tmpdir(),"odysseus-cron-publication-")),brain=join(root,"brain"),dbPath=join(root,"ui.db");mkdirSync(brain);
 const git=(cwd:string,...args:string[])=>{const p=Bun.spawnSync(["git","-C",cwd,...args],{stdin:Buffer.from("Ithaca harbour"),stdout:"pipe",stderr:"pipe",env:{PATH:process.env.PATH,GIT_CONFIG_GLOBAL:"/dev/null",GIT_CONFIG_NOSYSTEM:"1"}});expect(p.exitCode,p.stderr.toString()).toBe(0);return p.stdout.toString();};
 mkdirSync(join(brain,"node_modules/.bin"),{recursive:true});writeFileSync(join(brain,"node_modules/.bin/brain"),"#!/bin/sh\nexit 125\n",{mode:0o755});
 git(brain,"init","-q");const hash=git(brain,"hash-object","-w","--stdin").trim();writeFileSync(join(brain,"registry.md"),"Odysseus before");
 const before=git(brain,"count-objects","-v"),fixture=await nativeOutputFixture(root,brain),step=mode==="failed"?"FAILED — packing refused":"ok — packed 1 loose object(s)";
 const json=JSON.stringify([{step:"git",result:step}]),human=`Maintenance run:\n\n  git        ${step}\n`;
 const calls:string[][]=[];let held:ReadableStreamDefaultController<Uint8Array>|undefined,timer:ReturnType<typeof setTimeout>|undefined;
 const mocks=[
  spyOn(sdk,"prepareNativeWorkerStartupView").mockResolvedValue(fixture.view),spyOn(sdk,"prepareNativeWorkerOutput").mockResolvedValue(fixture.output),
  spyOn(preparation,"prepareMaintenanceGit").mockResolvedValue(undefined),spyOn(sdk,"prepareMaintenanceWorker").mockResolvedValue(undefined),
  spyOn(sdk,"acquireHostCredentialExclusion").mockResolvedValue({release(){}}),
  spyOn(sdk,"launchMaintenanceWorkerAsync").mockImplementation(async input=>{
   calls.push([...input.command]);git(fixture.output.output.source,"maintenance","run","--task=loose-objects");git(fixture.output.output.source,"maintenance","run","--task=loose-objects");
   writeFileSync(join(fixture.output.output.source,"registry.md"),"Athena after");
   const stdout=new ReadableStream<Uint8Array>({start(controller){held=controller;timer=setTimeout(()=>{
    const text=input.command.includes("--json")?json:human;controller.enqueue(new TextEncoder().encode(mode==="truncated"?text.slice(0,-2):text));if(mode!=="missing-eof")controller.close();
   },0);},cancel(){clearTimeout(timer);}});
   // Exit precedes the final stdout chunk/EOF on purpose; caller timing must not decide publication.
   return {pid:process.pid,input:async()=>{},stdout,stderr:new Response("").body!,exited:Promise.resolve(mode==="failed"?2:0),released:async()=>{},kill(){}};
  }),
 ];
 try{
  const emitted=emitCrontab({modules:null,wrapperCommand:"cron-run",digestCommand:"digest",pathLine:"PATH=/usr/bin:/bin",user:"root",legacyScraperPresent:false});
  const line=emitted.split("\n").find(line=>line.includes("cron-run maintain --"))!;
  const argv=line.split(" maintain -- ")[1]!.split(" 2>&1")[0]!.split(" ");expect(argv,"SHIPPED_MAINTAIN_ARGV").toEqual(["brain","maintain"]);
  const command=mode==="human"?[...argv,"--human"]:argv;
  const host=createHostBoundary({brainPath:brain,dbPath,nativeManager:fixture.manager,exec:{}});
  let output="",errors="";
  const code=await runJob({jobName:"maintain",command,dbPath,childEnv:{PATH:process.env.PATH},exec:{},brainPath:brain,boundary:host,stdout:{write(text){output+=text;}},stderr:{write(text){errors+=text;}}},{sinkPath:join(root,"sink.jsonl")});
  expect(code,errors).toBe(mode==="failed"?2:0);expect(calls).toHaveLength(1);
  const published=mode==="success"||mode==="human",packs=readdirSync(join(brain,".git/objects/pack")).filter(name=>name.endsWith(".pack"));
  expect(packs.length>0,published?"CRON_SUCCESS_PUBLISHES_LIVE_PACK":"CRON_UNCERTAIN_GIT_STAGE_IS_DISCARDED").toBe(published);
  expect(calls[0],"CRON_HOST_REQUESTS_MACHINE_REPORT").toContain("--json");
  if(!published)expect(git(brain,"count-objects","-v"),"CRON_UNCERTAIN_GIT_STAGE_IS_DISCARDED").toBe(before);
  expect(git(brain,"cat-file","blob",hash).trim()).toBe("Ithaca harbour");expect(readFileSync(join(brain,"registry.md"),"utf8")).toBe("Athena after");
  if(mode==="human")expect(output,"CRON_HUMAN_OUTPUT_UNCHANGED").toBe(human);else if(published)expect(output).toBe(json);
  const reason=mode==="failed"?"maintenance_failed":mode==="truncated"?"maintenance_report_invalid":mode==="missing-eof"?"maintenance_report_incomplete":null;
  const db=createUiDb(dbPath);
  try{
   const changes=createActivityStore(db).changesSince(0),event=changes.find(change=>change.kind==="event"&&change.event.eventType==="git_publication");
   expect(event?.kind==="event"?event.event.payload:null,"CRON_DISCARD_REASON_IS_DURABLE").toEqual({state:published?"published":"discarded",reason});
   const terminal=changes.find(change=>change.kind==="span"&&change.span.name==="cron maintain"&&change.span.outcome);
   expect(terminal?.kind==="span"?terminal.span.attrs["maintenance.git_publication"]:null).toBe(JSON.stringify({state:published?"published":"discarded",reason}));
   if(mode==="truncated"||mode==="missing-eof"){
    expect(terminal?.kind==="span"?terminal.span.outcome:null,"INCOMPLETE_REPORT_ACTIVITY_IS_ERROR").toBe("error");expect(errors).toContain(`git_publication_discarded: ${reason}`);
   }
   for(const change of changes){const frame={type:"activity_delta",runId:change.runId,seq:change.seq,...(change.kind==="span"?{span:toWireSpan(change.span)}:{event:toWireEvent(change.event)})};expect(parseServerMessage(JSON.stringify(frame)).ok,"PREVIOUS_ACTIVITY_SCHEMA_ACCEPTS_PUBLICATION_RESULT").toBe(true);}
  }finally{db.close();}
 }finally{clearTimeout(timer);try{held?.close();}catch{/* Already closed/cancelled. */}for(const mock of mocks.reverse())mock.mockRestore();await fixture.close();rmSync(root,{recursive:true,force:true});}
});
