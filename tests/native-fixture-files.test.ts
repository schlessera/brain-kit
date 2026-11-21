import {expect,test} from "bun:test";
import {join} from "node:path";
import {spawnGuardFixture} from "./helpers/native-receipt-fixture";
const guard=join(import.meta.dir,"../scripts/test-native-guard.ts");

test("captured external fixture files execute and expose controls without sibling login files",async()=>{
 const {mkdirSync,writeFileSync,mkdtempSync,rmSync}=await import("node:fs");
 const {nativeScriptedService,nativeFixtureFileMounts}=await import("../scripts/test-native-guard");
 const root=mkdtempSync("/tmp/odysseus-captured-external-"),config=join(root,"home/.claude"),managed=join(root,"managed-settings.json");
 mkdirSync(config,{recursive:true});const wrapper=join(root,"worker-wrapper.sh"),visible=join(config,"visible.json");
 writeFileSync(wrapper,"#!/bin/sh\nprintf Ithaca",{mode:0o755});writeFileSync(visible,"{}");writeFileSync(join(config,".credentials.json"),"odysseus-synthetic-login");writeFileSync(join(config,"undeclared.json"),"undeclared");writeFileSync(managed,JSON.stringify({env:{ANTHROPIC_BASE_URL:"https://ithaca.invalid"}}));
 const leave=nativeScriptedService("http://127.0.0.1:9",{fixtureRoots:[root],fixtureFiles:[wrapper,visible,managed]});
 const stage=mkdtempSync("/tmp/odysseus-captured-stage-");
 try{
  const mounts=nativeFixtureFileMounts(stage);
  const python='import os,subprocess,json,errno\nw='+JSON.stringify(wrapper)+'\nc='+JSON.stringify(config)+'\np='+JSON.stringify(managed)+'\nassert os.path.isfile(w),"DECLARED_WRAPPER_EXECUTES"\nassert subprocess.check_output([w])==b"Ithaca","DECLARED_WRAPPER_EXECUTES"\nassert open(c+"/visible.json").read()=="{}","DECLARED_CONTROL_VISIBLE"\nassert not os.path.exists(c+"/.credentials.json"),"UNDECLARED_LOGIN_STAYS_MASKED"\nassert not os.path.exists(c+"/undeclared.json"),"UNDECLARED_SIBLING_STAYS_MASKED"\nassert json.load(open(p))["env"]["ANTHROPIC_BASE_URL"]=="https://ithaca.invalid","MANAGED_CUSTOM_REFUSAL_INPUT_VISIBLE"\nfor path in [w,c+"/visible.json",p]:\n try: open(path,"w")\n except OSError as e: assert e.errno==errno.EROFS\n else: raise AssertionError("CAPTURED_FILE_READONLY")\nprint("EXTERNAL_FIXTURE_EXACT_FILES_ONLY")';
  const child=spawnGuardFixture(["bwrap","--unshare-user","--unshare-pid","--unshare-net","--ro-bind","/","/","--tmpfs","/tmp",...mounts,"--remount-ro","/tmp","--","/usr/bin/python3","-I","-S","-c",python],{env:{PATH:"/usr/bin:/bin"}});
  const [exit,out,err]=await Promise.all([child.exited,new Response(child.stdout).text(),child.guardOutput()]);
  expect(exit,"EXTERNAL_FIXTURE_EXACT_FILES_ONLY "+err).toBe(0);expect(out).toContain("EXTERNAL_FIXTURE_EXACT_FILES_ONLY");
 }finally{leave();rmSync(stage,{recursive:true,force:true});rmSync(root,{recursive:true,force:true});}
});

for(const mode of ["outside","symlink","parent-symlink","dotdot","directory","hardlink","login"] as const)test(`captured fixture files refuse ${mode} sources`,async()=>{
 const code=`import {nativeFixtureDirectory,nativeScriptedService} from ${JSON.stringify(guard)};
 import {mkdtempSync,mkdirSync,writeFileSync,symlinkSync,linkSync,rmSync} from "node:fs";
 const root=nativeFixtureDirectory("odysseus-captured-negative-"),outside=mkdtempSync("/tmp/odysseus-other-root-"),mode=${JSON.stringify(mode)};
 writeFileSync(root+"/file","{}");writeFileSync(outside+"/file","{}");let source=root+"/file";
 if(mode==="outside")source=outside+"/file";
 if(mode==="symlink"){symlinkSync(source,root+"/alias");source=root+"/alias";}
 if(mode==="parent-symlink"){symlinkSync(outside,root+"/alias");source=root+"/alias/file";}
 if(mode==="dotdot")source=root+"/../"+outside.split("/").at(-1)+"/file";
 if(mode==="directory"){mkdirSync(root+"/dir");source=root+"/dir";}
 if(mode==="hardlink"){linkSync(source,root+"/alias");source=root+"/alias";}
 if(mode==="login"){source=root+"/.credentials.json";writeFileSync(source,"odysseus-synthetic-login");}
 try{nativeScriptedService("http://127.0.0.1:9",{fixtureRoots:[root],fixtureFiles:[source]});}catch{}finally{rmSync(root,{recursive:true,force:true});rmSync(outside,{recursive:true,force:true});}`;
 const child=spawnGuardFixture([process.execPath,"-e",code]);const [exit,out]=await Promise.all([child.exited,child.guardOutput()]);
 expect(exit,"CAPTURED_FILE_"+mode.toUpperCase()+"_REFUSED").not.toBe(0);expect(out).toContain("fixture files require a canonical unlinked regular file under a declared root");
});
