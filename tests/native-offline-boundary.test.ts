import { spawnGuardFixture } from "./helpers/native-receipt-fixture";
/** Local tests never execute the installed native runtime, including mutations. */
import { expect, test } from "bun:test";
import { watchdogMs } from "../scripts/test-deadlines";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { bundledClaudeBinary } from "../packages/core/src/providers/agents/claude-binary";
import { isNativeClaude, nativeClaudeBoundary } from "../scripts/test-native-guard";

const ROOT = join(import.meta.dir, "..");
const runtime = bundledClaudeBinary();
if (!runtime) throw new Error("Native boundary proof requires the installed SDK runtime identity");

async function probe(script: string, home: string) {
  const path = join(home, "probe.ts"); writeFileSync(path, script);
  const child = spawnGuardFixture([process.execPath, "--no-install", path], { env: { PATH: "/usr/bin:/bin", HOME: home }, stdout: "pipe", stderr: "pipe" });
  const [code, output] = await Promise.all([child.exited, child.guardOutput()]);
  return { code, output };
}
const imports = `import {installNetworkGuard} from ${JSON.stringify(join(ROOT, "scripts/test-network-guard.ts"))};
  import {nativeClaudeBoundary,nativeScriptedService as registerService} from ${JSON.stringify(join(ROOT, "scripts/test-native-guard.ts"))};
  delete process.env.GITHUB_ACTIONS; delete process.env.RUNNER_ENVIRONMENT; installNetworkGuard();
  const registerScriptedService=(origin)=>registerService(origin,{fixtureRoots:[process.env.HOME]});`;

// Check one bwrap scope at a time: the nested native view deliberately hides
// the trace directory, while its outer tracer must retain that mount.
const guardMountOrderCheck = `function assertGuardMountOrder(mounts,expectedRemounts=[]) {
  const operations=[],remounts=[];
  for(let i=0;i<mounts.length;i++) {
    const flag=mounts[i];
    if(["--bind","--ro-bind","--dev-bind"].includes(flag)) {operations.push({at:i,bind:true,target:mounts[i+2]});i+=2;}
    else if(["--tmpfs","--proc","--dev"].includes(flag)){operations.push({at:i,bind:false,target:mounts[++i]});}
    else if(flag==="--remount-ro")remounts.push({at:i,target:mounts[++i]});
    else if(flag.startsWith("--overlay"))throw Error("unsupported overlay reached native plan");
  }
  const lastBind=Math.max(...operations.filter(op=>op.bind).map(op=>op.at));
  for(const target of expectedRemounts)if(!remounts.some(op=>op.target===target&&op.at>lastBind))throw Error("ORIGINAL_READONLY_REMOUNT_PRESERVED "+target);
  for(const bind of operations.filter(op=>op.bind))for(const earlier of remounts)if(earlier.at<bind.at&&(earlier.target==="/"||bind.target===earlier.target||bind.target.startsWith(earlier.target+"/")))throw Error("GUARD_MOUNT_FOLLOWS_READONLY_PARENT");
  for(const bind of operations.filter(op=>op.bind))for(const later of operations) {
    if(later.at>bind.at && (later.target==="/" || bind.target===later.target || bind.target.startsWith(later.target+"/")))throw Error("GUARD_BIND_HIDDEN_BY_LATER_MOUNT");
  }
}`;

test("a harmless fixture named claude runs without native admission", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "odysseus-fixture-runtime-"));
  try {
    const executable = join(scratch, "claude"), marker = join(scratch, "launched");
    writeFileSync(executable, `#!/bin/sh\nprintf launched > '${marker}'\n`); chmodSync(executable, 0o700);
    expect(isNativeClaude(executable)).toBe(false);
    const result = await probe(`${imports} import {spawn} from "node:child_process"; spawn(${JSON.stringify(executable)}, []);`, scratch);
    expect(result.code, result.output).toBe(0); expect(existsSync(marker)).toBe(true);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});

test("native identity finds wrapped and flagged interpreter targets", () => {
  expect(isNativeClaude(process.execPath, [runtime!])).toBe(true);
  expect(isNativeClaude(process.execPath, ["--preload", "fixture.ts", runtime!])).toBe(true);
  expect(isNativeClaude("/usr/bin/true", [runtime!])).toBe(true);
  expect(isNativeClaude(process.execPath, ["-e", runtime!])).toBe(true);
  for (const flag of ["--conditions", "--env-file", "--experimental-loader", "--cwd", "-c"]) {
    expect(isNativeClaude(process.execPath, [flag, "odysseus-fixture", runtime!])).toBe(true);
  }
  expect(isNativeClaude("/usr/bin/true", ["--conditions", "odysseus-fixture", runtime!])).toBe(true);
  for (const flag of ["--require", "--preload"]) {
    expect(isNativeClaude(process.execPath, [flag+"="+runtime])).toBe(true);
  }
});

for (const worker of [false,true]) test(`wrapper-launched installed runtime refuses before ${worker ? "worker" : "direct"} bootstrap`, async () => {
  const scratch = mkdtempSync(join(tmpdir(), "odysseus-wrapper-refusal-"));
  try {
    const wrapper=join(scratch,"exec-wrapper"), marker=join(scratch,"launched");
    // This fixture never execs its argument, even under a broken guard.
    writeFileSync(wrapper, `#!/bin/sh\nprintf launched > '${marker}'\n`);chmodSync(wrapper,0o700);
      const result=await probe(`${imports}
        const wrapper=${JSON.stringify(wrapper)},runtime=${JSON.stringify(runtime)};
        Bun.spawn([wrapper,runtime],${worker ? `{env:{BRAIN_WORKER_LAUNCH:JSON.stringify({command:[wrapper,runtime],argv:["bwrap","--",wrapper,runtime]})}}` : `{}`});`,scratch);
      expect(result.code,result.output).not.toBe(0);
      expect(existsSync(marker)).toBe(false);
      expect(result.output).toContain('"success":false,"nativeLaunched":false');
  } finally {rmSync(scratch,{recursive:true,force:true});}
});

test("status-pipe worker launches treat descriptor arguments as data", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "odysseus-status-pipe-"));
  try {
    const result = await probe(`${imports}
      import {nativeWorkerBoundary,isNativeClaude} from ${JSON.stringify(join(ROOT,"scripts/test-native-guard.ts"))};
      import {openSync,closeSync} from "node:fs";
      const fifo=process.env.HOME+"/status";
      if(Bun.spawnSync(["/usr/bin/mkfifo",fifo]).exitCode!==0)throw Error("fixture FIFO failed");
      const fd=openSync(fifo,"r+");
      if(isNativeClaude("/usr/bin/true",[\`/proc/\${process.pid}/fd/1\`]))throw Error("pipe data classified as native");
      const status=["/bin/sh","-c",'exec 3>"$1"; exec 4<"$2"; shift 2; exec "$@"',"brain-worker-status",
        \`/proc/\${process.pid}/fd/\${fd}\`,\`/proc/\${process.pid}/fd/\${fd}\`,"/usr/bin/true"];
      if(isNativeClaude(status[0],status.slice(1)))throw Error("status descriptors classified as native");
      const plan=nativeWorkerBoundary({BRAIN_WORKER_LAUNCH:JSON.stringify({command:["/usr/bin/true"],argv:status})});
      const child=Bun.spawn(status,{env:plan.env,stdout:"pipe",stderr:"pipe"});
      if(await child.exited!==0)throw Error(await new Response(child.stderr).text());
      plan.dispose();closeSync(fd);`, scratch);
    expect(result.code, result.output).toBe(0);
    expect(result.output).not.toContain("native executable metadata is unavailable");
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});

test("worker exec payload refuses before its synthetic bootstrap starts", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "odysseus-worker-refusal-"));
  try {
    const marker = join(scratch, "launched");
    // The declared payload is real, but this bootstrap can only write a marker.
    // Removing admission in a mutation can never launch the installed runtime.
    const result = await probe(`${imports} Bun.spawn(["/bin/sh", "-c", ${JSON.stringify(`printf launched > '${marker}'`)}],
      {env:{BRAIN_WORKER_LAUNCH:JSON.stringify({command:[${JSON.stringify(runtime)}],argv:["bwrap","--",${JSON.stringify(runtime)}]})}});`, scratch);
    expect(result.code).not.toBe(0); expect(existsSync(marker)).toBe(false);
    expect(result.output).toContain('"success":false,"nativeLaunched":false');
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});

test("catching a native refusal and exiting zero still fails the child", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "odysseus-caught-refusal-"));
  try {
    // Plan admission only: no spawn of the installed runtime, even if broken.
    const result = await probe(`${imports} try { nativeClaudeBoundary(${JSON.stringify(runtime)}, [], {}); } catch {} process.exit(0);`, scratch);
    expect(result.code).not.toBe(0);
    expect(result.output).toContain('"success":false,"nativeLaunched":false');
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});

test("runtime provenance follows a symlink and detects an arbitrarily named byte-identical copy", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "odysseus-runtime-identity-"));
  try {
    const linked = join(scratch, "odysseus-link"), copied = join(scratch, "odysseus-copy");
    symlinkSync(runtime!, linked); copyFileSync(runtime!, copied);
    const equals = join(scratch,"odysseus=runtime");symlinkSync(runtime!,equals);
    expect(isNativeClaude(process.execPath,["--require="+equals])).toBe(true);
    symlinkSync(runtime!,join(scratch,"--odysseus-runtime"));
    expect(isNativeClaude("--odysseus-runtime",[],{env:{PATH:scratch},cwd:scratch})).toBe(true);
    for (const path of [linked, copied]) {
      expect(isNativeClaude(path)).toBe(true);
      // Refusal planning is safe even under a broken guard: it never execs.
      const result = await probe(`${imports} nativeClaudeBoundary(${JSON.stringify(path)}, [], {});`, scratch);
      expect(result.code).not.toBe(0);
      expect(result.output).toContain('"success":false,"nativeLaunched":false');
      expect(result.output).toContain("positive native proof requires a hosted runner");
    }
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});

test("native identity uses the child's PATH and cwd", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "odysseus-child-resolution-"));
  try {
    symlinkSync(runtime!, join(scratch, "odysseus-selected"));
    expect(isNativeClaude("odysseus-selected", [], { env: { PATH: scratch }, cwd: "/" })).toBe(true);
    expect(isNativeClaude("./odysseus-selected", [], { env: { PATH: "/usr/bin:/bin" }, cwd: scratch })).toBe(true);
    expect(isNativeClaude("/usr/bin/true", [], { env: { PATH: scratch }, cwd: scratch })).toBe(false);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});

test("missing bubblewrap emits a failed receipt and cannot be caught into success", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "odysseus-missing-isolation-"));
  try {
    const result = await probe(`${imports}
      process.env.GITHUB_ACTIONS="true"; process.env.RUNNER_ENVIRONMENT="github-hosted";
      const original=Bun.spawnSync;
      Bun.spawnSync=((...args)=>{if(args[0]?.[0]==="bwrap")throw Object.assign(new Error("synthetic missing isolation"),{code:"ENOENT"});return Reflect.apply(original,Bun,args);});
      try { nativeClaudeBoundary(${JSON.stringify(runtime)}, [], {}); } catch {} process.exit(0);`, scratch);
    expect(result.code).not.toBe(0);
    expect(result.output).toContain('"success":false,"nativeLaunched":false');
    expect(result.output).toContain('"reason":"OS namespace setup failed"');
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});

test("missing kernel lifetime socket policy refuses before native launch", async () => {
  const scratch=mkdtempSync(join(tmpdir(),"odysseus-kernel-policy-"));
  try {
    const result=await probe(`${imports}
      const original=Bun.spawnSync; const which=Bun.which;
      Bun.which=((name,options)=>name==="strace"?"/synthetic/strace":which(name,options));
      Bun.spawnSync=((argv,options)=>["bwrap","strace"].includes(argv[0])?{exitCode:0,stdout:Buffer.alloc(0),stderr:Buffer.alloc(0)}:argv[0]?.endsWith("/native-connect")?{exitCode:125,stdout:Buffer.alloc(0),stderr:Buffer.alloc(0)}:Reflect.apply(original,Bun,[argv,options]));
      process.env.GITHUB_ACTIONS="true";process.env.RUNNER_ENVIRONMENT="github-hosted";
      nativeClaudeBoundary(${JSON.stringify(runtime)},[],{});`,scratch);
    expect(result.code).not.toBe(0);
    expect(result.output).toContain('"reason":"native socket lifetime policy unavailable"');
    expect(result.output).toContain('"nativeLaunched":false');
  } finally { rmSync(scratch,{recursive:true,force:true}); }
});

