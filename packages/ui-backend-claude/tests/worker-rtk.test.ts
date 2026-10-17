import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { isStaticNativeElf } from "../../ui-sdk/src/server/worker-rtk.js";

const root = resolve(import.meta.dir, "../../..");
test("actual worker RTK visibility preserves host-only commands and keeps visible rewrites", async () => {
  const fixture = mkdtempSync(join(root, "tmp/rtk-worker-"));
  try {
    const bin = join(fixture, "bin"); mkdirSync(bin);
    const source = join(fixture, "rtk.c");
    writeFileSync(source, `#include <stdio.h>
#include <string.h>
#include <unistd.h>
#include <stdlib.h>
int main(int argc,char**argv){
if(argc>1&&(!strcmp(argv[1],"--version")||!strcmp(argv[1],"hook"))){char cwd[4096];if(getenv("SERVER_SECRET")||getenv("CLAUDE_CODE_OAUTH_TOKEN")||!getcwd(cwd,sizeof(cwd))||strcmp(cwd,"/"))return 8;}
if(argc>1&&!strcmp(argv[1],"--version")){puts("Odysseus RTK fixture");return 0;}
if(argc>1&&!strcmp(argv[1],"hook")){char c;while(read(0,&c,1)>0){}puts("{\\\"hookSpecificOutput\\\":{\\\"updatedInput\\\":{\\\"command\\\":\\\"rtk cat witness\\\"}}}");return 0;}
if(argc==3&&!strcmp(argv[1],"cat")){FILE*f=fopen(argv[2],"r");if(!f)return 2;int c;while((c=fgetc(f))!=EOF)putchar(c);fclose(f);return 0;}return 3;}
`);
    const compiled = Bun.spawnSync(["cc", "-static-pie", "-o", join(bin, "rtk"), source], { stdout: "pipe", stderr: "pipe" });
    expect(compiled.exitCode, compiled.stderr.toString()).toBe(0);
    expect(isStaticNativeElf(join(bin, "rtk"))).toBe(true);
    const native = readFileSync(join(bin, "rtk"));
    const foreign = Buffer.from(native); foreign.writeUInt16LE(process.arch === "x64" ? 183 : 62, 18);
    const foreignPath = join(fixture, "foreign-rtk"); writeFileSync(foreignPath, foreign);
    expect(isStaticNativeElf(foreignPath), "foreign ELF cannot borrow a binfmt loader").toBe(false);
    const relocatable = Buffer.from(native); relocatable.writeUInt16LE(1, 16);
    const relocatablePath = join(fixture, "relocatable-rtk"); writeFileSync(relocatablePath, relocatable);
    expect(isStaticNativeElf(relocatablePath), "ELF object files cannot authorize an executable").toBe(false);
    const dependent = Buffer.from(native), phoff = Number(native.readBigUInt64LE(32));
    let replaced = false;
    for (let i = 0; i < native.readUInt16LE(56); i++) {
      const at = phoff + native.readUInt16LE(54) * i;
      if (native.readUInt32LE(at) !== 2) continue;
      const begin = Number(native.readBigUInt64LE(at + 8)), length = Number(native.readBigUInt64LE(at + 32));
      for (let entry = begin; entry < begin + length; entry += 16) if (native.readBigUInt64LE(entry) === 21n) {
        dependent.writeBigUInt64LE(1n, entry); replaced = true; break;
      }
    }
    expect(replaced, "static PIE fixture has a DT_DEBUG slot for the dependency mutation").toBe(true);
    const dependentPath = join(fixture, "dependent-rtk"); writeFileSync(dependentPath, dependent);
    expect(isStaticNativeElf(dependentPath), "PT_DYNAMIC cannot hide an external DT_NEEDED dependency").toBe(false);

    const probe = join(fixture, "probe.ts");
    writeFileSync(probe, `import {mkdirSync,writeFileSync} from "node:fs";
import {join} from "node:path";
import {launchFixtureAgentWorker} from ${JSON.stringify(join(root, "packages/ui-sdk/tests/helpers/worker-startup-view-fixture.ts"))};
import {rewriteWorkerRtk} from ${JSON.stringify(join(root, "packages/ui-sdk/src/server/worker-rtk.ts"))};
import {createRtkHook} from ${JSON.stringify(join(root, "packages/ui-backend-claude/src/input-rewrite-hooks.ts"))};
const brain=join(${JSON.stringify(fixture)},"brain");mkdirSync(brain);writeFileSync(join(brain,"witness"),"Odysseus sails\\n");
const env={PATH:"/usr/local/bin:/usr/bin:/bin",HOME:"/nonexistent"};
const results=[];
const repoBin=join(brain,"node_modules/.bin");mkdirSync(repoBin,{recursive:true});
const marker=join(brain,"host-oracle-executed");
writeFileSync(join(repoBin,"rtk"),"#!/bin/sh\\n: > "+JSON.stringify(marker)+"\\nexit 1\\n",{mode:0o755});
for(const mode of ["host-only","visible","host-only-after-visible","repo-first","unknown"]){
const workerEnv=mode==="repo-first"?{...env,PATH:repoBin+":"+env.PATH}:env;
const worker=launchFixtureAgentWorker({brainPath:brain,command:["/bin/bash","--noprofile","--norc","-c",'printf "READY\\\\n"; IFS= read -r command; /bin/bash --noprofile --norc -c "$command"'],env:workerEnv,
sandbox:{brain,profile:"governed",restricted:false,areas:[],scratchAliasesRemoved:[],maskPaths:mode.startsWith("host-only")?["/usr/local/bin"]:[]}});
let output="",errors="";let ready;const readyPromise=new Promise(resolve=>ready=resolve);
worker.stdout.on("data",chunk=>{output+=chunk; if(output.includes("READY\\n"))ready();});worker.stderr.on("data",chunk=>errors+=chunk);
let timer; try { await Promise.race([readyPromise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error("worker readiness timeout")),3000);})]); } finally {clearTimeout(timer); }
const hook=createRtkHook(env,{mayGrant:false,rewriteCommand:(command)=>rewriteWorkerRtk(mode==="unknown"?undefined:worker,command)});
const response=await hook({hook_event_name:"PreToolUse",tool_name:"Bash",tool_input:{command:"cat witness"},tool_use_id:"rtk",session_id:"fixture",cwd:brain,transcript_path:""},undefined,{signal:new AbortController().signal});
const command=response.hookSpecificOutput?.updatedInput?.command??"cat witness";
worker.stdin.end(command+"\\n");const code=await worker.exited;
results.push({mode,command,code,output,errors,afterExit:await rewriteWorkerRtk(worker,"cat witness"),hostExecuted:require("node:fs").existsSync(marker),granted:response.hookSpecificOutput?.permissionDecision});
}
console.log(JSON.stringify(results));
`);
    // Private installation metadata belongs to this namespace's trusted UID.
    // Setup retains only the capabilities needed for a nested UID map; the
    // actual product worker still drops ALL capabilities.
    // Real host-root owners are overflow IDs in a user namespace and must NOT
    // be assumed trusted. The system runtime binds remain read-only.
    const child = Bun.spawn(["bwrap", "--unshare-user", "--uid", "0", "--gid", "0", "--unshare-pid", "--unshare-net", "--cap-add", "CAP_SETUID", "--cap-add", "CAP_SETGID", "--cap-add", "CAP_SYS_ADMIN", "--cap-add", "CAP_SETFCAP", "--die-with-parent", "--new-session",
      "--tmpfs", "/", "--ro-bind", "/usr/bin", "/usr/bin", "--ro-bind", "/usr/lib", "/usr/lib", "--ro-bind", "/usr/lib64", "/usr/lib64", "--ro-bind", "/etc", "/etc",
      "--symlink", "usr/bin", "/bin", "--symlink", "usr/lib", "/lib", "--symlink", "usr/lib64", "/lib64", "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp",
      "--dir", "/usr/local/bin", "--ro-bind", join(bin, "rtk"), "/usr/local/bin/rtk", "--ro-bind", root, root, "--bind", fixture, fixture,
      "--ro-bind", process.execPath, process.execPath, "--clearenv", "--setenv", "PATH", "/usr/local/bin:/usr/bin:/bin", "--setenv", "SERVER_SECRET", "fixture-server-secret", "--setenv", "CLAUDE_CODE_OAUTH_TOKEN", "fixture-provider-token", "--chdir", fixture,
      "--", process.execPath, "--preload", join(root, "scripts/test-network-child-preload.ts"), probe], { env: {}, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(code, stderr).toBe(0);
    const results = JSON.parse(stdout.trim());
    for (const result of results) {
      expect(result.code, `${result.mode}: ${result.errors}`).toBe(0);
      expect(result.output).toContain("Odysseus sails");
      expect(result.granted).toBeUndefined();
      expect(result.afterExit).toBe("cat witness");
      expect(result.hostExecuted).toBe(false);
      expect(result.command).toBe(result.mode === "visible" ? "rtk cat witness" : "cat witness");
    }
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});
