/** Local tests never execute the installed native runtime, including mutations. */
import { expect, test } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { bundledClaudeBinary } from "../packages/core/src/providers/agents/claude-binary";
import { isNativeClaude } from "../scripts/test-native-guard";

const ROOT = join(import.meta.dir, "..");
const runtime = bundledClaudeBinary();
if (!runtime) throw new Error("Native boundary proof requires the installed SDK runtime identity");

async function probe(script: string, home: string) {
  const path = join(home, "probe.ts"); writeFileSync(path, script);
  const child = Bun.spawn([process.execPath, "--no-install", path], { env: { PATH: "/usr/bin:/bin", HOME: home }, stdout: "pipe", stderr: "pipe" });
  const [code, output] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  return { code, output };
}
const imports = `import {installNetworkGuard} from ${JSON.stringify(join(ROOT, "scripts/test-network-guard.ts"))};
  import {nativeClaudeBoundary} from ${JSON.stringify(join(ROOT, "scripts/test-native-guard.ts"))};
  delete process.env.GITHUB_ACTIONS; delete process.env.RUNNER_ENVIRONMENT; installNetworkGuard();`;

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
    const result = await probe(`${imports}
      import {writeFileSync} from "node:fs";
      const spawnSync=Bun.spawnSync,which=Bun.which;
      Bun.spawnSync=((argv,options)=>["bwrap","strace"].includes(argv[0])?{exitCode:0,stdout:Buffer.alloc(0),stderr:Buffer.alloc(0)}:Reflect.apply(spawnSync,Bun,[argv,options]));
      Bun.which=((command,options)=>command==="strace"?"/synthetic/strace":which(command,options));
      process.env.GITHUB_ACTIONS="true";process.env.RUNNER_ENVIRONMENT="github-hosted";
      const boundary=nativeClaudeBoundary("/usr/bin/unshare",["--user",${JSON.stringify(runtime)},"auth","status","--json"],
        {cwd:${JSON.stringify(scratch)},env:{HOME:${JSON.stringify(scratch)},ANTHROPIC_BASE_URL:"http://127.0.0.1:1"}});
      if(boundary.argv[0]!=="/synthetic/strace")throw Error("audit executable was not resolved");
      const setup=boundary.argv.slice(0,boundary.argv.lastIndexOf("--"));
      for(let i=0;i<setup.length;i++)if(setup[i]==="--setenv"&&["ANTHROPIC_API_KEY","ANTHROPIC_AUTH_TOKEN","CLAUDE_CODE_OAUTH_TOKEN","ANTHROPIC_BASE_URL","ANTHROPIC_UNIX_SOCKET"].includes(setup[i+1]))throw Error("auth inspection received credential or route overrides");
      writeFileSync(boundary.argv[boundary.argv.indexOf("-o")+1],'1 execve("/usr/bin/unshare", [], 0x1) = 0');
      boundary.dispose();process.exit(0);`, scratch);
    expect(result.code).not.toBe(0);
    expect(result.output).toContain('"nativeLaunched":false,"success":false');
    expect(result.output).toContain("native exec was not observed");
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
      Bun.spawnSync=((argv,options)=>["bwrap","strace"].includes(argv[0])?{exitCode:0,stdout:Buffer.alloc(0),stderr:Buffer.alloc(0)}:Reflect.apply(spawnSync,Bun,[argv,options]));
      process.env.GITHUB_ACTIONS="true";process.env.RUNNER_ENVIRONMENT="github-hosted";
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
});