test("relay paths cannot redirect headers and body to another loopback service", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "odysseus-relay-origin-"));
  let intended = 0, unintended = 0;
  const target = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { intended++; return new Response("Ithaca"); } });
  const other = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { unintended++; return new Response("Unintended"); } });
  try {
    const result = await probe(`${imports}
      import {startNativeTestRelay} from ${JSON.stringify(join(ROOT, "scripts/test-native-guard.ts"))};
      const relay=startNativeTestRelay(${JSON.stringify(target.url.origin)});
      try {
        const denied=await relay.handle(new Request(${JSON.stringify(`http://localhost//127.0.0.1:${other.port}/v1/messages`)},
          {method:"POST",headers:{authorization:"odysseus-fixture"},body:"synthetic"}));
        if(denied.status!==403)throw Error("relay accepted an authority path");
        const allowed=await relay.handle(new Request("http://localhost/v1/messages"));
        if(await allowed.text()!=="Ithaca")throw Error("scripted origin was unavailable");
        console.log("RELAY_AUTHORITY_REFUSED");
      } finally {relay.dispose();} process.exit(0);`, scratch);
    expect(result.code).not.toBe(0);
    expect(result.output).toContain('"reason":"unintended native destination"');
    expect(result.output).not.toContain('"nativeLaunched":true');
    expect(unintended).toBe(0); expect(intended).toBe(1);
  } finally { target.stop(true); other.stop(true); rmSync(scratch, { recursive: true, force: true }); }
});

test("native audit counts raw kernel failures without decoding addresses or payloads", async () => {
  const { deniedNativeConnects } = await import("../scripts/test-native-guard");
  expect(deniedNativeConnects("1 connect(0x3, 0x123, 0x10) = -1 ENETUNREACH (Network is unreachable)\n2 <... connect resumed>) = -1 EACCES (Permission denied)\n3 connect(0x4, 0x456, 0x10) = 0\n4 connect(0x5, 0x789, 0x10) = -1 EINPROGRESS (Operation now in progress)")).toBe(2);
});

test("cleanup cannot claim native exec from an empty or launcher-only trace", async () => {
  const { nativeExecObserved } = await import("../scripts/test-native-guard");
  expect(nativeExecObserved("", ["/synthetic/native"])).toBe(false);
  expect(nativeExecObserved('1 execve("/usr/bin/bwrap", [], 0x1) = 0', ["/synthetic/native"])).toBe(false);
  expect(nativeExecObserved('1 execve("/synthetic/native", [], 0x1) = -1 ENOENT', ["/synthetic/native"])).toBe(false);
  expect(nativeExecObserved('1 execve("/synthetic/native", [], 0x1) = 0', ["/synthetic/native"])).toBe(true);
  const scratch = mkdtempSync(join(tmpdir(), "odysseus-empty-native-audit-"));
  try {
    const result = await probe(`${imports}
      import {auditNativeLaunch} from ${JSON.stringify(join(ROOT, "scripts/test-native-guard.ts"))};
      const audit=auditNativeLaunch(["/usr/bin/true"],["/synthetic/native"],()=>{});
      audit.dispose(); process.exit(0);`, scratch);
    expect(result.code).not.toBe(0);
    expect(result.output).toContain('"nativeLaunched":false,"success":false');
    expect(result.output).toContain("native exec was not observed");
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});

test("wrapper exec and auth inspection cannot fabricate native launch or injected credentials", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "odysseus-wrapper-audit-"));
  try {
    for (const [observed,joined] of [["/usr/bin/unshare",false],[runtime!,false],[runtime!,true]] as const) {
    const result = await probe(`${imports}
      import {writeFileSync} from "node:fs";
      const spawnSync=Bun.spawnSync,which=Bun.which;
      Bun.spawnSync=((argv,options)=>(["bwrap","strace"].includes(argv[0])||argv[0]?.endsWith("/native-connect"))?{exitCode:0,stdout:Buffer.alloc(0),stderr:Buffer.alloc(0)}:Reflect.apply(spawnSync,Bun,[argv,options]));
      Bun.which=((command,options)=>command==="strace"?"/synthetic/strace":which(command,options));
      process.env.GITHUB_ACTIONS="true";process.env.RUNNER_ENVIRONMENT="github-hosted";registerScriptedService("http://127.0.0.1:1");
      const boundary=nativeClaudeBoundary("/usr/bin/unshare",["--user",${JSON.stringify(joined ? "--preload="+runtime : runtime)},"auth","status","--json"],
        {cwd:${JSON.stringify(scratch)},env:{HOME:${JSON.stringify(scratch)},ANTHROPIC_BASE_URL:"http://127.0.0.1:1"}});
      if(boundary.argv[0]!=="/synthetic/strace")throw Error("audit executable was not resolved");
      const broker=boundary.argv.findIndex((arg,i)=>arg.endsWith("/native-connect")&&boundary.argv[i+1]==="--head");
      if(broker<0||!boundary.argv.includes("--device")||!boundary.argv.includes("--inode")||boundary.argv[broker+10]!=="/tmp/native-relay/relay.sock")throw Error("kernel lifetime socket policy was omitted");
      const setup=boundary.argv.slice(0,boundary.argv.lastIndexOf("--"));
      for(let i=0;i<setup.length;i++)if(setup[i]==="--setenv"&&["ANTHROPIC_API_KEY","ANTHROPIC_AUTH_TOKEN","CLAUDE_CODE_OAUTH_TOKEN","ANTHROPIC_BASE_URL","ANTHROPIC_UNIX_SOCKET"].includes(setup[i+1]))throw Error("auth inspection received credential or route overrides");
      writeFileSync(boundary.argv[boundary.argv.indexOf("-o")+1],${JSON.stringify('1 execve('+JSON.stringify(observed)+', [], 0x1) = 0')});
      boundary.dispose();process.exit(0);`, scratch);
    if(observed===runtime) {
      expect(result.code,result.output).toBe(0);
      expect(result.output).toContain('"nativeLaunched":true,"success":true');
    } else {
      expect(result.code).not.toBe(0);
      expect(result.output).toContain('"nativeLaunched":false,"success":false');
      expect(result.output).toContain("native exec was not observed");
    }
    }
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});

test("isolated plans preserve synthetic credential precedence and an unauthenticated row", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "odysseus-auth-plan-"));
  try {
    const result = await probe(`${imports}
      import {writeFileSync} from "node:fs";
      import {nativeWorkerBoundary,nativeScriptedService} from ${JSON.stringify(join(ROOT, "scripts/test-native-guard.ts"))};
      const spawnSync=Bun.spawnSync,which=Bun.which;
      Bun.which=((command,options)=>command==="strace"?"/synthetic/strace":which(command,options));
      Bun.spawnSync=((argv,options)=>(["bwrap","strace"].includes(argv[0])||argv[0]?.endsWith("/native-connect"))?{exitCode:0,stdout:Buffer.alloc(0),stderr:Buffer.alloc(0)}:Reflect.apply(spawnSync,Bun,[argv,options]));
      process.env.GITHUB_ACTIONS="true";process.env.RUNNER_ENVIRONMENT="github-hosted";registerScriptedService("http://127.0.0.1:1");
      const key="sk-ant-api03-"+"k".repeat(95)+"AA",token="sk-ant-oat01-"+"o".repeat(95)+"AA",bearer="sk-ant-declared-"+"t".repeat(60);
      const leave=nativeScriptedService("http://127.0.0.1:1");
      for(const creds of [{},{ANTHROPIC_API_KEY:key},{CLAUDE_CODE_OAUTH_TOKEN:token},{ANTHROPIC_API_KEY:key,CLAUDE_CODE_OAUTH_TOKEN:token},{ANTHROPIC_AUTH_TOKEN:bearer}]){
        const boundary=nativeClaudeBoundary(${JSON.stringify(runtime)},[],{cwd:${JSON.stringify(scratch)},env:{HOME:${JSON.stringify(scratch)},ANTHROPIC_BASE_URL:"http://127.0.0.1:1",ANTHROPIC_UNIX_SOCKET:"",...creds}});
        const injected={};for(let i=0;i<boundary.argv.length;i++)if(boundary.argv[i]==="--setenv")injected[boundary.argv[i+1]]=boundary.argv[i+2];
        if(injected.ANTHROPIC_API_KEY!==creds.ANTHROPIC_API_KEY||injected.CLAUDE_CODE_OAUTH_TOKEN!==creds.CLAUDE_CODE_OAUTH_TOKEN||injected.ANTHROPIC_AUTH_TOKEN!==creds.ANTHROPIC_AUTH_TOKEN)throw Error("synthetic credential row changed");
        writeFileSync(boundary.argv[boundary.argv.indexOf("-o")+1],${JSON.stringify(`1 execve(${JSON.stringify(runtime)}, [], 0x1) = 0`)});boundary.dispose();
        const worker=nativeWorkerBoundary({BRAIN_WORKER_LAUNCH:JSON.stringify({command:[${JSON.stringify(runtime)}],brainPath:${JSON.stringify(scratch)},env:{HOME:${JSON.stringify(scratch)},ANTHROPIC_UNIX_SOCKET:"",...creds},argv:["bwrap","--setenv","ODYSSEUS_OTHER_KEY","synthetic-outside-key","--setenv","LD_PRELOAD","synthetic-loader","--",${JSON.stringify(runtime)}]})});
        const argv=JSON.parse(worker.env.BRAIN_WORKER_LAUNCH).argv,workerEnv={};
        if(argv.includes("synthetic-outside-key")||argv.includes("synthetic-loader"))throw Error("non-runtime worker environment escaped isolation");
        for(let i=0;i<argv.length;i++)if(argv[i]==="--setenv")workerEnv[argv[i+1]]=argv[i+2];
        if(workerEnv.ANTHROPIC_API_KEY!==(creds.ANTHROPIC_API_KEY??"")||workerEnv.CLAUDE_CODE_OAUTH_TOKEN!==(creds.CLAUDE_CODE_OAUTH_TOKEN??"")||workerEnv.ANTHROPIC_AUTH_TOKEN!==(creds.ANTHROPIC_AUTH_TOKEN??""))throw Error("synthetic worker credential row changed");
        writeFileSync(argv[argv.indexOf("-o")+1],${JSON.stringify(`1 execve(${JSON.stringify(runtime)}, [], 0x1) = 0`)});worker.dispose();
      }leave();`, scratch);
    expect(result.code, result.output).toBe(0);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}, watchdogMs(120_000));

test("fixture PATH tools are mounted selectively without exposing sibling credentials", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "odysseus-tool-plan-"));
  const unrelated = mkdtempSync(join(tmpdir(), "odysseus-unrelated-tools-"));
  const home = join(scratch, "home"), brain = join(scratch, "brain"), bin = join(scratch, "bin");
  for (const path of [home, brain, bin]) mkdirSync(path);
  writeFileSync(join(scratch, "outside-credential"), "odysseus-synthetic-credential");
  try {
    const result = await probe(`${imports}
      import {writeFileSync} from "node:fs";
      import {nativeWorkerBoundary,nativeScriptedService} from ${JSON.stringify(join(ROOT, "scripts/test-native-guard.ts"))};
      const spawnSync=Bun.spawnSync,which=Bun.which;
      Bun.which=((command,options)=>command==="strace"?"/synthetic/strace":which(command,options));
      Bun.spawnSync=((argv,options)=>(["bwrap","strace"].includes(argv[0])||argv[0]?.endsWith("/native-connect"))?{exitCode:0,stdout:Buffer.alloc(0),stderr:Buffer.alloc(0)}:Reflect.apply(spawnSync,Bun,[argv,options]));
      process.env.GITHUB_ACTIONS="true";process.env.RUNNER_ENVIRONMENT="github-hosted";registerScriptedService("http://127.0.0.1:1");
      nativeScriptedService("http://127.0.0.1:1");
      const env={HOME:${JSON.stringify(home)},PATH:${JSON.stringify([bin, scratch, unrelated, "/usr/bin"].join(":"))},USE_BUILTIN_RIPGREP:"0",ENABLE_TOOL_SEARCH:"true",ANTHROPIC_BASE_URL:"http://127.0.0.1:1"};
      const direct=nativeClaudeBoundary(${JSON.stringify(runtime)},[],{cwd:${JSON.stringify(brain)},env});
      const worker=nativeWorkerBoundary({BRAIN_WORKER_LAUNCH:JSON.stringify({command:[${JSON.stringify(runtime)}],brainPath:${JSON.stringify(brain)},hostHome:${JSON.stringify(home)},env,argv:["bwrap","--setenv","ENABLE_TOOL_SEARCH","true","--",${JSON.stringify(runtime)}]})});
      for(const [argv,dispose] of [[direct.argv,()=>direct.dispose()],[JSON.parse(worker.env.BRAIN_WORKER_LAUNCH).argv,()=>worker.dispose()]]){
        const entries={};for(let i=0;i<argv.length;i++)if(argv[i]==="--setenv")entries[argv[i+1]]=argv[i+2];
        if(entries.PATH.split(":")[0]!==${JSON.stringify(bin)}||entries.USE_BUILTIN_RIPGREP!=="0"||entries.ENABLE_TOOL_SEARCH!=="true")throw Error("fixture tool environment was lost");
        if(!argv.some((arg,i)=>arg==="--ro-bind"&&argv[i+1]===${JSON.stringify(bin)}&&argv[i+2]===${JSON.stringify(bin)}))throw Error("fixture tool mount was lost");
        if(argv.some((arg,i)=>["--bind","--ro-bind"].includes(arg)&&[${JSON.stringify(scratch)},${JSON.stringify(unrelated)}].includes(argv[i+1])))throw Error("fixture ancestor or unrelated tool storage was exposed");
        writeFileSync(argv[argv.indexOf("-o")+1],${JSON.stringify(`1 execve(${JSON.stringify(runtime)}, [], 0x1) = 0`)});dispose();
      }`, scratch);
    expect(result.code, result.output).toBe(0);
  } finally { rmSync(scratch, { recursive: true, force: true }); rmSync(unrelated, { recursive: true, force: true }); }
});

test("guard worker binds follow every covering mount", async()=>{
 const scratch=mkdtempSync(join(tmpdir(),"odysseus-mount-order-"));
 try {
  const result=await probe(`${imports}
   import {nativeWorkerBoundary} from ${JSON.stringify(join(ROOT,"scripts/test-native-guard.ts"))};import {writeFileSync} from "node:fs";
   ${guardMountOrderCheck}
   const spawnSync=Bun.spawnSync,which=Bun.which;
   Bun.which=((command,options)=>command==="strace"?"/synthetic/strace":which(command,options));
   Bun.spawnSync=((argv,options)=>(["bwrap","strace"].includes(argv[0])||argv[0]?.endsWith("/native-connect"))?{exitCode:0,stdout:Buffer.alloc(0),stderr:Buffer.alloc(0)}:Reflect.apply(spawnSync,Bun,[argv,options]));
   process.env.GITHUB_ACTIONS="true";process.env.RUNNER_ENVIRONMENT="github-hosted";registerScriptedService("http://127.0.0.1:1");
   const plan=nativeWorkerBoundary({BRAIN_WORKER_LAUNCH:JSON.stringify({command:[${JSON.stringify(runtime)}],brainPath:${JSON.stringify(scratch)},env:{HOME:${JSON.stringify(scratch)},PATH:"/usr/local/bin:/usr/bin:/bin"},argv:["bwrap",...${JSON.stringify(["/tmp","/home","/etc",ROOT])}.flatMap(path=>["--tmpfs",path]),"--remount-ro","/","--remount-ro","/etc","--",process.execPath,${JSON.stringify(join(ROOT,"packages/ui-sdk/src/server/egress-worker-entry.ts"))},"--direct-loopback",${JSON.stringify(runtime)}]})});
   const argv=JSON.parse(plan.env.BRAIN_WORKER_LAUNCH).argv,bwrap=argv.indexOf("--",argv.indexOf("-o"))+1,split=argv.indexOf("--",bwrap);
   const mounts=argv.slice(bwrap+1,split);assertGuardMountOrder(mounts,["/","/etc"]);
   if(!mounts.some((arg,i)=>arg==="--setenv"&&mounts[i+1]==="PATH"&&mounts[i+2]==="/usr/local/bin:/usr/bin:/bin"))throw Error("GUARD_PLAN_PRESERVES_READONLY_SYSTEM_PATH");
   const payload=argv.slice(split+1);if(payload[1]!==${JSON.stringify(join(ROOT,"packages/ui-sdk/src/server/egress-worker-entry.ts"))}||payload[2]!=="--direct-loopback"||!payload[3]?.endsWith("/native-connect"))throw Error("PRODUCTION_TRANSPORT_OUTSIDE_PAYLOAD_FILTER");
   if(!mounts.some((arg,i)=>arg==="--ro-bind"&&mounts[i+1]?.endsWith("/native-connect"))||!mounts.includes("/tmp/native-relay"))throw Error("guard input missing from plan");
   plan.beforeLaunch();writeFileSync(argv[argv.indexOf("-o")+1],${JSON.stringify(`1 execve(${JSON.stringify(runtime)}, [], 0x1) = 0`)});plan.dispose();`,scratch);
  expect(result.code,result.output).toBe(0);
  const receipt=JSON.parse(result.output.split("\n").find(line=>line.startsWith('{"kind":"native-offline-worker-plan"'))!);
  expect(Object.keys(receipt).sort()).toEqual(["kind","head","bootstrapArgc","bootstrapArgvBytes","sandboxArgc","sandboxArgvBytes","metadataBytes"].sort());
  for(const [key,value] of Object.entries(receipt))if(key!=="kind"&&key!=="head")expect(typeof value==="number"&&Number.isSafeInteger(value)&&value>0).toBe(true);
  expect(JSON.stringify(receipt)).not.toContain(runtime!);
 }finally{rmSync(scratch,{recursive:true,force:true});}
});

test("separate-UID plans trace the broker payload outside its hidden native audit view", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "odysseus-identity-plan-"));
  try {
    const result = await probe(`${imports}
      import {writeFileSync,realpathSync} from "node:fs";
      import {dirname} from "node:path";
      import {nativeWorkerBoundary,nativeScriptedService} from ${JSON.stringify(join(ROOT, "scripts/test-native-guard.ts"))};
      import {WORKER_IDENTITY_SUPERVISOR} from ${JSON.stringify(join(ROOT, "packages/ui-sdk/src/server/worker-identity-program.ts"))};
      import {spyOn} from "bun:test";
      import * as launcher from ${JSON.stringify(join(ROOT, "packages/ui-sdk/src/server/worker-launcher.ts"))};
      spyOn(launcher,"verifiedWorkerIdentity").mockReturnValue({identity:"separate_uid",workerUid:(process.getuid()||21000)+1});
      ${guardMountOrderCheck}
      const spawnSync=Bun.spawnSync,which=Bun.which;
      Bun.which=((command,options)=>command==="strace"?"/synthetic/strace":which(command,options));
      Bun.spawnSync=((argv,options)=>(["bwrap","strace"].includes(argv[0])||argv[0]?.endsWith("/native-connect"))?{exitCode:0,stdout:Buffer.alloc(0),stderr:Buffer.alloc(0)}:Reflect.apply(spawnSync,Bun,[argv,options]));
      process.env.GITHUB_ACTIONS="true";process.env.RUNNER_ENVIRONMENT="github-hosted";registerScriptedService("http://127.0.0.1:1");
      const leave=nativeScriptedService("http://127.0.0.1:1");
      const launch={command:[${JSON.stringify(runtime)}],brainPath:${JSON.stringify(scratch)},env:{HOME:${JSON.stringify(scratch)},ANTHROPIC_API_KEY:"offline-fixture"},
        argv:["/usr/bin/python3","-I","-S","-c",WORKER_IDENTITY_SUPERVISOR,JSON.stringify({argv:["bwrap","--ro-bind","/","/",...${JSON.stringify(["/tmp","/home","/etc",ROOT])}.flatMap(path=>["--tmpfs",path]),"--remount-ro","/","--remount-ro","/etc","--",${JSON.stringify(runtime)}],secret:"synthetic"})]};
      const worker=nativeWorkerBoundary({BRAIN_WORKER_LAUNCH:JSON.stringify(launch)});
      const outer=JSON.parse(worker.env.BRAIN_WORKER_LAUNCH).argv;
      if(realpathSync(outer[0])!==realpathSync("/usr/bin/python3"))throw Error("tracer wrapped the coordinator instead of the payload");
      const config=JSON.parse(outer[5]),args=config.argv,split=args.indexOf("--"),trace=args.slice(split+1);
      if(trace[0]!=="/synthetic/strace")throw Error("native broker payload was not traced");
      const log=trace[trace.indexOf("-o")+1],directory=dirname(log);
      assertGuardMountOrder(args.slice(1,split),["/","/etc"]);
      if(!args.slice(0,split).some((arg,i)=>arg==="--bind"&&args[i+1]===directory&&args[i+2]===directory))throw Error("guard trace directory bind missing");
      const inner=trace.slice(trace.indexOf("--")+1);
      if(!inner.some((arg,i)=>arg==="--tmpfs"&&inner[i+1]===directory)||!inner.includes("--unshare-pid")||!inner.includes("--unshare-net"))throw Error("native child can see audit storage or tracer PID");
      if(args.slice(0,split).some((arg,i)=>arg==="--ro-bind"&&args[i+1]==="/"))throw Error("host root remained mounted");
      if(config.secret!=="synthetic")throw Error("identity authority changed");
      writeFileSync(log,${JSON.stringify(`1 execve(${JSON.stringify(runtime)}, [], 0x1) = 0`)});worker.dispose();leave();`, scratch);
    expect(result.code, result.output).toBe(0);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});

test("the SDK spawn hook retains its scripted authority when invoked from another async scope", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "odysseus-sdk-scope-"));
  const intended = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { return new Response("Ithaca"); } });
  const other = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { return new Response("Cyclops"); } });
  try {
    const result = await probe(`${imports}
      import {writeFileSync} from "node:fs";
      import {nativeScriptedQuery,nativeScriptedService,nativeWorkerBoundary} from ${JSON.stringify(join(ROOT, "scripts/test-native-guard.ts"))};
      const spawnSync=Bun.spawnSync,which=Bun.which;
      Bun.which=((command,options)=>command==="strace"?"/synthetic/strace":which(command,options));
      Bun.spawnSync=((argv,options)=>(["bwrap","strace"].includes(argv[0])||argv[0]?.endsWith("/native-connect"))?{exitCode:0,stdout:Buffer.alloc(0),stderr:Buffer.alloc(0)}:Reflect.apply(spawnSync,Bun,[argv,options]));
      process.env.GITHUB_ACTIONS="true";process.env.RUNNER_ENVIRONMENT="github-hosted";registerScriptedService("http://127.0.0.1:1");
      let hook,worker;
      const query=nativeScriptedQuery(input=>{hook=input.options.spawnClaudeCodeProcess;return {};},${JSON.stringify(intended.url.origin)});
      query({prompt:"fixture",options:{spawnClaudeCodeProcess(){worker=nativeWorkerBoundary({BRAIN_WORKER_LAUNCH:JSON.stringify({command:[${JSON.stringify(runtime)}],env:{HOME:${JSON.stringify(scratch)}},brainPath:${JSON.stringify(scratch)},argv:["bwrap","--",${JSON.stringify(runtime)}]})});return {};}}});
      const leave=nativeScriptedService(${JSON.stringify(other.url.origin)});hook({});leave();
      const argv=JSON.parse(worker.env.BRAIN_WORKER_LAUNCH).argv;
      const mount=argv.indexOf("/tmp/native-relay"),directory=argv[mount-1];
      const reply=await fetch("http://localhost/v1/messages",{unix:directory+"/relay.sock"});
      if(await reply.text()!=="Ithaca")throw Error("SDK spawn lost its scripted authority");
      writeFileSync(argv[argv.indexOf("-o")+1],${JSON.stringify(`1 execve(${JSON.stringify(runtime)}, [], 0x1) = 0`)});worker.dispose();`, scratch);
    expect(result.code, result.output).toBe(0);
  } finally { intended.stop(true); other.stop(true); rmSync(scratch, { recursive: true, force: true }); }
});

test("fixture server callbacks retain authority while creating a native relay", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "odysseus-server-authority-"));
  try {
    const result = await probe(`${imports}
      import {writeFileSync} from "node:fs";
      import {nativeScriptedService,nativeWorkerBoundary} from ${JSON.stringify(join(ROOT, "scripts/test-native-guard.ts"))};
      const spawnSync=Bun.spawnSync,which=Bun.which;
      Bun.which=((command,options)=>command==="strace"?"/synthetic/strace":which(command,options));
      Bun.spawnSync=((argv,options)=>(["bwrap","strace"].includes(argv[0])||argv[0]?.endsWith("/native-connect"))?{exitCode:0,stdout:Buffer.alloc(0),stderr:Buffer.alloc(0)}:Reflect.apply(spawnSync,Bun,[argv,options]));
      process.env.GITHUB_ACTIONS="true";process.env.RUNNER_ENVIRONMENT="github-hosted";registerScriptedService("http://127.0.0.1:1");
      const leave=nativeScriptedService("http://127.0.0.1:1");let relay;
      const app=Bun.serve({hostname:"127.0.0.1",port:0,fetch(){
        relay=Bun.serve({unix:${JSON.stringify(join(scratch, "relay.sock"))},fetch(){return new Response("Ithaca");}});
        const worker=nativeWorkerBoundary({BRAIN_WORKER_LAUNCH:JSON.stringify({command:[${JSON.stringify(runtime)}],
          env:{ANTHROPIC_UNIX_SOCKET:"/tmp/relay/relay.sock"},argv:["bwrap","--ro-bind",${JSON.stringify(scratch)},"/tmp/relay","--",${JSON.stringify(runtime)}]})});
        const argv=JSON.parse(worker.env.BRAIN_WORKER_LAUNCH).argv;
        writeFileSync(argv[argv.indexOf("-o")+1],${JSON.stringify(`1 execve(${JSON.stringify(runtime)}, [], 0x1) = 0`)});worker.dispose();return new Response("scoped");
      }});leave();
      try{const response=await fetch(app.url);if(await response.text()!=="scoped")throw Error("server callback lost native authority");}
      finally{app.stop(true);relay?.stop(true);}`, scratch);
    expect(result.code, result.output).toBe(0);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});

test("the installed spawn interceptor receives fixture authority before a synthetic bootstrap", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "odysseus-spawn-authority-"));
  try {
    const bootstrap = `import {writeFileSync} from "node:fs";const launch=JSON.parse(process.env.BRAIN_WORKER_LAUNCH!);const args=launch.argv;writeFileSync(args[args.indexOf("-o")+1],${JSON.stringify(`1 execve(${JSON.stringify(runtime)}, [], 0x1) = 0`)});`;
    const result = await probe(`${imports}
      import {nativeScriptedService} from ${JSON.stringify(join(ROOT, "scripts/test-native-guard.ts"))};
      const spawnSync=Bun.spawnSync,which=Bun.which;
      Bun.which=((command,options)=>command==="strace"?"/synthetic/strace":which(command,options));
      Bun.spawnSync=((argv,options)=>(["bwrap","strace"].includes(argv[0])||argv[0]?.endsWith("/native-connect"))?{exitCode:0,stdout:Buffer.alloc(0),stderr:Buffer.alloc(0)}:Reflect.apply(spawnSync,Bun,[argv,options]));
      process.env.GITHUB_ACTIONS="true";process.env.RUNNER_ENVIRONMENT="github-hosted";registerScriptedService("http://127.0.0.1:1");
      nativeScriptedService("http://127.0.0.1:1");
      const child=Bun.spawn([process.execPath,"-e",${JSON.stringify(bootstrap)}],{env:{HOME:${JSON.stringify(scratch)},BRAIN_WORKER_LAUNCH:JSON.stringify({command:[${JSON.stringify(runtime)}],env:{HOME:${JSON.stringify(scratch)}},brainPath:${JSON.stringify(scratch)},argv:["bwrap","--",${JSON.stringify(runtime)}]})},stdout:"pipe",stderr:"pipe"});
      const [code,err]=await Promise.all([child.exited,new Response(child.stderr).text()]);if(code!==0)throw Error(err);`, scratch);
    expect(result.code, result.output).toBe(0);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});

test("qualification metadata preserves explicit child environment overrides", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "odysseus-child-context-"));
  try {
    const result = await probe(`${imports}
      process.env.GITHUB_ACTIONS="true";process.env.RUNNER_ENVIRONMENT="github-hosted";registerScriptedService("http://127.0.0.1:1");
      const child=Bun.spawn([process.execPath,"-e",'console.error(JSON.stringify({actions:process.env.GITHUB_ACTIONS,runner:process.env.RUNNER_ENVIRONMENT,head:process.env.BRAIN_NATIVE_TEST_HEAD}))'],
        {env:{PATH:"/usr/bin:/bin",GITHUB_ACTIONS:"false",RUNNER_ENVIRONMENT:"fixture"},stdout:"pipe",stderr:"pipe"});
      const [code,err]=await Promise.all([child.exited,new Response(child.stderr).text()]);
      const context=JSON.parse(err.trim());
      if(code!==0||context.actions!=="false"||context.runner!=="fixture"||!/^[0-9a-f]{40}$/.test(context.head))throw Error("explicit child context was overwritten");`, scratch);
    expect(result.code, result.output).toBe(0);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});

test("a hard-link alias retains live guard-owned socket authority and loses it when the server stops", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "odysseus-relay-alias-"));
  try {
    const result = await probe(`${imports}
      import {writeFileSync,linkSync} from "node:fs";
      import {nativeScriptedService,nativeWorkerBoundary} from ${JSON.stringify(join(ROOT, "scripts/test-native-guard.ts"))};
      const spawnSync=Bun.spawnSync,which=Bun.which;
      Bun.which=((command,options)=>command==="strace"?"/synthetic/strace":which(command,options));
      Bun.spawnSync=((argv,options)=>(["bwrap","strace"].includes(argv[0])||argv[0]?.endsWith("/native-connect"))?{exitCode:0,stdout:Buffer.alloc(0),stderr:Buffer.alloc(0)}:Reflect.apply(spawnSync,Bun,[argv,options]));
      process.env.GITHUB_ACTIONS="true";process.env.RUNNER_ENVIRONMENT="github-hosted";registerScriptedService("http://127.0.0.1:1");
      nativeScriptedService("http://127.0.0.1:1");
      const source=${JSON.stringify(join(scratch, "source.sock"))},alias=${JSON.stringify(join(scratch, "alias.sock"))};
      const relay=Bun.serve({unix:source,fetch(){return new Response("Ithaca");}});linkSync(source,alias);
      const launch={BRAIN_WORKER_LAUNCH:JSON.stringify({command:[${JSON.stringify(runtime)}],env:{ANTHROPIC_UNIX_SOCKET:"/tmp/relay.sock"},argv:["bwrap","--ro-bind",alias,"/tmp/relay.sock","--",${JSON.stringify(runtime)}]})};
      const worker=nativeWorkerBoundary(launch),argv=JSON.parse(worker.env.BRAIN_WORKER_LAUNCH).argv;
      writeFileSync(argv[argv.indexOf("-o")+1],${JSON.stringify(`1 execve(${JSON.stringify(runtime)}, [], 0x1) = 0`)});worker.dispose();console.error("SCRIPTED_ALIAS_ADMITTED");
      relay.stop(true);
      const unexpected=nativeWorkerBoundary(launch),stoppedArgs=JSON.parse(unexpected.env.BRAIN_WORKER_LAUNCH).argv;
      writeFileSync(stoppedArgs[stoppedArgs.indexOf("-o")+1],${JSON.stringify(`1 execve(${JSON.stringify(runtime)}, [], 0x1) = 0`)});unexpected.dispose();console.error("STOPPED_ALIAS_ADMITTED");`, scratch);
    expect(result.code).not.toBe(0);
    expect(result.output).toContain("SCRIPTED_ALIAS_ADMITTED");
    expect(result.output).toContain('"reason":"pre-existing native relay is not guard-owned"');
    expect(result.output).not.toContain("STOPPED_ALIAS_ADMITTED");
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});

test("a Node relay loses hard-link authority as soon as close starts", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "odysseus-node-alias-"));
  try {
    const result = await probe(`${imports}
      import {linkSync} from "node:fs";import {createServer} from "node:http";
      import {nativeScriptedService,nativeWorkerBoundary} from ${JSON.stringify(join(ROOT, "scripts/test-native-guard.ts"))};
      nativeScriptedService("http://127.0.0.1:1");
      const source=${JSON.stringify(join(scratch, "source.sock"))},alias=${JSON.stringify(join(scratch, "alias.sock"))};
      const relay=createServer((req,res)=>res.end("Ithaca"));await new Promise(resolve=>relay.listen(source,resolve));linkSync(source,alias);
      relay.close();nativeWorkerBoundary({BRAIN_WORKER_LAUNCH:JSON.stringify({command:[${JSON.stringify(runtime)}],env:{ANTHROPIC_UNIX_SOCKET:"/tmp/relay.sock"},argv:["bwrap","--ro-bind",alias,"/tmp/relay.sock","--",${JSON.stringify(runtime)}]})});`, scratch);
    expect(result.code).not.toBe(0);
    expect(result.output).toContain('"reason":"pre-existing native relay is not guard-owned"');
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});

test("an arbitrary same-user Unix relay is refused before namespace setup", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "odysseus-unowned-relay-"));
  const socket = join(scratch, "relay.sock");
  const service = Bun.serve({ unix: socket, fetch() { return new Response("Unowned"); } });
  try {
    const result = await probe(`${imports}
      registerScriptedService("http://127.0.0.1:1");
      import {nativeWorkerBoundary} from ${JSON.stringify(join(ROOT, "scripts/test-native-guard.ts"))};
      nativeWorkerBoundary({BRAIN_WORKER_LAUNCH:JSON.stringify({command:[${JSON.stringify(runtime)}],
        env:{ANTHROPIC_BASE_URL:"http://localhost",ANTHROPIC_UNIX_SOCKET:"/tmp/relay/relay.sock"},
        argv:["bwrap","--unshare-net","--ro-bind",${JSON.stringify(scratch)},"/tmp/relay","--",${JSON.stringify(runtime)}]})});`, scratch);
    expect(result.code).not.toBe(0);
    expect(result.output).toContain('"reason":"pre-existing native relay is not guard-owned"');
    expect(result.output).toContain('"nativeLaunched":false');
  } finally { service.stop(true); rmSync(scratch, { recursive: true, force: true }); }
});

test("a guard-created relay from another scripted scope is not transferable", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "odysseus-relay-authority-"));
  try {
    const result = await probe(`${imports}
      import {nativeScriptedService,nativeWorkerBoundary} from ${JSON.stringify(join(ROOT, "scripts/test-native-guard.ts"))};
      const leave=nativeScriptedService("http://127.0.0.1:1");
      const socket=${JSON.stringify(join(scratch, "relay.sock"))};
      const relay=Bun.serve({unix:socket,fetch(){return new Response("owned");}});leave();
      const restore=nativeScriptedService("http://127.0.0.1:2");
      try{nativeWorkerBoundary({BRAIN_WORKER_LAUNCH:JSON.stringify({command:[${JSON.stringify(runtime)}],
        env:{ANTHROPIC_BASE_URL:"http://localhost",ANTHROPIC_UNIX_SOCKET:"/tmp/relay/relay.sock"},
        argv:["bwrap","--unshare-net","--ro-bind",${JSON.stringify(scratch)},"/tmp/relay","--",${JSON.stringify(runtime)}]})});}
      finally{restore();relay.stop(true);}`, scratch);
    expect(result.code).not.toBe(0);
    expect(result.output).toContain('"reason":"native relay did not match scripted authority"');
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});

test("guard-created relay handlers cannot switch their pinned scripted destination", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "odysseus-owned-relay-"));
  let unintended = 0;
  const target = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { return new Response("Ithaca"); } });
  const other = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { unintended++; return new Response("Unintended"); } });
  try {
    const result = await probe(`${imports}
      import {nativeScriptedService} from ${JSON.stringify(join(ROOT, "scripts/test-native-guard.ts"))};
      const restore=nativeScriptedService(${JSON.stringify(target.url.origin)});
      const socket=${JSON.stringify(join(scratch, "relay.sock"))};
      const relay=Bun.serve({unix:socket,async fetch(){return fetch(${JSON.stringify(other.url.origin)});}});
      restore();
      try {await fetch("http://localhost/v1/messages",{unix:socket});} finally {relay.stop(true);} process.exit(0);`, scratch);
    expect(result.code).not.toBe(0);
    expect(result.output).toContain('"reason":"unintended relay destination"');
    expect(unintended).toBe(0);
  } finally { target.stop(true); other.stop(true); rmSync(scratch, { recursive: true, force: true }); }
});

test("guard-owned Node HTTP relays pin their TCP transports too", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "odysseus-node-relay-"));
  let unintended = 0;
  const target = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { return new Response("Ithaca"); } });
  const other = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { unintended++; return new Response("Unintended"); } });
  try {
    const result = await probe(`${imports}
      import {createServer,request} from "node:http";
      import {nativeScriptedService} from ${JSON.stringify(join(ROOT, "scripts/test-native-guard.ts"))};
      const restore=nativeScriptedService(${JSON.stringify(target.url.origin)});
      const relay=createServer((incoming,response)=>{try{
        const upstream=request(${JSON.stringify(other.url.origin)},reply=>{response.writeHead(reply.statusCode);reply.pipe(response);});
        upstream.on("error",()=>{response.writeHead(403);response.end("Denied");});upstream.end();
      }catch{response.writeHead(403);response.end("Denied");}});
      const socket=${JSON.stringify(join(scratch, "relay.sock"))};
      await new Promise(resolve=>relay.listen(socket,resolve));restore();
      const reply=await fetch("http://localhost/v1/messages",{unix:socket});await reply.text();
      relay.closeAllConnections();await new Promise(resolve=>relay.close(resolve));process.exit(0);`, scratch);
    expect(result.code).not.toBe(0);
    expect(result.output).toContain('"reason":"unintended relay destination"');
    expect(unintended).toBe(0);
  } finally { target.stop(true); other.stop(true); rmSync(scratch, { recursive: true, force: true }); }
});

test("workspace SDK discovery works without root resolution and fails closed for a missing owner SDK", async () => {
  const { createRequire } = await import("node:module");
  const sdk = createRequire(import.meta.url).resolve("@anthropic-ai/claude-agent-sdk");
  const scratch = mkdtempSync(join(tmpdir(), "odysseus-workspace-sdk-"));
  try {
    mkdirSync(join(scratch, "scripts"));
    mkdirSync(join(scratch, "packages/native/node_modules/@anthropic-ai"), { recursive: true });
    writeFileSync(join(scratch, "package.json"), JSON.stringify({ private: true }));
    writeFileSync(join(scratch, "packages/native/package.json"), JSON.stringify({ name: "odysseus-native", dependencies: { "@anthropic-ai/claude-agent-sdk": "*" } }));
    copyFileSync(join(ROOT, "scripts/test-native-guard.ts"), join(scratch, "scripts/test-native-guard.ts"));
    copyFileSync(join(ROOT,"scripts/native-test-receipts.ts"),join(scratch,"scripts/native-test-receipts.ts"));
    const link = join(scratch, "packages/native/node_modules/@anthropic-ai/claude-agent-sdk");
    symlinkSync(dirname(sdk), link);
    const module = join(scratch, "scripts/test-native-guard.ts");
    const available = await probe(`import {isNativeClaude} from ${JSON.stringify(module)};
      if(!isNativeClaude(${JSON.stringify(runtime)}))throw Error("workspace native SDK was missed");`, scratch);
    expect(available.code, available.output).toBe(0);
    rmSync(link);
    const missing = await probe(`import {isNativeClaude} from ${JSON.stringify(module)};
      const spawnSync=Bun.spawnSync;Bun.spawnSync=((argv,options)=>{isNativeClaude(argv[0]);return Reflect.apply(spawnSync,Bun,[argv,options]);});
      isNativeClaude("/usr/bin/true");`, scratch);
    expect(missing.code).not.toBe(0);
    expect(missing.output).toContain('"reason":"installed SDK runtime discovery failed"');
    expect(missing.output).toContain('"nativeLaunched":false');
    expect(missing.output.match(/"kind":"native-offline-boundary"/g)).toHaveLength(1);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});

test("environment endpoints cannot supply missing scripted authority", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "odysseus-no-authority-"));
  try {
    for (const worker of [false, true]) {
      const result = await probe(`${imports}
        import {nativeWorkerBoundary} from ${JSON.stringify(join(ROOT, "scripts/test-native-guard.ts"))};
        const original=Bun.spawnSync;const which=Bun.which;
        Bun.which=((name,options)=>name==="strace"?"/synthetic/strace":which(name,options));
        Bun.spawnSync=((argv,options)=>(["bwrap","strace"].includes(argv[0])||argv[0]?.endsWith("/native-connect"))?{exitCode:0,stdout:Buffer.alloc(0),stderr:Buffer.alloc(0)}:Reflect.apply(original,Bun,[argv,options]));
        process.env.GITHUB_ACTIONS="true";process.env.RUNNER_ENVIRONMENT="github-hosted";
        const env={HOME:${JSON.stringify(scratch)},ANTHROPIC_BASE_URL:"http://127.0.0.1:1"};
        ${worker ? `nativeWorkerBoundary({BRAIN_WORKER_LAUNCH:JSON.stringify({command:[${JSON.stringify(runtime)}],env,argv:["bwrap","--",${JSON.stringify(runtime)}]})}).dispose();` : `nativeClaudeBoundary(${JSON.stringify(runtime)},[],{env}).dispose();`}`, scratch);
      expect(result.code).not.toBe(0);
      expect(result.output).toContain('"reason":"scripted service authority was not registered"');
    }
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});

test("worker relay directory rejects nested unregistered sockets", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "odysseus-nested-relay-"));
  try {
    const result = await probe(`${imports}
      import {mkdirSync} from "node:fs";
      import {nativeWorkerBoundary} from ${JSON.stringify(join(ROOT, "scripts/test-native-guard.ts"))};
      mkdirSync(${JSON.stringify(join(scratch, "nested"))});
      const foreign=Bun.serve({unix:${JSON.stringify(join(scratch, "nested/foreign.sock"))},fetch:()=>new Response("foreign")});
      registerScriptedService("http://127.0.0.1:1");
      const owned=Bun.serve({unix:${JSON.stringify(join(scratch, "relay.sock"))},fetch:()=>new Response("Ithaca")});
      try{nativeWorkerBoundary({BRAIN_WORKER_LAUNCH:JSON.stringify({command:[${JSON.stringify(runtime)}],env:{ANTHROPIC_UNIX_SOCKET:"/tmp/relay/relay.sock"},argv:["bwrap","--ro-bind",${JSON.stringify(scratch)},"/tmp/relay","--",${JSON.stringify(runtime)}]})});}finally{foreign.stop(true);owned.stop(true);}`, scratch);
    expect(result.code).not.toBe(0);
    expect(result.output).toContain('"reason":"pre-existing native relay is not guard-owned"');
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});

test("registered same-origin Unix relays forward successfully", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "odysseus-unix-forward-"));
  try {
    const result = await probe(`${imports}
      registerScriptedService("http://127.0.0.1:1");
      const downstream=${JSON.stringify(join(scratch, "down.sock"))},upstream=${JSON.stringify(join(scratch, "up.sock"))};
      const down=Bun.serve({unix:downstream,fetch:()=>new Response("Ithaca")});
      const up=Bun.serve({unix:upstream,fetch:()=>fetch("http://127.0.0.1:1/v1/messages",{unix:downstream})});
      try{const response=await fetch("http://127.0.0.1:1/v1/messages",{unix:upstream});if(await response.text()!=="Ithaca")throw Error("registered forwarding failed");}finally{up.stop(true);down.stop(true);}`, scratch);
    expect(result.code, result.output).toBe(0);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});

test("all direct bind sources reject unowned sockets, including PATH, managed settings and late additions", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "odysseus-mounted-socket-"));
  try {
    for (const mode of ["home", "cwd", "late", "path", "managed"]) {
      const result = await probe(`${imports}
        import {mkdirSync,writeFileSync} from "node:fs";
        const spawnSync=Bun.spawnSync,which=Bun.which;
        Bun.which=((command,options)=>command==="strace"?"/synthetic/strace":which(command,options));
        Bun.spawnSync=((argv,options)=>(["bwrap","strace"].includes(argv[0])||argv[0]?.endsWith("/native-connect"))?{exitCode:0,stdout:Buffer.alloc(0),stderr:Buffer.alloc(0)}:Reflect.apply(spawnSync,Bun,[argv,options]));
        process.env.GITHUB_ACTIONS="true";process.env.RUNNER_ENVIRONMENT="github-hosted";
        const home=${JSON.stringify(join(scratch, "home"))},cwd=${JSON.stringify(join(scratch, "brain"))};
        mkdirSync(home,{recursive:true});mkdirSync(cwd,{recursive:true});
        const bin=${JSON.stringify(join(scratch, "bin"))},managed=${JSON.stringify(join(scratch,"managed"))};
        mkdirSync(bin,{recursive:true});mkdirSync(managed,{recursive:true});
        const socket=(${JSON.stringify(mode)}==="cwd"?cwd:${JSON.stringify(mode)}==="path"?bin:${JSON.stringify(mode)}==="managed"?managed:home)+"/foreign.sock";
        let foreign,plan;
        if(${JSON.stringify(mode)}!=="late")foreign=Bun.serve({unix:socket,fetch:()=>new Response("foreign")});
        const leave=registerScriptedService("http://127.0.0.1:1");
        try{plan=nativeClaudeBoundary(${JSON.stringify(runtime)},[],{cwd,env:{HOME:home,PATH:bin},managedSettings:managed});
          if(${JSON.stringify(mode)}==="late"){leave();foreign=Bun.serve({unix:socket,fetch:()=>new Response("late")});}
          plan.beforeLaunch();
        }finally{foreign?.stop(true);if(plan){writeFileSync(plan.argv[plan.argv.indexOf("-o")+1],${JSON.stringify(`1 execve(${JSON.stringify(runtime)}, [], 0x1) = 0`)});plan.dispose();}}`, scratch);
      expect(result.code).not.toBe(0);
      expect(result.output).toContain('"reason":"fixture storage contains an unowned Unix socket or directory alias"');
      const receipt=JSON.parse(result.output.split("\n").find(line=>line.startsWith('{"kind":"native-offline-boundary"'))!);
      expect(receipt.mountEvidence.refusedSocket.relativePath).toBe("foreign.sock");
      expect(receipt.mountEvidence.refusedSocket.device).toMatch(/^\d+$/);
      expect(receipt.mountEvidence.refusedSocket.inode).toMatch(/^\d+$/);
      expect(receipt.mountEvidence.ownedSockets.length).toBeGreaterThan(0);
      expect(JSON.stringify(receipt.mountEvidence)).not.toContain(scratch);
    }
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});

test("worker device-bind sources cannot expose an unregistered Unix socket", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "odysseus-device-bind-"));
  try {
    const result = await probe(`${imports}
      import {nativeWorkerBoundary} from ${JSON.stringify(join(ROOT, "scripts/test-native-guard.ts"))};
      import {writeFileSync} from "node:fs";
      const spawnSync=Bun.spawnSync,which=Bun.which;
      Bun.which=((command,options)=>command==="strace"?"/synthetic/strace":which(command,options));
      Bun.spawnSync=((argv,options)=>(["bwrap","strace"].includes(argv[0])||argv[0]?.endsWith("/native-connect"))?{exitCode:0,stdout:Buffer.alloc(0),stderr:Buffer.alloc(0)}:Reflect.apply(spawnSync,Bun,[argv,options]));
      process.env.GITHUB_ACTIONS="true";process.env.RUNNER_ENVIRONMENT="github-hosted";
      const socket=${JSON.stringify(join(scratch,"foreign.sock"))};
      const server=Bun.serve({unix:socket,fetch:()=>new Response("foreign")});
      registerScriptedService("http://127.0.0.1:1");
      try{const plan=nativeWorkerBoundary({BRAIN_WORKER_LAUNCH:JSON.stringify({command:[${JSON.stringify(runtime)}],argv:["bwrap","--dev-bind",socket,"/tmp/foreign.sock","--",${JSON.stringify(runtime)}]})});
        const argv=JSON.parse(plan.env.BRAIN_WORKER_LAUNCH).argv;writeFileSync(argv[argv.indexOf("-o")+1],${JSON.stringify(`1 execve(${JSON.stringify(runtime)}, [], 0x1) = 0`)});plan.dispose();
      }finally{server.stop(true);}`, scratch);
    expect(result.code).not.toBe(0);
    expect(result.output).toContain('"reason":"fixture storage contains an unowned Unix socket or directory alias"');
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});

test("audit receipts reject writable evidence and replaced trace inodes", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "odysseus-audit-integrity-"));
  try {
    for (const damage of ["mode", "inode"]) {
      const result = await probe(`${imports}
        import {auditNativeLaunch} from ${JSON.stringify(join(ROOT, "scripts/test-native-guard.ts"))};
        import {chmodSync,unlinkSync,writeFileSync,statSync} from "node:fs";
        const workerUid=(process.getuid()||21000)+1;
        const audit=auditNativeLaunch(["/usr/bin/true"],["/synthetic/native"],()=>{},workerUid);
        const log=audit.argv[audit.argv.indexOf("-o")+1],dir=log.slice(0,log.lastIndexOf("/"));
        if((statSync(dir).mode&7)||(statSync(log).mode&7))throw Error("audit evidence permits unrelated accounts");
        if(${JSON.stringify(damage)}==="mode")chmodSync(log,0o666);else{unlinkSync(log);writeFileSync(log,'1 execve("/synthetic/native", [], 0x1) = 0',{mode:0o600});}
        audit.dispose();`, scratch);
      expect(result.code).not.toBe(0);
      expect(result.output).toContain('"reason":"native audit storage integrity failed"');
      expect(result.output).toContain('"nativeLaunched":false,"success":false');
    }
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});

// Positive native tests are deliberately unavailable on developer hosts. The
// local suite proves refusal above; CI executes this assertion rather than a
// skipped test or an unsealed fallback.
test("hostile managed helper and native descendants cannot read an outside credential or open TCP", async () => {
    if (process.env.GITHUB_ACTIONS !== "true" || process.env.RUNNER_ENVIRONMENT !== "github-hosted") {
      nativeClaudeBoundary("/synthetic/isolation-unavailable", [], {});
      throw new Error("isolation unavailable refusal was bypassed");
    }
    const { nativeScriptedService } = await import("../scripts/test-native-guard");
    const scratch = mkdtempSync(join(tmpdir(), "odysseus-native-hostile-"));
    const home = join(scratch, "home"), brain = join(scratch, "brain"), managed = join(scratch, "managed"), bin = join(scratch, "bin");
    for (const path of [home, brain, managed, bin]) mkdirSync(path);
    const tool = join(bin, "odysseus-tool-witness"), toolSeen = join(home, "tool-seen");
    writeFileSync(tool, '#!/bin/sh\nprintf Odysseus > "$HOME/tool-seen"\n'); chmodSync(tool, 0o700);
    const sentinel = join(scratch, "outside-home-credential");
    writeFileSync(sentinel, "odysseus-synthetic-credential");
    writeFileSync(join(managed, "managed-settings.json"), JSON.stringify({
      env: { ANTHROPIC_BASE_URL: "http://198.18.0.1:1" },
      apiKeyHelper: `/usr/bin/cat ${sentinel}`,
    }));
    let requests = 0;
    const service = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { requests++; return new Response("Ithaca"); } });
    nativeScriptedService(service.url.origin);
    // Synthetic native reader exercises the OS boundary independently of SDK
    // settings precedence. The real installed runtime is covered by native
    // backend/provider-history cells under the same preload.
    const executable = join(brain, "odysseus-native-probe");
    writeFileSync(executable, `#!/usr/bin/python3
