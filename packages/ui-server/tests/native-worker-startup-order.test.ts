import { expect,spyOn,test } from "bun:test";
import { existsSync,mkdtempSync,rmSync,writeFileSync } from "node:fs";
import { join } from "node:path";
import * as startup from "../../ui-sdk/src/server/worker-startup-view.js";
import { createFixtureWorkerStartupView } from "../../ui-sdk/tests/helpers/worker-startup-view-fixture.js";
import { createGovernedTurns } from "../src/brain/governed-turn.js";

test("a first strict admission refreshes sealed inputs only after trusted scratch creation", async () => {
  const brain=mkdtempSync("/tmp/odysseus-startup-order-"),views:startup.WorkerStartupView[]=[],scratchAtCapture:boolean[]=[];
  writeFileSync(join(brain,".gitignore"),".brain/scratch/\n");
  const acquire=spyOn(startup,"prepareNativeWorkerStartupView").mockImplementation(async path => {
    scratchAtCapture.push(existsSync(join(path,".brain/scratch")));
    const view=createFixtureWorkerStartupView(path);views.push(view);return view;
  });
  let released=0;
  const execution={boundary:{async prepare(){return {available:true};},maintenance:{}},gate(){return {async acquire(){return {release(){released++;}};}};},manifests(){return {};}};
  const turns=createGovernedTurns({nativeManager:{} as never,brainPath:brain,execution:execution as never,profile:"strict",maskPaths:[],async index(){},report(){}});
  try {
    const hold=await turns.begin("odysseus-first-strict",new AbortController().signal);
    try {
      expect(hold.sandbox.areas.find(area=>area.name==="scratch")?.mount.writable).toBe(true);
      expect(scratchAtCapture,"FIRST_STRICT_CHECKPOINT_INCLUDES_HOST_CREATED_SCRATCH").toEqual([false,true]);
      expect(hold.startupView).toBe(views[1]);expect(existsSync(join(hold.startupView!.root,".brain/scratch"))).toBe(true);
      expect(existsSync(views[0]!.root),"REPLACED_ADMISSION_VIEW_RELEASE_IS_AWAITED").toBe(false);
    } finally {await hold.end();}
    expect(released).toBe(1);expect(existsSync(views[1]!.root)).toBe(false);
  } finally {acquire.mockRestore();for(const view of views)await view.cleanup();await turns.close();rmSync(brain,{recursive:true,force:true});}
});
