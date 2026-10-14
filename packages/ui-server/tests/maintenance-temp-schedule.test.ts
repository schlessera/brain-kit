import { expect,test } from "bun:test";
import { mkdirSync,writeFileSync } from "node:fs";
import { join } from "node:path";
import { reserveMaintenanceTemp } from "../../ui-sdk/src/server/maintenance-temp-budget";
import { createHostBoundary } from "../src/brain/host-boundary";
import { gitCheckIgnored } from "../src/schedules/service";
import { createNativeHostInputFixture } from "./helpers/native-host-input-fixture";
test("schedule Git checks use the configured maintenance domain and refuse busy capacity instead of assuming unignored",async()=>{
 const fixture=createNativeHostInputFixture();const brain=fixture.brain,state=join(brain,"..","state");
 try{
  mkdirSync(state);mkdirSync(join(brain,".brain/scratch"),{recursive:true});writeFileSync(join(brain,".gitignore"),".brain/scratch/\n");
  expect(Bun.spawnSync(["git","init","-q",brain],{env:{PATH:"/usr/bin:/bin"}}).exitCode).toBe(0);
  const tempLimits={allowanceBytes:8388608,budgetBytes:8388608};const boundary=createHostBoundary({brainPath:brain,nativeManager:fixture.manager,dbPath:join(state,"ui.db"),maintenanceTemp:tempLimits});
  expect((await boundary.prepare()).available).toBe(true);
  expect(boundary.isolated()).toBe(true);const ignored=gitCheckIgnored(brain,boundary);
  const held=reserveMaintenanceTemp(tempLimits,boundary.maintenance!.tempDomain);
  try{await expect(ignored(".brain/scratch/"),"SCHEDULE_SHARED_ADMISSION").rejects.toThrow("Maintenance temporary storage is busy");}finally{held.release();}
  expect(await ignored(".brain/scratch/")).toBe(true);
 }finally{fixture.cleanup();}
});