import http.client,json,os,socket,subprocess,time
settings=json.load(open('/etc/claude-code/managed-settings.json'))
helper=subprocess.run(settings['apiKeyHelper'],shell=True,capture_output=True)
assert helper.returncode != 0 and not helper.stdout, 'outside credential escaped'
assert os.environ.get('USE_BUILTIN_RIPGREP') == '0'
subprocess.run(['odysseus-tool-witness'],check=True)
for host,port in [('127.0.0.1',${service.port}),('198.18.0.1',1)]:
 probe=socket.socket(socket.AF_INET,socket.SOCK_STREAM)
 try:
  probe.connect((host,port))
 except OSError:
  pass
 else:
  raise RuntimeError('unintended native destination reached')
 finally:
  probe.close()
open(os.path.join(os.environ['HOME'],'boundary-ready'),'w').close()
while not os.path.exists(os.path.join(os.environ['HOME'],'late-ready')):
 time.sleep(.01)
late=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)
try:
 late.connect(os.path.join(os.environ['HOME'],'late-host.sock'))
except OSError:
 pass
else:
 raise RuntimeError('late host socket escaped')
finally:
 late.close()
connection=http.client.HTTPConnection('localhost')
connection.sock=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)
connection.sock.connect(os.environ['ANTHROPIC_UNIX_SOCKET'])
connection.request('GET','/v1/messages')
assert connection.getresponse().read() == b'Ithaca'
print('HOSTILE_MANAGED_BOUNDARY_HELD',flush=True)
`);
    chmodSync(executable, 0o700);
    let boundary: ReturnType<typeof nativeClaudeBoundary> | undefined;
    let lateServer: import("node:net").Server | undefined;
    let lateConnections=0;
    try {
      boundary = nativeClaudeBoundary(executable, [], { cwd: brain, env: { HOME: home, PATH: bin, USE_BUILTIN_RIPGREP: "0", ANTHROPIC_BASE_URL: service.url.origin }, managedSettings: managed });
      const child = spawnGuardFixture(boundary.argv, { env: boundary.env, stdout: "pipe", stderr: "pipe" });
      const output=Promise.all([child.exited,new Response(child.stdout).text(),child.guardOutput()]);
      const deadline=Date.now()+10000;
      while(!existsSync(join(home,"boundary-ready"))&&child.exitCode===null&&Date.now()<deadline)await Bun.sleep(10);
      if(!existsSync(join(home,"boundary-ready"))){child.kill();const failed=await output;throw Error("native policy failed before late socket proof: "+failed[2]);}
      const {createServer}=await import("node:net");
      lateServer=createServer(peer=>{lateConnections++;peer.destroy();});
      await new Promise<void>(resolve=>lateServer!.listen(join(home,"late-host.sock"),resolve));
      writeFileSync(join(home,"late-ready"),"Odysseus");
      const [code,out,err]=await output;
      expect(code, err).toBe(0);
      expect(lateConnections).toBe(0);
      expect(err).not.toContain('"kind":"native-offline-');
      expect(boundary.receipt().deniedConnects).toBeGreaterThanOrEqual(3);
      await new Promise<void>(resolve=>lateServer!.close(()=>resolve()));lateServer=undefined;
      rmSync(join(home,"late-host.sock"),{force:true});
      expect(out).toContain("HOSTILE_MANAGED_BOUNDARY_HELD");
      expect(out + err).not.toContain("odysseus-synthetic-credential");
      expect(requests).toBe(1);
      expect(existsSync(toolSeen)).toBe(true);
      // Restored mutation: re-expose only the synthetic outside credential.
      // The same runtime assertion must now reject the managed helper escape.
      const mutationBoundary = nativeClaudeBoundary(executable, [], { cwd: brain, env: { HOME: home, PATH: bin, USE_BUILTIN_RIPGREP: "0", ANTHROPIC_BASE_URL: service.url.origin }, managedSettings: managed });
      const mutant = [...mutationBoundary.argv];
      mutant.splice(mutant.indexOf("--clearenv"), 0, "--ro-bind", sentinel, sentinel);
      const broken = spawnGuardFixture(mutant, { env: boundary.env, stdout: "pipe", stderr: "pipe" });
      const [brokenCode, brokenOut, brokenErr] = await Promise.all([broken.exited,
        new Response(broken.stdout).text(), broken.guardOutput()]);
      expect(brokenCode).not.toBe(0);
      expect(brokenErr).toContain("outside credential escaped");
      expect(brokenOut + brokenErr).not.toContain("odysseus-synthetic-credential");
      mutationBoundary.dispose();
    } finally { lateServer?.close(); boundary?.dispose(); service.stop(true); rmSync(scratch, { recursive: true, force: true }); }
  });

test("native bind inventory rejects every forbidden host service root", async()=>{
 const scratch=mkdtempSync(join(tmpdir(),"odysseus-forbidden-bind-"));
 try {
  const result=await probe(`${imports}
   import {nativeWorkerBoundary} from ${JSON.stringify(join(ROOT,"scripts/test-native-guard.ts"))};
   const spawnSync=Bun.spawnSync,which=Bun.which;
   Bun.which=((command,options)=>command==="strace"?"/synthetic/strace":which(command,options));
   Bun.spawnSync=((argv,options)=>(["bwrap","strace"].includes(argv[0])||argv[0]?.endsWith("/native-connect"))?{exitCode:0,stdout:Buffer.alloc(0),stderr:Buffer.alloc(0)}:Reflect.apply(spawnSync,Bun,[argv,options]));
   process.env.GITHUB_ACTIONS="true";process.env.RUNNER_ENVIRONMENT="github-hosted";
   registerScriptedService("http://127.0.0.1:1");let refused=0;
   for(const root of ["/","/run","/var/run","/tmp","/dev","/dev/shm","/home","/var/lib","/etc","/var"])for(const source of [false,true]){
    try{nativeWorkerBoundary({BRAIN_WORKER_LAUNCH:JSON.stringify({command:[${JSON.stringify(runtime)}],argv:["bwrap","--ro-bind",source?root:${JSON.stringify(scratch)},source?${JSON.stringify(scratch)}:root,"--",${JSON.stringify(runtime)}]})});}
    catch(error){if(String(error).includes("forbidden host service root"))refused++;else throw error;}
   }if(refused!==20)throw Error("forbidden root admitted");console.error("FORBIDDEN_BIND_ROOTS_REFUSED:20");`,scratch);
  expect(result.code).not.toBe(0);expect(result.output.split("\n")).toContain("FORBIDDEN_BIND_ROOTS_REFUSED:20");
  expect(result.output).not.toContain('"nativeLaunched":true');
 }finally{rmSync(scratch,{recursive:true,force:true});}
});

test("fixed read-only system mounts are never recursively walked",async()=>{
 const scratch=mkdtempSync(join(tmpdir(),"odysseus-system-policy-"));
 try{
  const result=await probe(`${imports}
   import {mock} from "bun:test";
   import * as fs from "node:fs";
   const read=fs.readdirSync;
   mock.module("node:fs",()=>({...fs,readdirSync(path,...args){if(String(path)==="/usr")throw Object.assign(Error("system walk forbidden"),{code:"EACCES"});return read(path,...args);}}));
   const spawnSync=Bun.spawnSync,which=Bun.which;
   Bun.which=((command,options)=>command==="strace"?"/synthetic/strace":which(command,options));
   Bun.spawnSync=((argv,options)=>(["bwrap","strace"].includes(argv[0])||argv[0]?.endsWith("/native-connect"))?{exitCode:0,stdout:Buffer.alloc(0),stderr:Buffer.alloc(0)}:Reflect.apply(spawnSync,Bun,[argv,options]));
   process.env.GITHUB_ACTIONS="true";process.env.RUNNER_ENVIRONMENT="github-hosted";registerScriptedService("http://127.0.0.1:1");
   const plan=nativeClaudeBoundary(${JSON.stringify(runtime)},[],{cwd:${JSON.stringify(scratch)},env:{HOME:${JSON.stringify(scratch)}}});
   if(!plan.argv.some((value,index)=>value==="--ro-bind"&&plan.argv[index+1]==="/usr"&&plan.argv[index+2]==="/usr"))throw Error("fixed system mount absent");
   fs.writeFileSync(plan.argv[plan.argv.indexOf("-o")+1],${JSON.stringify(`1 execve(${JSON.stringify(runtime)}, [], 0x1) = 0`)});plan.dispose();`,scratch);
  expect(result.code,result.output).toBe(0);
 }finally{rmSync(scratch,{recursive:true,force:true});}
});

test("non-system missing and inaccessible entries remain failed receipts",async()=>{
 for(const code of ["ENOENT","EACCES"]){
  const scratch=mkdtempSync(join(tmpdir(),"odysseus-nonsystem-policy-"));
  try{
   const result=await probe(`${imports}
    import {mock} from "bun:test";import * as fs from "node:fs";
    const read=fs.readdirSync;
    if(${JSON.stringify(code)}==="ENOENT")fs.symlinkSync(${JSON.stringify(join(scratch,"absent"))},${JSON.stringify(join(scratch,"missing"))});
    else mock.module("node:fs",()=>({...fs,readdirSync(path,...args){if(String(path)===${JSON.stringify(scratch)})throw Object.assign(Error("synthetic unreadable fixture"),{code:"EACCES"});return read(path,...args);}}));
    const spawnSync=Bun.spawnSync,which=Bun.which;
    Bun.which=((command,options)=>command==="strace"?"/synthetic/strace":which(command,options));
    Bun.spawnSync=((argv,options)=>(["bwrap","strace"].includes(argv[0])||argv[0]?.endsWith("/native-connect"))?{exitCode:0,stdout:Buffer.alloc(0),stderr:Buffer.alloc(0)}:Reflect.apply(spawnSync,Bun,[argv,options]));
    process.env.GITHUB_ACTIONS="true";process.env.RUNNER_ENVIRONMENT="github-hosted";registerScriptedService("http://127.0.0.1:1");
    const plan=nativeClaudeBoundary(${JSON.stringify(runtime)},[],{cwd:${JSON.stringify(scratch)},env:{HOME:${JSON.stringify(scratch)}}});
    fs.writeFileSync(plan.argv[plan.argv.indexOf("-o")+1],${JSON.stringify(`1 execve(${JSON.stringify(runtime)}, [], 0x1) = 0`)});plan.dispose();`,scratch);
   expect(result.code).not.toBe(0);expect(result.output).toContain('"metadataError":"'+code+'"');expect(result.output).toContain('"nativeLaunched":false');
  }finally{rmSync(scratch,{recursive:true,force:true});}
 }
});

test("worker admission classifies executable argv and refuses missing or disagreeing commands",async()=>{
 const scratch=mkdtempSync(join(tmpdir(),"odysseus-worker-executable-"));
 try{
  symlinkSync(runtime!,join(scratch,"selected"));
  for(const launch of [
   {argv:[runtime]},
   {command:[runtime]},
   {command:["/usr/bin/true"],argv:[runtime]},
   {command:["/usr/bin/true"],argv:["selected"],env:{PATH:scratch},brainPath:scratch},
   {command:["/usr/bin/true"],argv:["./selected"],env:{PATH:"/usr/bin:/bin"},brainPath:scratch},
  ]){
   const result=await probe(`${imports} import {nativeWorkerBoundary} from ${JSON.stringify(join(ROOT,"scripts/test-native-guard.ts"))};nativeWorkerBoundary({BRAIN_WORKER_LAUNCH:${JSON.stringify(JSON.stringify(launch))}});`,scratch);
   expect(result.code).not.toBe(0);expect(result.output).toContain('"nativeLaunched":false');
   expect(result.output).toMatch(/worker command and (?:argv are required|executable argv disagree)/);
  }
 }finally{rmSync(scratch,{recursive:true,force:true});}
});

test("unregistered keeper namespace temporary sources still refuse before native launch",async()=>{
 const scratch=mkdtempSync(join(tmpdir(),"odysseus-keeper-refusal-")),keeper=mkdtempSync(join(tmpdir(),"odysseus-output-keeper-"));
 try{
  const missing=join(keeper,"merged/.brain/scratch");
  const result=await probe(`${imports}
   import {nativeWorkerBoundary} from ${JSON.stringify(join(ROOT,"scripts/test-native-guard.ts"))};import {writeFileSync} from "node:fs";
   const spawnSync=Bun.spawnSync,which=Bun.which;
   Bun.which=((command,options)=>command==="strace"?"/synthetic/strace":which(command,options));
   Bun.spawnSync=((argv,options)=>(["bwrap","strace"].includes(argv[0])||argv[0]?.endsWith("/native-connect"))?{exitCode:0,stdout:Buffer.alloc(0),stderr:Buffer.alloc(0)}:Reflect.apply(spawnSync,Bun,[argv,options]));
   process.env.GITHUB_ACTIONS="true";process.env.RUNNER_ENVIRONMENT="github-hosted";registerScriptedService("http://127.0.0.1:1");
   const plan=nativeWorkerBoundary({BRAIN_WORKER_LAUNCH:JSON.stringify({command:[${JSON.stringify(runtime)}],brainPath:${JSON.stringify(scratch)},env:{HOME:${JSON.stringify(scratch)}},argv:["bwrap","--bind",${JSON.stringify(missing)},"/tmp/odysseus-worker-area","--",${JSON.stringify(runtime)}]})});
   const argv=JSON.parse(plan.env.BRAIN_WORKER_LAUNCH).argv;
   writeFileSync(argv[argv.indexOf("-o")+1],${JSON.stringify(`1 execve(${JSON.stringify(runtime)}, [], 0x1) = 0`)});plan.dispose();`,scratch);
  expect(result.code).not.toBe(0);
  expect(result.output).toContain("worker bind source is unavailable");
  expect(result.output).toContain('"sourceKind":"unregistered-source"');
  expect(result.output).toContain('"targetKind":"fixture-temporary"');
  expect(result.output).toContain('"metadataError":"ENOENT"');
  expect(result.output).toContain('"nativeLaunched":false');
 }finally{rmSync(scratch,{recursive:true,force:true});rmSync(keeper,{recursive:true,force:true});}
});

test("worker outside-HOME regular files require explicit fixture snapshots",async()=>{
 const scratch=mkdtempSync(join(tmpdir(),"odysseus-worker-files-")),outside=mkdtempSync(join(tmpdir(),"odysseus-outside-file-"));
 const sentinel=join(outside,"credential-like"),home=join(scratch,"home");mkdirSync(home);writeFileSync(sentinel,"odysseus-synthetic-sentinel");
 try{
  for(const admitted of [false,true]){
   const result=await probe(`${imports}
    import {nativeWorkerBoundary,nativeScriptedService} from ${JSON.stringify(join(ROOT,"scripts/test-native-guard.ts"))};import {writeFileSync,readFileSync} from "node:fs";
    const spawnSync=Bun.spawnSync,which=Bun.which;
    Bun.which=((command,options)=>command==="strace"?"/synthetic/strace":which(command,options));
    Bun.spawnSync=((argv,options)=>(["bwrap","strace"].includes(argv[0])||argv[0]?.endsWith("/native-connect"))?{exitCode:0,stdout:Buffer.alloc(0),stderr:Buffer.alloc(0)}:Reflect.apply(spawnSync,Bun,[argv,options]));
    process.env.GITHUB_ACTIONS="true";process.env.RUNNER_ENVIRONMENT="github-hosted";
    nativeScriptedService("http://127.0.0.1:1",{fixtureRoots:[${JSON.stringify(home)}],fixtureFiles:${admitted?JSON.stringify([sentinel]):"[]"}});
    const plan=nativeWorkerBoundary({BRAIN_WORKER_LAUNCH:JSON.stringify({command:[${JSON.stringify(runtime)}],brainPath:${JSON.stringify(home)},env:{HOME:${JSON.stringify(home)}},argv:["bwrap","--ro-bind",${JSON.stringify(sentinel)},"/tmp/sentinel","--",${JSON.stringify(runtime)}]})});
    const argv=JSON.parse(plan.env.BRAIN_WORKER_LAUNCH).argv;
    try { const at=argv.indexOf("/tmp/sentinel"),source=argv[at-1];
     if(source===${JSON.stringify(sentinel)})throw Error("outside file stayed live-bound");
     writeFileSync(${JSON.stringify(sentinel)},"changed-original");
     if(readFileSync(source,"utf8")!=="odysseus-synthetic-sentinel")throw Error("fixture copy was not a snapshot");plan.beforeLaunch();
    }finally{writeFileSync(argv[argv.indexOf("-o")+1],${JSON.stringify(`1 execve(${JSON.stringify(runtime)}, [], 0x1) = 0`)});plan.dispose();}`,scratch);
   if(admitted)expect(result.code,result.output).toBe(0);
   else {expect(result.code).not.toBe(0);expect(result.output).toContain("worker bind was not created or staged by the fixture");expect(result.output).toContain('"nativeLaunched":false');}
  }
 }finally{rmSync(scratch,{recursive:true,force:true});rmSync(outside,{recursive:true,force:true});}
});

test("offline collector authority preserves only explicitly generated synthetic OAuth",async()=>{
 const scratch=mkdtempSync(join(tmpdir(),"odysseus-offline-collector-"));
 try{
  const result=await probe(`${imports}
   import {nativeSyntheticCredential,nativeScriptedService} from ${JSON.stringify(join(ROOT,"scripts/test-native-guard.ts"))};import {writeFileSync,readFileSync} from "node:fs";
   const spawnSync=Bun.spawnSync,which=Bun.which;
   Bun.which=((command,options)=>command==="strace"?"/synthetic/strace":which(command,options));
   Bun.spawnSync=((argv,options)=>(["bwrap","strace"].includes(argv[0])||argv[0]?.endsWith("/native-connect"))?{exitCode:0,stdout:Buffer.alloc(0),stderr:Buffer.alloc(0)}:Reflect.apply(spawnSync,Bun,[argv,options]));
   process.env.GITHUB_ACTIONS="true";process.env.RUNNER_ENVIRONMENT="github-hosted";
   registerScriptedService("http://127.0.0.1:1");
   const token=nativeSyntheticCredential("CLAUDE_CODE_OAUTH_TOKEN");
   const leave=nativeScriptedService("http://127.0.0.1:2");
   try {for(const value of [token,"sk-ant-oat01-offline-odysseus-not-generated"]){
    const plan=nativeClaudeBoundary(${JSON.stringify(runtime)},[],{cwd:${JSON.stringify(scratch)},env:{HOME:${JSON.stringify(scratch)},CLAUDE_CODE_OAUTH_TOKEN:value,ANTHROPIC_BASE_URL:"http://127.0.0.1:2"}});
    const argv=plan.argv,at=argv.indexOf("CLAUDE_CODE_OAUTH_TOKEN");
    if((value===token)!==(at>=0&&argv[at+1]===value))throw Error("synthetic credential provenance lost");
    writeFileSync(argv[argv.indexOf("-o")+1],${JSON.stringify(`1 execve(${JSON.stringify(runtime)}, [], 0x1) = 0`)});plan.dispose();
   }} finally{leave();}
   const source=readFileSync(${JSON.stringify(join(ROOT,"scripts/measure-turn-surface-live.ts"))},"utf8");
   const hook=source.slice(source.indexOf("spawnClaudeCodeProcess: spec"),source.indexOf("turn = await startOverlappedTurn"));
   if(!hook.includes("nativeScriptedService(offline.nativeBaseUrl")||hook.indexOf("nativeScriptedService(")>hook.indexOf("child = spawn("))throw Error("collector did not pin service before spawn");
   if(!source.includes('offline ? nativeSyntheticCredential("CLAUDE_CODE_OAUTH_TOKEN")'))throw Error("collector did not generate its synthetic token");`,scratch);
  expect(result.code,result.output).toBe(0);
 }finally{rmSync(scratch,{recursive:true,force:true});}
});

test("a native argv cannot use an argument named bwrap as its isolation launcher",async()=>{
 const scratch=mkdtempSync(join(tmpdir(),"odysseus-fake-launcher-"));
 try{
  writeFileSync(join(scratch,"bwrap"),"#!/bin/sh\nexit 0\n",{mode:0o755});
  const command=[runtime!,join(scratch,"bwrap")];
  const result=await probe(`${imports}import {nativeWorkerBoundary} from ${JSON.stringify(join(ROOT,"scripts/test-native-guard.ts"))};
   nativeWorkerBoundary({BRAIN_WORKER_LAUNCH:${JSON.stringify(JSON.stringify({command,argv:command,brainPath:scratch}))}});`,scratch);
  expect(result.code).not.toBe(0);expect(result.output).toContain("native worker lacks the OS launcher");expect(result.output).toContain('"nativeLaunched":false');
 }finally{rmSync(scratch,{recursive:true,force:true});}
});

test("worker filesystem-filter prefix is verified before native admission",async()=>{
 const scratch=mkdtempSync(join(tmpdir(),"odysseus-worker-filter-"));
 try{
  const result=await probe(`${imports}
   import {nativeWorkerBoundary} from ${JSON.stringify(join(ROOT,"scripts/test-native-guard.ts"))};import {WORKER_FILESYSTEM_FILTER_PROGRAM} from ${JSON.stringify(join(ROOT,"packages/ui-sdk/src/server/worker-filesystem-filter.ts"))};import {writeFileSync} from "node:fs";
   const spawnSync=Bun.spawnSync,which=Bun.which;
   Bun.which=((command,options)=>command==="strace"?"/synthetic/strace":which(command,options));
   Bun.spawnSync=((argv,options)=>(["bwrap","strace"].includes(argv[0])||argv[0]?.endsWith("/native-connect"))?{exitCode:0,stdout:Buffer.alloc(0),stderr:Buffer.alloc(0)}:Reflect.apply(spawnSync,Bun,[argv,options]));
   process.env.GITHUB_ACTIONS="true";process.env.RUNNER_ENVIRONMENT="github-hosted";registerScriptedService("http://127.0.0.1:1");
   const plan=nativeWorkerBoundary({BRAIN_WORKER_LAUNCH:JSON.stringify({command:[${JSON.stringify(runtime)}],brainPath:${JSON.stringify(scratch)},env:{HOME:${JSON.stringify(scratch)}},argv:["/usr/bin/python3","-I","-S","-c",WORKER_FILESYSTEM_FILTER_PROGRAM,"bwrap","--",${JSON.stringify(runtime)}]})});
   const argv=JSON.parse(plan.env.BRAIN_WORKER_LAUNCH).argv;
   if(!argv.includes(WORKER_FILESYSTEM_FILTER_PROGRAM)||!argv.includes("--unshare-net"))throw Error("trusted filter or OS boundary lost");
   writeFileSync(argv[argv.indexOf("-o")+1],${JSON.stringify(`1 execve(${JSON.stringify(runtime)}, [], 0x1) = 0`)});plan.dispose();`,scratch);
  expect(result.code,result.output).toBe(0);
 }finally{rmSync(scratch,{recursive:true,force:true});}
});

test("guard-created fixture roots cannot authorize a replacement host tree",async()=>{
 const scratch=mkdtempSync(join(tmpdir(),"odysseus-owned-root-"));
 try{
  const result=await probe(`${imports}
   import {nativeFixtureDirectory,nativeWorkerBoundary,nativeScriptedService} from ${JSON.stringify(join(ROOT,"scripts/test-native-guard.ts"))};import {writeFileSync,renameSync,mkdirSync,rmSync} from "node:fs";
   const spawnSync=Bun.spawnSync,which=Bun.which;
   Bun.which=((command,options)=>command==="strace"?"/synthetic/strace":which(command,options));
   Bun.spawnSync=((argv,options)=>(["bwrap","strace"].includes(argv[0])||argv[0]?.endsWith("/native-connect"))?{exitCode:0,stdout:Buffer.alloc(0),stderr:Buffer.alloc(0)}:Reflect.apply(spawnSync,Bun,[argv,options]));
   process.env.GITHUB_ACTIONS="true";process.env.RUNNER_ENVIRONMENT="github-hosted";
   nativeScriptedService("http://127.0.0.1:1",{fixtureRoots:[]});
   const root=nativeFixtureDirectory("odysseus-created-input-"),file=root+"/input";writeFileSync(file,"created-fixture");nativeScriptedService("http://127.0.0.1:1",{fixtureRoots:[root]});let plan;
   try {plan=nativeWorkerBoundary({BRAIN_WORKER_LAUNCH:JSON.stringify({command:[${JSON.stringify(runtime)}],argv:["bwrap","--ro-bind",file,"/tmp/input","--",${JSON.stringify(runtime)}]})});
    renameSync(root,root+"-original");mkdirSync(root);writeFileSync(file,"replacement-outside-data");
    let refused=false;try{plan.beforeLaunch();}catch(error){refused=String(error).includes("worker bind was not created or staged by the fixture");}
    if(!refused)throw Error("replacement root was admitted");console.error("CREATED_ROOT_REPLACEMENT_REFUSED");
   }finally{plan?.dispose();rmSync(root,{recursive:true,force:true});rmSync(root+"-original",{recursive:true,force:true});}`,scratch);
  expect(result.code).not.toBe(0);expect(result.output.split("\n")).toContain("CREATED_ROOT_REPLACEMENT_REFUSED");
 }finally{rmSync(scratch,{recursive:true,force:true});}
});

test("a refused worker spawn rejects and closes the failed invocation promptly",async()=>{
 const scratch=mkdtempSync(join(tmpdir(),"odysseus-refusal-deadline-"));
 try{
  const wrapper=join(scratch,"fixture-wrapper"),marker=join(scratch,"launched"),script=join(scratch,"probe.ts");
  writeFileSync(wrapper,`#!/bin/sh\nprintf launched > '${marker}'\n`);chmodSync(wrapper,0o700);
  writeFileSync(script,`${imports}
   await Promise.resolve().then(()=>Bun.spawn([${JSON.stringify(wrapper)},${JSON.stringify(runtime)}],{env:{BRAIN_WORKER_LAUNCH:JSON.stringify({command:[${JSON.stringify(wrapper)},${JSON.stringify(runtime)}],argv:["bwrap","--",${JSON.stringify(wrapper)},${JSON.stringify(runtime)}]})}})).catch(()=>console.error("SPAWN_PROMISE_REJECTED"));
   setInterval(()=>{},1000);`);
  const child=spawnGuardFixture([process.execPath,script],{env:{PATH:"/usr/bin:/bin",HOME:scratch},stdout:"pipe",stderr:"pipe",signal:AbortSignal.timeout(watchdogMs(5000))});
  const [code,out,err]=await Promise.all([child.exited,new Response(child.stdout).text(),child.guardOutput()]);
  expect(code,err).toBe(1);expect(out).toBe("");expect(err.split("\n")).toContain("SPAWN_PROMISE_REJECTED");
  expect(err).toContain('"nativeLaunched":false');expect(err).not.toContain("attempted real network access");expect(err).toContain("native isolation failed; see native-offline-* receipts");expect(existsSync(marker)).toBe(false);
 }finally{rmSync(scratch,{recursive:true,force:true});}
},watchdogMs(15000));

