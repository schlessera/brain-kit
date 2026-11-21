import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { nativeFixtureDirectory, nativeFixtureFileMounts, nativeScriptedService } from "../scripts/test-native-guard";
import { spawnGuardFixture } from "./helpers/native-receipt-fixture";
const guard=join(import.meta.dir,"../scripts/test-native-guard.ts");
const json=JSON.stringify({env:{ANTHROPIC_BASE_URL:"https://ithaca.invalid"}});

test("managed-custom keyless view retains only exact declared settings bytes read-only",()=>{
 const root=nativeFixtureDirectory("odysseus-managed-settings-"),file=join(root,"managed.json"),stage=join(root,"stage");mkdirSync(stage);writeFileSync(file,json);writeFileSync(join(root,"undeclared.json"),"private fixture file");
 const leave=nativeScriptedService("http://127.0.0.1:9",{fixtureRoots:[root],fixtureFiles:[file]});
 try {
  writeFileSync(file,"{}");const mounts=nativeFixtureFileMounts(stage);
  const code='import os,json,errno\np='+JSON.stringify(file)+'\nassert os.path.exists(p),"MANAGED_CUSTOM_REFUSAL_INPUT_VISIBLE"\nassert open(p).read()=='+JSON.stringify(json)+'\nassert json.load(open(p))["env"]["ANTHROPIC_BASE_URL"]=="https://ithaca.invalid"\nassert not os.path.exists('+JSON.stringify(join(root,'undeclared.json'))+')\ntry: open(p,"w")\nexcept OSError as e: assert e.errno==errno.EROFS\nelse: raise AssertionError("settings writable")\nprint("MANAGED_CUSTOM_REFUSAL_INPUT_VISIBLE")';
  const child=Bun.spawnSync(["bwrap","--unshare-user","--unshare-pid","--unshare-net","--die-with-parent","--ro-bind","/usr","/usr","--symlink","usr/bin","/bin","--symlink","usr/lib","/lib","--symlink","usr/lib64","/lib64","--tmpfs","/etc","--tmpfs",root,"--proc","/proc","--dev","/dev",...mounts,"--remount-ro","/etc","--","/usr/bin/python3","-I","-S","-c",code],{env:{PATH:"/usr/bin:/bin"},stdout:"pipe",stderr:"pipe"});
  expect(child.exitCode,"MANAGED_CUSTOM_REFUSAL_INPUT_VISIBLE "+child.stderr.toString()).toBe(0);expect(child.stdout.toString()).toContain("MANAGED_CUSTOM_REFUSAL_INPUT_VISIBLE");
  expect(mounts[0]).toBe("--ro-bind");expect(mounts[2]).toBe(file);expect(readFileSync(mounts[1]!,"utf8")).toBe(json);
 }finally{leave();rmSync(root,{recursive:true,force:true});}
});

test("undeclared managed settings do not add a worker mount",()=>{
 const root=nativeFixtureDirectory("odysseus-managed-absent-");writeFileSync(join(root,"managed.json"),json);
 const leave=nativeScriptedService("http://127.0.0.1:9",{fixtureRoots:[root]});
 try{expect(nativeFixtureFileMounts(root)).toEqual([]);}finally{leave();rmSync(root,{recursive:true,force:true});}
});

for(const mode of ["outside","symlink","parent-symlink","dotdot","hardlink"] as const)test(`managed settings refuse ${mode} registration`,async()=>{
 const child=spawnGuardFixture([process.execPath,"-e",`
  import {nativeFixtureDirectory,nativeScriptedService} from ${JSON.stringify(guard)};
  import {mkdtempSync,writeFileSync,symlinkSync,linkSync,rmSync,statSync} from "node:fs";
  const mode=${JSON.stringify(mode)};
  const root=nativeFixtureDirectory("odysseus-managed-negative-"),outside=mkdtempSync("/tmp/odysseus-unregistered-");
  writeFileSync(root+"/managed.json","{}");writeFileSync(outside+"/managed.json","{}");
  let file;
  if(mode==="hardlink"){linkSync(outside+"/managed.json",root+"/hardlink");file=root+"/hardlink";}
  else if(mode==="symlink"){symlinkSync(root+"/managed.json",root+"/alias");file=root+"/alias";}
  else if(mode==="parent-symlink"){symlinkSync(outside,root+"/linkdir");file=root+"/linkdir/managed.json";}
  else if(mode==="dotdot")file=root+"/../"+outside.split("/").pop()+"/managed.json";
  else file=outside+"/managed.json";
  if(mode!=="hardlink"&&statSync(file).nlink!==1)throw Error("NEGATIVE_CASE_MUST_NOT_BORROW_HARDLINK_REFUSAL");
  try{nativeScriptedService("http://127.0.0.1:9",{fixtureRoots:[root],fixtureFiles:[file]});}catch{}finally{rmSync(root,{recursive:true,force:true});rmSync(outside,{recursive:true,force:true});}
 `],{env:{PATH:"/usr/bin:/bin"}});
 const [code,out]=await Promise.all([child.exited,child.guardOutput()]);expect(code,`MANAGED_SETTINGS_${mode.toUpperCase()}_MUST_REFUSE`).not.toBe(0);expect(out).toContain("fixture files require a canonical unlinked regular file under a declared root");expect(out).toContain('"nativeLaunched":false');
});
