import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { nativeFixtureDirectory, nativeFixtureManagedSettingsMounts, nativeScriptedService } from "../scripts/test-native-guard";
import { spawnGuardFixture } from "./helpers/native-receipt-fixture";
const guard=join(import.meta.dir,"../scripts/test-native-guard.ts");
const json=JSON.stringify({env:{ANTHROPIC_BASE_URL:"https://ithaca.invalid"}});

test("managed-custom keyless view retains only exact declared settings bytes read-only",()=>{
 const root=nativeFixtureDirectory("odysseus-managed-settings-"),file=join(root,"managed.json"),stage=join(root,"stage");mkdirSync(stage);writeFileSync(file,json);writeFileSync(join(root,"undeclared.json"),"private fixture file");
 const leave=nativeScriptedService("http://127.0.0.1:9",{fixtureRoots:[root],managedSettingsFile:file});
 try {
  writeFileSync(file,"{}");const mounts=nativeFixtureManagedSettingsMounts(stage);
  const code='import os,json,errno\np="/etc/claude-code/managed-settings.json"\nassert os.path.exists(p),"MANAGED_CUSTOM_REFUSAL_INPUT_VISIBLE"\nassert open(p).read()=='+JSON.stringify(json)+'\nassert json.load(open(p))["env"]["ANTHROPIC_BASE_URL"]=="https://ithaca.invalid"\nassert not os.path.exists("/etc/claude-code/undeclared.json")\ntry: open(p,"w")\nexcept OSError as e: assert e.errno==errno.EROFS\nelse: raise AssertionError("settings writable")\nprint("MANAGED_CUSTOM_REFUSAL_INPUT_VISIBLE")';
  const child=Bun.spawnSync(["bwrap","--unshare-user","--unshare-pid","--unshare-net","--die-with-parent","--ro-bind","/usr","/usr","--symlink","usr/bin","/bin","--symlink","usr/lib","/lib","--symlink","usr/lib64","/lib64","--tmpfs","/etc","--dir","/etc/claude-code","--proc","/proc","--dev","/dev",...mounts,"--remount-ro","/etc","--","/usr/bin/python3","-I","-S","-c",code],{env:{PATH:"/usr/bin:/bin"},stdout:"pipe",stderr:"pipe"});
  expect(child.exitCode,"MANAGED_CUSTOM_REFUSAL_INPUT_VISIBLE "+child.stderr.toString()).toBe(0);expect(child.stdout.toString()).toContain("MANAGED_CUSTOM_REFUSAL_INPUT_VISIBLE");
  expect(mounts[0]).toBe("--ro-bind");expect(mounts[2]).toBe("/etc/claude-code/managed-settings.json");expect(readFileSync(mounts[1]!,"utf8")).toBe(json);
 }finally{leave();rmSync(root,{recursive:true,force:true});}
});

test("undeclared managed settings do not add a worker mount",()=>{
 const root=nativeFixtureDirectory("odysseus-managed-absent-");writeFileSync(join(root,"managed.json"),json);
 const leave=nativeScriptedService("http://127.0.0.1:9",{fixtureRoots:[root]});
 try{expect(nativeFixtureManagedSettingsMounts(root)).toEqual([]);}finally{leave();rmSync(root,{recursive:true,force:true});}
});

for(const mode of ["outside","symlink","hardlink"] as const)test(`managed settings refuse ${mode} registration`,async()=>{
 const child=spawnGuardFixture([process.execPath,"-e",`
  import {nativeFixtureDirectory,nativeScriptedService} from ${JSON.stringify(guard)};
  import {mkdtempSync,writeFileSync,symlinkSync,linkSync,rmSync} from "node:fs";
  const root=nativeFixtureDirectory("odysseus-managed-negative-"),outside=mkdtempSync("/tmp/odysseus-unregistered-");
  writeFileSync(root+"/managed.json","{}");writeFileSync(outside+"/managed.json","{}");symlinkSync(root+"/managed.json",root+"/alias");linkSync(outside+"/managed.json",root+"/hardlink");
  try{nativeScriptedService("http://127.0.0.1:9",{fixtureRoots:[root],managedSettingsFile:${mode==="outside"?'outside+"/managed.json"':mode==="hardlink"?'root+"/hardlink"':'root+"/alias"'}});}catch{}finally{rmSync(root,{recursive:true,force:true});rmSync(outside,{recursive:true,force:true});}
 `],{env:{PATH:"/usr/bin:/bin"}});
 const [code,out]=await Promise.all([child.exited,child.guardOutput()]);expect(code).not.toBe(0);expect(out).toContain("managed settings require an unlinked fixture-created regular file");expect(out).toContain('"nativeLaunched":false');
});