test("keeper output root requires a guarded child namespace and pinned fixture handle",async()=>{
 const scratch=mkdtempSync(join(tmpdir(),"odysseus-keeper-registration-")),keeperRoot=mkdtempSync(join(tmpdir(),"odysseus-keeper-output-")),outside=mkdtempSync(join(tmpdir(),"odysseus-keeper-outside-"));
 try{
  mkdirSync(join(keeperRoot,"merged/.brain/scratch"),{recursive:true});writeFileSync(join(keeperRoot,"merged/.brain/scratch/result.md"),"Odysseus returns to Ithaca.");
  symlinkSync(outside,join(keeperRoot,"merged/escape"));
  const result=await probe(`import * as fs from "node:fs";import {mock} from "bun:test";
   const child=Bun.spawn([process.execPath,"--no-env-file","-e",'process.stdin.resume();process.stdin.once("end",()=>process.exit(0));'],{stdin:"pipe",stdout:"ignore",stderr:"ignore"});
   const originalFs={...fs},namespace=\`/proc/\${child.pid}/ns/mnt\`;
   // Metadata-only stand-in for a separate tmpfs namespace. No namespace or
   // installed runtime executes; the hosted cell supplies the kernel proof.
   mock.module("node:fs",()=>({...originalFs,statSync:(path,options)=>{const info=originalFs.statSync(path,options);return path===namespace?{...info,ino:typeof info.ino==="bigint"?info.ino+1n:info.ino+1}:info;},statfsSync:()=>({type:0x01021994})}));
   const guard=await import(${JSON.stringify(join(ROOT,"scripts/test-native-guard.ts"))});
   const spawnSync=Bun.spawnSync,which=Bun.which;
   Bun.which=((name,options)=>name==="strace"?"/synthetic/strace":which(name,options));
   Bun.spawnSync=((argv,options)=>(["bwrap","strace"].includes(argv[0])||argv[0]?.endsWith("/native-connect"))?{exitCode:0,stdout:Buffer.alloc(0),stderr:Buffer.alloc(0)}:Reflect.apply(spawnSync,Bun,[argv,options]));
   process.env.GITHUB_ACTIONS="true";process.env.RUNNER_ENVIRONMENT="github-hosted";
   guard.nativeScriptedService("http://127.0.0.1:1",{fixtureRoots:[${JSON.stringify(scratch)}]});
   guard.recordNativeGuardChild(child);
   const fd=fs.openSync(${JSON.stringify(keeperRoot)},"r"),start=fs.readFileSync(\`/proc/\${child.pid}/stat\`,"utf8").replace(/^.*\\) /s,"").split(" ")[19];
   const unregister=guard.registerNativeFixtureKeeper({root:\`/proc/\${process.pid}/fd/\${fd}\`,mount:${JSON.stringify(keeperRoot)},namespacePid:child.pid,namespaceStart:start});
   const env={BRAIN_WORKER_LAUNCH:JSON.stringify({command:[${JSON.stringify(runtime)}],brainPath:${JSON.stringify(scratch)},env:{HOME:${JSON.stringify(scratch)}},argv:["/usr/bin/nsenter","--target",String(child.pid),"--user","--mount","--preserve-credentials","--","bwrap","--bind",${JSON.stringify(join(keeperRoot,"merged/.brain/scratch"))},"/tmp/odysseus-output","--",${JSON.stringify(runtime)}]})};
   try{
    const plan=guard.nativeWorkerBoundary(env);plan.beforeLaunch();
    const argv=JSON.parse(plan.env.BRAIN_WORKER_LAUNCH).argv;
    const binds=argv.slice(argv.indexOf("--bind"));if(!binds.includes(${JSON.stringify(join(keeperRoot,"merged/.brain/scratch"))}))throw Error("PUBLICATION_BIND_CHANGED");
    fs.writeFileSync(argv[argv.indexOf("-o")+1],${JSON.stringify(`1 execve(${JSON.stringify(runtime)}, [], 0x1) = 0`)});plan.dispose();console.error(JSON.stringify({keeperRoot:"admitted"}));
    const hostNamespace=JSON.parse(env.BRAIN_WORKER_LAUNCH);hostNamespace.argv=hostNamespace.argv.filter(value=>value!=="--mount");
    try{const unsafe=guard.nativeWorkerBoundary({BRAIN_WORKER_LAUNCH:JSON.stringify(hostNamespace)});unsafe.dispose();throw Error("KEEPER_WITHOUT_MOUNT_ADMITTED");}catch(error){if(!String(error).includes("worker bind was not created or staged by the fixture"))throw error;console.error(JSON.stringify({keeperRoot:"missing-mount-refused"}));}
    const escaped=JSON.parse(env.BRAIN_WORKER_LAUNCH);escaped.argv[escaped.argv.indexOf("--bind")+1]=${JSON.stringify(join(keeperRoot,"merged/escape"))};
    try{const unsafe=guard.nativeWorkerBoundary({BRAIN_WORKER_LAUNCH:JSON.stringify(escaped)});unsafe.dispose();throw Error("KEEPER_SYMLINK_ESCAPE_ADMITTED");}catch(error){if(!String(error).includes("worker bind was not created or staged by the fixture"))throw error;console.error(JSON.stringify({keeperRoot:"escape-refused"}));}
    unregister();
    try{const unsafe=guard.nativeWorkerBoundary(env);unsafe.dispose();throw Error("UNREGISTERED_KEEPER_ADMITTED");}catch(error){if(!String(error).includes("worker bind was not created or staged by the fixture"))throw error;console.error(JSON.stringify({keeperRoot:"unregistered-refused"}));}
   }finally{unregister();child.stdin.end();child.kill("SIGKILL");fs.closeSync(fd);}`,scratch);
  expect(result.output.split("\n")).toContain('{"keeperRoot":"missing-mount-refused"}');expect(result.output.split("\n")).toContain('{"keeperRoot":"admitted"}');expect(result.output.split("\n")).toContain('{"keeperRoot":"unregistered-refused"}');expect(result.output.split("\n")).toContain('{"keeperRoot":"escape-refused"}');expect(result.code).toBe(1);
 }finally{rmSync(scratch,{recursive:true,force:true});rmSync(keeperRoot,{recursive:true,force:true});rmSync(outside,{recursive:true,force:true});}
});

