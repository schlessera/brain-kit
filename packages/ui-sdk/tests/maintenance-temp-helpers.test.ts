import { createFixtureMaintenanceHost } from "./helpers/worker-startup-view-fixture.js";
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { brainGitSync } from "../src/server/maintenance-worker";
import { reserveMaintenanceTemp } from "../src/server/maintenance-temp-budget";
import { prepareWorkerSandbox } from "../src/server/worker-launcher";
import { assertScratchMask } from "../src/server/bridge-tools/mask";
const roots:string[]=[];
afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
test("hosted startup and mask Git helpers share configured admission and keep a busy refusal truthful",()=>{
 const parent=resolve(import.meta.dir,"../../../tmp");mkdirSync(parent,{recursive:true});
 const root=mkdtempSync(join(parent,"maintenance-helpers-"));roots.push(root);
 const brain=join(root,"brain"),state=join(root,"state");mkdirSync(brain);mkdirSync(state);
 mkdirSync(join(brain,".brain/scratch"),{recursive:true});writeFileSync(join(brain,".gitignore"),".brain/scratch/\n");
 const setup=Bun.spawnSync(["git","init","-q",brain],{env:{PATH:"/usr/bin:/bin"}});expect(setup.exitCode).toBe(0);
 const tempLimits={allowanceBytes:8388608,budgetBytes:8388608};
 const maintenance = createFixtureMaintenanceHost(brain, {tempLimits,tempDomain:{statePath:join(state,"ui.db")},maskPaths:[state]});
 const held=reserveMaintenanceTemp(tempLimits,maintenance.tempDomain);
 try {
  expect(()=>brainGitSync(brain,["rev-parse","--git-dir"],maintenance),"HELPER_SHARED_ADMISSION").toThrow("Maintenance temporary storage is busy");
  const sandbox=prepareWorkerSandbox(brain,{maintenance});
  expect(sandbox.areas.find(area=>area.name==="scratch")!.mount).toMatchObject({writable:false,reason:expect.stringContaining("Maintenance temporary storage is busy")});
  expect(()=>assertScratchMask(brain,".brain/scratch/raft-mask.png",join(brain,".brain/scratch/raft-mask.png"),maintenance),"MASK_HELPER_SHARED_ADMISSION").toThrow("Maintenance temporary storage is busy");
 } finally {held.release();}
 try {
 expect(brainGitSync(brain,["rev-parse","--git-dir"],maintenance)).toBe(0);
 expect(prepareWorkerSandbox(brain,{maintenance}).areas.find(area=>area.name==="scratch")!.mount.writable).toBe(true);
 expect(()=>assertScratchMask(brain,".brain/scratch/raft-mask.png",join(brain,".brain/scratch/raft-mask.png"),maintenance)).not.toThrow();
 } finally { maintenance.cleanup(); }
});