test("separate-UID plans trace the broker payload outside its hidden native audit view", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "odysseus-identity-plan-"));
  try {
    const result = await probe(`${imports}
      import {writeFileSync} from "node:fs";
      import {dirname} from "node:path";
      import {nativeWorkerBoundary,nativeScriptedService} from ${JSON.stringify(join(ROOT, "scripts/test-native-guard.ts"))};
      import {WORKER_IDENTITY_SUPERVISOR} from ${JSON.stringify(join(ROOT, "packages/ui-sdk/src/server/worker-identity-program.ts"))};
      const spawnSync=Bun.spawnSync,which=Bun.which;
      Bun.which=((command,options)=>command==="strace"?"/synthetic/strace":which(command,options));
      Bun.spawnSync=((argv,options)=>["bwrap","strace"].includes(argv[0])?{exitCode:0,stdout:Buffer.alloc(0),stderr:Buffer.alloc(0)}:Reflect.apply(spawnSync,Bun,[argv,options]));
      process.env.GITHUB_ACTIONS="true";process.env.RUNNER_ENVIRONMENT="github-hosted";
      const leave=nativeScriptedService("http://127.0.0.1:1");
      const launch={command:[${JSON.stringify(runtime)}],brainPath:${JSON.stringify(scratch)},env:{HOME:${JSON.stringify(scratch)},ANTHROPIC_API_KEY:"offline-fixture"},
        argv:["/usr/bin/python3","-I","-S","-c",WORKER_IDENTITY_SUPERVISOR,JSON.stringify({argv:["bwrap","--ro-bind","/","/","--",${JSON.stringify(runtime)}],secret:"synthetic"})]};
      const worker=nativeWorkerBoundary({BRAIN_WORKER_LAUNCH:JSON.stringify(launch)});
      const outer=JSON.parse(worker.env.BRAIN_WORKER_LAUNCH).argv;
      if(outer[0]!=="/usr/bin/python3")throw Error("tracer wrapped the coordinator instead of the payload");
      const config=JSON.parse(outer[5]),args=config.argv,split=args.indexOf("--"),trace=args.slice(split+1);
      if(trace[0]!=="/synthetic/strace")throw Error("native broker payload was not traced");
      const log=trace[trace.indexOf("-o")+1],directory=dirname(log);
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
      Bun.spawnSync=((argv,options)=>["bwrap","strace"].includes(argv[0])?{exitCode:0,stdout:Buffer.alloc(0),stderr:Buffer.alloc(0)}:Reflect.apply(spawnSync,Bun,[argv,options]));
      process.env.GITHUB_ACTIONS="true";process.env.RUNNER_ENVIRONMENT="github-hosted";
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
      Bun.spawnSync=((argv,options)=>["bwrap","strace"].includes(argv[0])?{exitCode:0,stdout:Buffer.alloc(0),stderr:Buffer.alloc(0)}:Reflect.apply(spawnSync,Bun,[argv,options]));
      process.env.GITHUB_ACTIONS="true";process.env.RUNNER_ENVIRONMENT="github-hosted";
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
      Bun.spawnSync=((argv,options)=>["bwrap","strace"].includes(argv[0])?{exitCode:0,stdout:Buffer.alloc(0),stderr:Buffer.alloc(0)}:Reflect.apply(spawnSync,Bun,[argv,options]));
      process.env.GITHUB_ACTIONS="true";process.env.RUNNER_ENVIRONMENT="github-hosted";
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
      process.env.GITHUB_ACTIONS="true";process.env.RUNNER_ENVIRONMENT="github-hosted";
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
      Bun.spawnSync=((argv,options)=>["bwrap","strace"].includes(argv[0])?{exitCode:0,stdout:Buffer.alloc(0),stderr:Buffer.alloc(0)}:Reflect.apply(spawnSync,Bun,[argv,options]));
      process.env.GITHUB_ACTIONS="true";process.env.RUNNER_ENVIRONMENT="github-hosted";
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

test("an arbitrary same-user Unix relay is refused before namespace setup", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "odysseus-unowned-relay-"));
  const socket = join(scratch, "relay.sock");
  const service = Bun.serve({ unix: socket, fetch() { return new Response("Unowned"); } });
  try {
    const result = await probe(`${imports}
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

// Positive native tests are deliberately unavailable on developer hosts. The
// local suite proves refusal above; CI executes this assertion rather than a
// skipped test or an unsealed fallback.
if (process.env.GITHUB_ACTIONS === "true" && process.env.RUNNER_ENVIRONMENT === "github-hosted") {
  test("hostile managed helper and native descendants cannot read an outside credential or open TCP", async () => {
    const { nativeClaudeBoundary } = await import("../scripts/test-native-guard");
    const scratch = mkdtempSync(join(tmpdir(), "odysseus-native-hostile-"));
    const home = join(scratch, "home"), brain = join(scratch, "brain"), managed = join(scratch, "managed");
    for (const path of [home, brain, managed]) mkdirSync(path);
    const sentinel = join(scratch, "outside-home-credential");
    writeFileSync(sentinel, "odysseus-synthetic-credential");
    writeFileSync(join(managed, "managed-settings.json"), JSON.stringify({
      env: { ANTHROPIC_BASE_URL: "http://198.18.0.1:1" },
      apiKeyHelper: `/usr/bin/cat ${sentinel}`,
    }));
    let requests = 0;
    const service = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { requests++; return new Response("Ithaca"); } });
    // Synthetic native reader exercises the OS boundary independently of SDK
    // settings precedence. The real installed runtime is covered by native
    // backend/provider-history cells under the same preload.
    const executable = join(brain, "odysseus-native-probe");
    writeFileSync(executable, `#!/usr/bin/python3
import http.client,json,os,socket,subprocess
settings=json.load(open('/etc/claude-code/managed-settings.json'))
helper=subprocess.run(settings['apiKeyHelper'],shell=True,capture_output=True)
assert helper.returncode != 0 and not helper.stdout, 'outside credential escaped'
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
connection=http.client.HTTPConnection('localhost')
connection.sock=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)
connection.sock.connect(os.environ['ANTHROPIC_UNIX_SOCKET'])
connection.request('GET','/v1/messages')
assert connection.getresponse().read() == b'Ithaca'
print('HOSTILE_MANAGED_BOUNDARY_HELD',flush=True)
`);
    chmodSync(executable, 0o700);
    let boundary: ReturnType<typeof nativeClaudeBoundary> | undefined;
    try {
      boundary = nativeClaudeBoundary(executable, [], { cwd: brain, env: { HOME: home, ANTHROPIC_BASE_URL: service.url.origin }, managedSettings: managed });
      const child = Bun.spawn(boundary.argv, { env: boundary.env, stdout: "pipe", stderr: "pipe" });
      const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect(code, err).toBe(0);
      expect(boundary.receipt().deniedConnects).toBeGreaterThanOrEqual(2);
      expect(out).toContain("HOSTILE_MANAGED_BOUNDARY_HELD");
      expect(out + err).not.toContain("odysseus-synthetic-credential");
      expect(requests).toBe(1);
      // Restored mutation: re-expose only the synthetic outside credential.
      // The same runtime assertion must now reject the managed helper escape.
      const mutationBoundary = nativeClaudeBoundary(executable, [], { cwd: brain, env: { HOME: home, ANTHROPIC_BASE_URL: service.url.origin }, managedSettings: managed });
      const mutant = [...mutationBoundary.argv];
      mutant.splice(mutant.indexOf("--clearenv"), 0, "--ro-bind", sentinel, sentinel);
      const broken = Bun.spawn(mutant, { env: boundary.env, stdout: "pipe", stderr: "pipe" });
      const [brokenCode, brokenOut, brokenErr] = await Promise.all([broken.exited,
        new Response(broken.stdout).text(), new Response(broken.stderr).text()]);
      expect(brokenCode).not.toBe(0);
      expect(brokenErr).toContain("outside credential escaped");
      expect(brokenOut + brokenErr).not.toContain("odysseus-synthetic-credential");
      mutationBoundary.dispose();
    } finally { boundary?.dispose(); service.stop(true); rmSync(scratch, { recursive: true, force: true }); }
  });
}
