import { expect,test } from "bun:test";
import { mkdtempSync,mkdirSync,readFileSync,existsSync,rmSync,readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installSubscriptionHelperWitness } from "../packages/ui-backend-claude/tests/helpers/subscription-helper-witness";
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
  // This witness is asserted separately, not counted as brain content.
  expect(readdirSync(brain).filter(name=>name!==".odysseus-helper-ran")).toEqual([".claude"]);
 }finally{rmSync(root,{recursive:true,force:true});}
});
