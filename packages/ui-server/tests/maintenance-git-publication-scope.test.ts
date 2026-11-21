/** The real host boundary and native publisher, with copied input and mocked worker execution. */
import {expect,spyOn,test} from "bun:test";
import * as sdk from "@schlessera/brain-ui-sdk/internal";
import {existsSync,mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createHostBoundary,type BrainExecution} from "../src/brain/host-boundary.js";
import * as gitPreparation from "../src/brain/maintenance-git.js";
import {nativeOutputFixture} from "../../ui-sdk/tests/helpers/native-output-fixture.js";

for(const method of ["run","launch"] as const)for(const kind of ["ordinary","maintain","pack"] as const)test(`nonzero ${kind} ${method} keeps Git publication scoped to maintenance`,async()=>{
 const root=mkdtempSync(join(tmpdir(),"odysseus-publication-scope-")),brain=join(root,"brain");
 mkdirSync(join(brain,".git"),{recursive:true});writeFileSync(join(brain,"registry.md"),"Odysseus before");
 const fixture=await nativeOutputFixture(root,brain),report=JSON.stringify([{step:"git",result:"ok — packed 1 loose object(s)"}]);
 const writeOutput=()=>{
  writeFileSync(join(fixture.output.output.source,".git/MERGE_HEAD"),"a".repeat(40)+"\n");
  writeFileSync(join(fixture.output.output.source,"registry.md"),"<<<<<<< Ithaca\nOdysseus\n=======\nAthena\n>>>>>>> voyage\n");
 };
 const mocks=[
  spyOn(sdk,"prepareNativeWorkerStartupView").mockResolvedValue(fixture.view),
  spyOn(sdk,"prepareNativeWorkerOutput").mockResolvedValue(fixture.output),
  spyOn(gitPreparation,"prepareMaintenanceGit").mockResolvedValue(undefined),
  spyOn(sdk,"prepareMaintenanceWorker").mockResolvedValue(undefined),
  spyOn(sdk,"runMaintenanceWorker").mockImplementation(async()=>{writeOutput();return {exitCode:1,stdout:report,stderr:"conflict",killed:false};}),
  spyOn(sdk,"launchMaintenanceWorkerAsync").mockImplementation(async()=>{
   writeOutput();return {pid:process.pid,input:async()=>{},stdout:new Response(report).body!,stderr:new Response("conflict").body!,exited:Promise.resolve(1),released:async()=>{},kill(){}};
  }),
 ];
 try {
  const host=createHostBoundary({brainPath:brain,dbPath:join(root,"ui.db"),nativeManager:fixture.manager,exec:{}});
  const execution:BrainExecution={argv:kind==="ordinary"?["git","merge","voyage"]:[process.execPath,"brain.ts",...(kind==="maintain"?["maintain","--json"]:["storage","pack","--json"])],
   env:{PATH:process.env.PATH},credentials:false,gate:"none",purpose:"Odysseus publication scope",...(kind==="pack"?{maintenanceKind:"git"}: {})};
  let code:number;
  if(method==="run")code=(await host.run(execution)).exitCode;
  else{
   const child=await host.launch(execution);
   const [exit]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
   await child.settled;code=exit;
  }
  expect(code).toBe(1);
  expect(readFileSync(join(brain,"registry.md"),"utf8"),"NONZERO_WORKTREE_OUTPUT_PUBLISHES").toContain("<<<<<<< Ithaca");
  expect(existsSync(join(brain,".git/MERGE_HEAD")),kind==="ordinary"?"NONMAINTENANCE_FAILURE_PUBLISHES_GIT_WITH_WORKTREE":"MAINTENANCE_FAILURE_STILL_DISCARDS_GIT").toBe(kind==="ordinary");
  if(kind==="ordinary")expect(readFileSync(join(brain,".git/MERGE_HEAD"),"utf8")).toBe("a".repeat(40)+"\n");
 }finally{for(const mock of mocks.reverse())mock.mockRestore();await fixture.close();rmSync(root,{recursive:true,force:true});}
});