test("worker plans stage only their canonical read-only resolver with synthetic bytes",async()=>{
 for(const mode of ["canonical","unregistered","writable"] as const){
  const scratch=mkdtempSync(join(tmpdir(),"odysseus-resolver-plan-"));
  try{
   const resolver=join(scratch,"resolver"),other=join(scratch,"other");
   writeFileSync(resolver,"SIRENS_PRIVATE_DNS_MUST_NOT_COPY");writeFileSync(other,"OUTSIDE_CREDENTIAL_SENTINEL");
   const result=await probe(`import * as fs from "node:fs";import {mock} from "bun:test";
    const original={...fs};
    mock.module("node:fs",()=>({...original,realpathSync:(path,...args)=>path==="/etc/resolv.conf"?${JSON.stringify(resolver)}:original.realpathSync(path,...args),readFileSync:(path,...args)=>{if(path===${JSON.stringify(resolver)})throw Error("HOST_RESOLVER_BYTES_READ");return original.readFileSync(path,...args);}}));
    const guard=await import(${JSON.stringify(join(ROOT,"scripts/test-native-guard.ts"))});
    const spawnSync=Bun.spawnSync,which=Bun.which;
    Bun.which=((name,options)=>name==="strace"?"/synthetic/strace":which(name,options));
    Bun.spawnSync=((argv,options)=>(["bwrap","strace"].includes(argv[0])||argv[0]?.endsWith("/native-connect"))?{exitCode:0,stdout:Buffer.alloc(0),stderr:Buffer.alloc(0)}:Reflect.apply(spawnSync,Bun,[argv,options]));
    process.env.GITHUB_ACTIONS="true";process.env.RUNNER_ENVIRONMENT="github-hosted";
    guard.nativeScriptedService("http://127.0.0.1:1",{fixtureRoots:[]});
    const plan=guard.nativeWorkerBoundary({BRAIN_WORKER_LAUNCH:JSON.stringify({command:[${JSON.stringify(runtime)}],argv:["bwrap",${JSON.stringify(mode==="writable"?"--bind":"--ro-bind")},${JSON.stringify(mode==="unregistered"?other:resolver)},"/etc/resolv.conf","--",${JSON.stringify(runtime)}]})});
    try{plan.beforeLaunch();const argv=JSON.parse(plan.env.BRAIN_WORKER_LAUNCH).argv;
     const at=argv.indexOf("/etc/resolv.conf"),copy=argv[at-1];
     if(copy===${JSON.stringify(resolver)}||original.readFileSync(copy,"utf8")!=="nameserver 127.0.0.1\\noptions attempts:1 timeout:1\\n"||(original.statSync(copy).mode&0o777)!==0o444)throw Error("RESOLVER_PLAN_NOT_SYNTHETIC_READONLY");
     fs.writeFileSync(argv[argv.indexOf("-o")+1],${JSON.stringify(`1 execve(${JSON.stringify(runtime)}, [], 0x1) = 0`)});console.error("RESOLVER_PLAN_SYNTHETIC");
    }finally{plan.dispose();}`,scratch);
   expect(result.output).not.toContain("HOST_RESOLVER_BYTES_READ");
   if(mode==="canonical"){expect(result.code,result.output).toBe(0);expect(result.output.split("\n")).toContain("RESOLVER_PLAN_SYNTHETIC");}
   else{expect(result.code).not.toBe(0);expect(result.output).toContain(mode==="writable"?"native resolver bind must be read-only":"worker bind was not created or staged by the fixture");}
  }finally{rmSync(scratch,{recursive:true,force:true});}
 }
});


