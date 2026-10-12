import { expect,test } from "bun:test";
import { mkdirSync,mkdtempSync,rmSync,writeFileSync } from "node:fs";
import { join,resolve } from "node:path";
import { reserveMaintenanceTemp } from "../../ui-sdk/src/server/maintenance-temp-budget";
import { createHostBoundary } from "../src/brain/host-boundary";
import { gitCheckIgnored } from "../src/schedules/service";
test("schedule Git checks use the configured maintenance domain and refuse busy capacity instead of assuming unignored",()=>{
 const parent=resolve(import.meta.dir,"../../../tmp");mkdirSync(parent,{recursive:true});const root=mkdtempSync(join(parent,"maintenance-schedule-"));
 try{
  const brain=join(root,"brain"),state=join(root,"state");mkdirSync(brain);mkdirSync(state);mkdirSync(join(brain,".brain/scratch"),{recursive:true});writeFileSync(join(brain,".gitignore"),".brain/scratch/\n");
  expect(Bun.spawnSync(["git","init","-q",brain],{env:{PATH:"/usr/bin:/bin"}}).exitCode).toBe(0);
  const tempLimits={allowanceBytes:8388608,budgetBytes:8388608};const boundary=createHostBoundary({brainPath:brain,dbPath:join(state,"ui.db"),maintenanceTemp:tempLimits});
  expect(boundary.isolated()).toBe(true);const ignored=gitCheckIgnored(brain,boundary);
  const held=reserveMaintenanceTemp(tempLimits,boundary.maintenance!.tempDomain);
  try{expect(()=>ignored(".brain/scratch/"),"SCHEDULE_SHARED_ADMISSION").toThrow("Maintenance temporary storage is busy");}finally{held.release();}
  expect(ignored(".brain/scratch/")).toBe(true);
 }finally{rmSync(root,{recursive:true,force:true});}
});
