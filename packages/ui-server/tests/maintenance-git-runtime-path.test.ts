import {expect,spyOn,test} from "bun:test";
import * as sdk from "@schlessera/brain-ui-sdk/internal";
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {nativeOutputFixture} from "../../ui-sdk/tests/helpers/native-output-fixture.js";
import {prepareMaintenanceGit} from "../src/brain/maintenance-git.js";

test("the selected Git binary is a readable runtime input for config, attributes and the final launch",async()=>{
 const root=mkdtempSync(join(tmpdir(),"odysseus-git-runtime-")),brain=join(root,"brain");mkdirSync(join(brain,".git"),{recursive:true});writeFileSync(join(brain,".git/config"),"");
 const fixture=await nativeOutputFixture(root,brain),binary=join(root,"bin/git");mkdirSync(join(root,"bin"));writeFileSync(binary,"#!/bin/sh\nexit 0\n",{mode:0o755});
 const which=Bun.which,selected=spyOn(Bun,"which").mockImplementation((name,options)=>name==="git"?binary:which(name,options));
 const calls:Parameters<typeof sdk.runMaintenanceWorker>[0][]=[];
 const worker=spyOn(sdk,"runMaintenanceWorker").mockImplementation(async input=>{calls.push(input);return {exitCode:0,stdout:input.command[0]===binary?"":"a".repeat(40)+"\n",stderr:"",killed:false};});
 try {
  const command:sdk.MaintenanceCommand={brainPath:brain,command:[process.execPath,"brain.ts","maintain","--json"],env:{},credentials:true,readPaths:[]};
  await prepareMaintenanceGit(command,{...fixture.output,output:{...fixture.output.output,target:"/tmp/brain-maintenance-output"}});
  expect(calls).toHaveLength(2);
  expect(calls.every(input=>input.readPaths?.includes(binary)),"GIT_BINARY_IS_READABLE_IN_EVERY_PREPARATION").toBe(true);
  expect(command.readPaths,"GIT_BINARY_IS_READABLE_IN_FINAL_LAUNCH").toContain(binary);
 }finally{worker.mockRestore();selected.mockRestore();await fixture.close();rmSync(root,{recursive:true,force:true});}
});