test("socket denial audit records raw syscalls without trusting stderr or syscall-looking data",async()=>{
 const {deniedNativeSocketOperations}=await import("../scripts/test-native-guard");
 expect(deniedNativeSocketOperations('42 connect(0x3, 0x123, 0x20) = -1 EPERM\n42 sendmsg(0x3, 0x456, 0x0) = -1 EPERM\n42 <... bind resumed>) = -1 EACCES\n42 openat(3, "connect(3) = -1 EPERM", 0) = -1 ENOENT\n42 execve("sendto(3) = -1 EPERM", [], 0) = 0\nchild claimed connect(3) = -1 EPERM')).toBe(3);
});

test("runtime provenance rechecks walk entries without re-attesting fixtures for every runtime file",async()=>{
 const scratch=mkdtempSync(join(tmpdir(),"odysseus-provenance-cost-"));
 try{
  const result=await probe(`import * as fs from "node:fs";import {mock} from "bun:test";
   const ROOT=${JSON.stringify(ROOT)},backend=ROOT+"/packages/ui-backend-claude";let stamp="",stampChecks=0,runtimeFiles=0,backendTraversals=0;
   const original={...fs};mock.module("node:fs",()=>({...original,
    lstatSync:(path,...args)=>{const info=original.lstatSync(path,...args);if(path===stamp)stampChecks++;if(info.isFile()&&(String(path).startsWith(ROOT+"/packages/")||String(path).startsWith(ROOT+"/node_modules/")))runtimeFiles++;return info;},
    readdirSync:(path,...args)=>{if(path===backend)backendTraversals++;return original.readdirSync(path,...args);}
   }));
   const guard=await import(${JSON.stringify(join(ROOT,"scripts/test-native-guard.ts"))});
   const spawnSync=Bun.spawnSync,which=Bun.which;Bun.which=((name,options)=>name==="strace"?"/synthetic/strace":which(name,options));
   Bun.spawnSync=((argv,options)=>(["bwrap","strace"].includes(argv[0])||argv[0]?.endsWith("/native-connect"))?{exitCode:0,stdout:Buffer.alloc(0),stderr:Buffer.alloc(0)}:Reflect.apply(spawnSync,Bun,[argv,options]));
   process.env.GITHUB_ACTIONS="true";process.env.RUNNER_ENVIRONMENT="github-hosted";
   stamp=guard.nativeFixtureDirectory("odysseus-attestation-count-");guard.nativeScriptedService("http://127.0.0.1:1",{fixtureRoots:[]});
   let plan;try{
    plan=guard.nativeWorkerBoundary({BRAIN_WORKER_LAUNCH:JSON.stringify({command:[${JSON.stringify(runtime)}],argv:["bwrap","--ro-bind",backend,"/tmp/odysseus-runtime-alias","--",${JSON.stringify(runtime)}]})});
    const initial=backendTraversals;plan.beforeLaunch();
    const argv=JSON.parse(plan.env.BRAIN_WORKER_LAUNCH).argv;fs.writeFileSync(argv[argv.indexOf("-o")+1],${JSON.stringify(`1 execve(${JSON.stringify(runtime)}, [], 0x1) = 0`)});
    console.error(JSON.stringify({runtimeProvenanceCost:{stampChecks,runtimeFiles,backendTraversals,initial}}));
   }finally{plan?.dispose();fs.rmSync(stamp,{recursive:true,force:true});}`,scratch);
  expect(result.code,result.output).toBe(0);
  const cost=JSON.parse(result.output.split("\n").find(line=>line.startsWith('{"runtimeProvenanceCost":'))!).runtimeProvenanceCost;
  expect(cost.runtimeFiles,"RUNTIME_TREE_WAS_WALKED").toBeGreaterThan(100);
  expect(cost.stampChecks,"FIXTURE_ATTESTATIONS_ARE_NOT_PER_RUNTIME_FILE").toBeLessThan(cost.runtimeFiles/5);
  expect(cost.backendTraversals,"OVERLAPPING_MOUNTS_WALKED_ONCE_PER_VALIDATION").toBeLessThanOrEqual(4);
  expect(cost.backendTraversals,"BEFORE_LAUNCH_RECHECK_IS_FRESH").toBeGreaterThan(cost.initial);
 }finally{rmSync(scratch,{recursive:true,force:true});}
});
