import { expect,test } from "bun:test";
import { mkdtempSync,mkdirSync,readFileSync,existsSync,rmSync,readdirSync,unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installSubscriptionHelperWitness } from "../packages/ui-backend-claude/tests/helpers/subscription-helper-witness";
import { prepareFixtureWorkerSandbox } from "../packages/ui-sdk/tests/helpers/worker-startup-view-fixture";
import { workerCommand } from "../packages/ui-sdk/src/server/worker-launcher";
test("isolated helper control witnesses execution inside the projected brain",()=>{
 const root=mkdtempSync(join(tmpdir(),"odysseus-helper-view-")),brain=join(root,"brain");mkdirSync(brain);
 try{
  const marker=installSubscriptionHelperWitness(brain,"odysseus-fixture-key");
  expect(existsSync(marker),"PROTECTED_TWIN_MARKER_STARTS_ABSENT").toBe(false);
  const helper=JSON.parse(readFileSync(join(brain,".claude/settings.json"),"utf8")).apiKeyHelper;
  const child=Bun.spawnSync(["bwrap","--unshare-user","--unshare-net","--ro-bind","/usr","/usr","--symlink","usr/bin","/bin","--symlink","usr/lib","/lib","--symlink","usr/lib64","/lib64","--tmpfs","/tmp","--bind",brain,brain,"--chdir",brain,"--","/bin/sh","-c",helper],{env:{PATH:"/usr/bin:/bin"},stdout:"pipe",stderr:"pipe"});
  expect(child.exitCode,child.stderr.toString()).toBe(0);
  expect(existsSync(marker),"HELPER_CONTROL_WITNESS_VISIBLE_IN_PROJECTED_BRAIN").toBe(true);
  expect(child.stdout.toString().trim()).toBe("odysseus-fixture-key");
  expect(readdirSync(brain).filter(name=>name!==".odysseus-helper-ran")).toEqual([".claude"]);
  unlinkSync(marker);
  const sandbox=prepareFixtureWorkerSandbox(brain,{profile:"governed",areas:[]});
  expect(sandbox.profile,"HELPER_PROTECTED_VIEW_IS_GOVERNED").toBe("governed");
  const protectedPlan=workerCommand({brainPath:brain,command:["/bin/sh","-c",helper],env:{HOME:"/nonexistent",PATH:"/usr/bin:/bin"},sandbox});
  expect(protectedPlan.some((arg,i)=>arg==="--bind"&&protectedPlan[i+1]===brain&&protectedPlan[i+2]===brain),"PROTECTED_HELPER_WITNESS_WRITABLE").toBe(true);
  const beforeProtected=readdirSync(brain).sort();
  const protectedChild=Bun.spawnSync(protectedPlan,{env:{PATH:"/usr/bin:/bin"},stdout:"pipe",stderr:"pipe"});
  expect(protectedChild.exitCode,protectedChild.stderr.toString()).toBe(0);
  expect(existsSync(marker),"PROTECTED_HELPER_WITNESS_WRITABLE").toBe(true);
  expect(protectedChild.stdout.toString().trim()).toBe("odysseus-fixture-key");
  // This witness is asserted separately, not counted as brain content.
  expect(readdirSync(brain).filter(name=>name!==".odysseus-helper-ran").sort()).toEqual(beforeProtected);
 }finally{rmSync(root,{recursive:true,force:true});}
});
