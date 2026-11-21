import { watchdogMs } from "../scripts/test-deadlines";
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixtureToolView } from "../scripts/test-native-guard";

test("only read-only system or staged fixture PATH entries preserve exact spelling",()=>{
 const root=mkdtempSync(join(tmpdir(),"odysseus-path-")),outside=mkdtempSync(join(tmpdir(),"odysseus-path-outside-"));
 try {
  const home=join(root,"home"),cwd=join(root,"cwd"),bin=join(root,"bin"),alias=join(root,"alias"),systemAlias=join(root,"system-alias"),toolAlias=join(root,"tool-alias");
  for(const dir of [home,cwd,bin])mkdirSync(dir);symlinkSync(outside,alias);symlinkSync("/usr/bin",systemAlias);symlinkSync(bin,toolAlias);
  for(const path of ["/usr/local/bin:/usr/bin:/bin",bin+":/usr/bin:/bin"]){
   const view=fixtureToolView({PATH:path,HOME:home},cwd,home);
   expect(view.path,"EXACT_READONLY_PATH_PRESERVED").toBe(path);
   expect(view.mounts).toEqual(path.startsWith(bin)?["--ro-bind",realpathSync(bin),realpathSync(bin)]:[]);
  }
  for(const path of [systemAlias+":/usr/bin:/bin",toolAlias+":/usr/bin:/bin",outside+":/usr/bin:/bin",alias+":/usr/bin:/bin","/usr/local/bin/../../../tmp/x:/usr/bin:/bin","/usr/bin:/usr/bin","/usr/bin::/bin","bin:/usr/bin",home+":/usr/bin:/bin"]){
   const view=fixtureToolView({PATH:path,HOME:home},cwd,home);
   expect(view.path,"UNREGISTERED_PATH_CANNOT_GRANT_REWRITE_AUTHORITY").not.toBe(path);
   expect(view.mounts).not.toContain(outside);expect(view.path).not.toContain(outside);
  }
 }finally{rmSync(root,{recursive:true,force:true});rmSync(outside,{recursive:true,force:true});}
});

test("a real synthetic worker retains verified RTK authority only with its original read-only PATH",async()=>{
 const root=mkdtempSync(join(tmpdir(),"odysseus-path-rtk-"));
 try {
  const script=join(root,"probe.ts"),repo=join(import.meta.dir,"..");
  const source=`import {enterMeasurementRtkView} from ${JSON.stringify(join(repo,"scripts/measurement-rtk-fixture.ts"))};
   import {fixtureToolView} from ${JSON.stringify(join(repo,"scripts/test-native-guard.ts"))};
   import {registerWorkerRtk,rewriteWorkerRtk} from ${JSON.stringify(join(repo,"packages/ui-sdk/src/server/worker-rtk.ts"))};
   await enterMeasurementRtkView();
   const result=[];
   for(const requested of ["/usr/local/bin:/usr/bin:/bin","/unregistered/path:/usr/local/bin:/usr/bin:/bin"]){
    const original={PATH:requested,HOME:"/nonexistent"},actual={...original,PATH:fixtureToolView(original,"/tmp").path};
    const child=Bun.spawn(["/usr/bin/python3","-I","-S","-c","import time; print('READY',flush=True); time.sleep(30)"],{env:actual,stdin:"ignore",stdout:"pipe",stderr:"pipe"});
    const reader=child.stdout.getReader();const ready=await reader.read();reader.releaseLock();if(ready.done)throw Error("Synthetic worker failed: "+await new Response(child.stderr).text());
    try{const worker={exited:child.exited};registerWorkerRtk(worker,child.pid,{env:original,brainPath:"/tmp"});
     result.push(await rewriteWorkerRtk(worker,"touch /tmp/brain-worker-scratch/original"));
    }finally{child.kill();await child.exited;}
   }
   console.log(JSON.stringify(result));`;
  require("node:fs").writeFileSync(script,source);
  const child=Bun.spawn([process.execPath,script],{env:{PATH:"/usr/bin:/bin"},stdout:"pipe",stderr:"pipe",timeout:watchdogMs(15000)});
  const [code,out,err]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
  expect(code,err).toBe(0);
  expect(JSON.parse(out.trim()),"REAL_WORKER_RTK_REQUIRES_PRESERVED_PATH").toEqual(["touch /tmp/brain-worker-scratch/rewritten","touch /tmp/brain-worker-scratch/original"]);
 }finally{rmSync(root,{recursive:true,force:true});}
});
