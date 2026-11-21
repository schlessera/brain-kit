import { watchdogMs } from "../scripts/test-deadlines";
import { expect, test } from "bun:test";
import { join } from "node:path";
import { spawnGuardFixture } from "./helpers/native-receipt-fixture";

test("nonzero trusted bootstrap forwards protocol stderr and records a scrubbed reason", async () => {
 const pipes=join(import.meta.dir,"../packages/ui-sdk/src/server/worker-pipes.ts");
 const entry=join(import.meta.dir,"../packages/ui-sdk/src/server/worker-entry.ts");
 const child=spawnGuardFixture([process.execPath,"-e",`
  import {mock} from "bun:test";
  const guard={...await import(${JSON.stringify(join(import.meta.dir,"../scripts/test-native-guard.ts"))})};
  mock.module(${JSON.stringify(join(import.meta.dir,"../scripts/test-native-guard.ts"))},()=>({...guard,nativeWorkerBoundary(env){return {...guard.nativeWorkerBoundary(env),native:Boolean(env.BRAIN_WORKER_LAUNCH)};}}));
  import {Readable} from "node:stream";
  import {createWorkerPipes} from ${JSON.stringify(pipes)};
  const p=createWorkerPipes();const streams=p.streams();const errors=new Response(Readable.toWeb(streams.stderr)).text();
  const boot=Bun.spawn([process.execPath,${JSON.stringify(entry)}],{env:{PATH:"/usr/bin:/bin",BRAIN_WORKER_LAUNCH:JSON.stringify({command:["/usr/bin/false"],argv:["/usr/bin/false"]})},stdio:[p.child[0],p.child[1],p.child[2],1]});
  p.closeChild();streams.stdin.end();const code=await boot.exited;console.error("FORWARDED:"+await errors);streams.stdout.destroy();await Bun.sleep(30);
 `],{env:{PATH:"/usr/bin:/bin"}});
 const [code,output]=await Promise.all([child.exited,child.guardOutput()]);expect(code,output).toBe(0);
 expect(output,"BOOTSTRAP_STDERR_FORWARDED").toContain("Worker launcher refused: non-protocol descriptor");
 const records=output.split("\n").filter(line=>line.startsWith('{"kind":"native-offline-bootstrap-failure"')).map(line=>JSON.parse(line));
 expect(records,"BOOTSTRAP_FAILURE_HAS_REASON").toHaveLength(1);
 expect(records[0].reason).toContain("non-protocol descriptor");expect(records[0].exitCode).toBe(1);
});

test("bootstrap reason records redact named credentials and bound diagnostic text",async()=>{
 const guard=join(import.meta.dir,"../scripts/test-native-guard.ts");
 const child=spawnGuardFixture([process.execPath,"-e",`
  import {prepareNativeBootstrapDiagnostics,recordNativeGuardChild} from ${JSON.stringify(guard)};
  import {createWorkerPipes} from ${JSON.stringify(join(import.meta.dir,"../packages/ui-sdk/src/server/worker-pipes.ts"))};
  const p=createWorkerPipes(),streams=p.streams();streams.stderr.resume();streams.stdout.resume();
  const capture=prepareNativeBootstrapDiagnostics({stderr:p.child[2],stdout:"ignore",stdin:"ignore"});
  const boot=Bun.spawn(["/bin/sh","-c","exit 7"],capture.options);
  const evidence=capture.attach(boot);p.closeChild();streams.stdin.end();
  recordNativeGuardChild(boot,true,{...evidence,snapshot:()=> ["MY_PASSWORD=short-secret",'{"token":"tiny-token"}',"Error: ANTHROPIC_AUTH_TOKEN=error-auth-value","failed: MY_PASSWORD=failure-password-value",'{"env":{"apiKey":"nested-api-value"}}','headers: {"x-api-key":"nested-header-value"}','config={"token":"nested-config-value"}' ,"/home/odysseus/private.json","bwrap: Can\'t create file at /etc/odysseus.conf: Read-only file system",Array(4000).fill("benign").join(String.fromCharCode(10))].join(String.fromCharCode(10))});
  await boot.exited;await evidence.drained;await Bun.sleep(30);
 `],{env:{PATH:"/usr/bin:/bin"}});
 const [code,output]=await Promise.all([child.exited,child.guardOutput()]);expect(code,output).toBe(0);
 const record=JSON.parse(output.split("\n").find(line=>line.startsWith('{"kind":"native-offline-bootstrap-failure"'))!);
 expect(record.reason.length,"BOOTSTRAP_REASON_IS_BOUNDED").toBeLessThanOrEqual(4096);
 expect(record.reason.length).toBeGreaterThan(3000);
 expect(record.reason).toContain("[mount-target etc]");expect(record.reason).not.toContain("odysseus.conf");
 for(const value of ["short-secret","tiny-token","/home/odysseus","error-auth-value","failure-password-value","nested-api-value","nested-header-value","nested-config-value"])expect(record.reason,"BOOTSTRAP_REASON_IS_SCRUBBED").not.toContain(value);
});

test("diagnostic tee preserves FIFO-only bootstrap admission for a harmless executable",async()=>{
 const entry=join(import.meta.dir,"../packages/ui-sdk/src/server/worker-entry.ts"),pipes=join(import.meta.dir,"../packages/ui-sdk/src/server/worker-pipes.ts");
 const child=spawnGuardFixture([process.execPath,"-e",`
  import {mock} from "bun:test";
  const guard={...await import(${JSON.stringify(join(import.meta.dir,"../scripts/test-native-guard.ts"))})};
  mock.module(${JSON.stringify(join(import.meta.dir,"../scripts/test-native-guard.ts"))},()=>({...guard,nativeWorkerBoundary(env){return {...guard.nativeWorkerBoundary(env),native:Boolean(env.BRAIN_WORKER_LAUNCH)};}}));
  import {createWorkerPipes} from ${JSON.stringify(pipes)};
  const p=createWorkerPipes(),streams=p.streams();streams.stderr.resume();streams.stdout.resume();
  const boot=Bun.spawn([process.execPath,${JSON.stringify(entry)}],{env:{PATH:"/usr/bin:/bin",BRAIN_WORKER_LAUNCH:JSON.stringify({command:["/usr/bin/true"],argv:["/usr/bin/true"]})},stdin:p.child[0],stdout:p.child[1],stderr:p.child[2]});
  p.closeChild();streams.stdin.end();const code=await boot.exited;if(code!==0)throw Error("SYNTHETIC_FIFO_BOOTSTRAP_REFUSED");await Bun.sleep(30);
 `],{env:{PATH:"/usr/bin:/bin"}});
 const [code,output]=await Promise.all([child.exited,child.guardOutput()]);expect(code,output).toBe(0);
 expect(output).toContain('"exitCode":0');expect(output).not.toContain('"kind":"native-offline-bootstrap-failure"');
});

test("an SDK-first nonzero exit cannot overtake its bootstrap reason and audit receipt",async()=>{
 const guard=join(import.meta.dir,"../scripts/test-native-guard.ts"),entry=join(import.meta.dir,"../packages/ui-sdk/src/server/worker-entry.ts"),pipes=join(import.meta.dir,"../packages/ui-sdk/src/server/worker-pipes.ts");
 const child=spawnGuardFixture([process.execPath,"-e",`
  import {mock} from "bun:test";
  const stream={...await import("node:stream/promises")};mock.module("node:stream/promises",()=>({...stream,pipeline:(source,sink)=>{const end=sink.end.bind(sink);sink.end=(...args)=>{setTimeout(()=>end(...args),50);return sink;};return stream.pipeline(source,sink);}}));
  const guard={...await import(${JSON.stringify(guard)})};const audit=guard.auditNativeLaunch(["/usr/bin/false"],["/usr/bin/true"],()=>{});
  mock.module(${JSON.stringify(guard)},()=>({...guard,nativeWorkerBoundary(env){const boundary=guard.nativeWorkerBoundary(env);return {...boundary,native:Boolean(env.BRAIN_WORKER_LAUNCH),dispose(){if(env.BRAIN_WORKER_LAUNCH)audit.dispose();boundary.dispose();}};}}));
  const {createWorkerPipes}=await import(${JSON.stringify(pipes)});const p=createWorkerPipes(),streams=p.streams();streams.stderr.resume();streams.stdout.resume();
  const boot=Bun.spawn([process.execPath,${JSON.stringify(entry)}],{env:{PATH:"/usr/bin:/bin",BRAIN_WORKER_LAUNCH:JSON.stringify({command:["/bin/sh","-c","echo synthetic-bootstrap-failure >&2; exit 1"],argv:["/bin/sh","-c","echo synthetic-bootstrap-failure >&2; exit 1"]})},stdin:p.child[0],stdout:p.child[1],stderr:p.child[2]});
  p.closeChild();streams.stdin.end();await boot.exited;process.exit(1);
 `],{env:{PATH:"/usr/bin:/bin"}});
 const [code,output]=await Promise.all([child.exited,child.guardOutput()]);expect(code).toBe(1);
 expect(output,"SDK_EXIT_PRESERVES_BOOTSTRAP_REASON").toContain('"kind":"native-offline-bootstrap-failure"');
 expect(output).toContain("synthetic-bootstrap-failure");
 expect(output,"SDK_EXIT_PRESERVES_AUDIT").toContain('"kind":"native-offline-audit"');
});

for(const mode of ["parent","timeout","exit143"] as const)test(`bootstrap termination reason distinguishes ${mode} from unexplained failure`,async()=>{
 const child=spawnGuardFixture([process.execPath,"-e",`
  import {recordNativeGuardChild} from ${JSON.stringify(join(import.meta.dir,"../scripts/test-native-guard.ts"))};
  const boot=Bun.spawn(${mode==="exit143"?'["/bin/sh","-c","exit 143"]':'["/usr/bin/sleep","30"]'},{env:{PATH:"/usr/bin:/bin"},stdin:"ignore",stdout:"ignore",stderr:"pipe",${mode==="timeout"?'timeout:50,':''}});
  const reported=recordNativeGuardChild(boot,true);${mode==="parent"?'boot.kill("SIGTERM");':''}await reported;
 `],{env:{PATH:"/usr/bin:/bin"}});
 const [code,out]=await Promise.all([child.exited,child.guardOutput()]);expect(code,out).toBe(0);
 const records=out.split("\n").filter(line=>line.startsWith('{"kind":"native-offline-bootstrap-')).map(line=>JSON.parse(line));
 if(mode==="exit143")expect(records.some(record=>record.kind==="native-offline-bootstrap-failure"),"UNREQUESTED_EXIT143_IS_STILL_FAILURE").toBe(true);
 else {expect(records.find(record=>record.kind==="native-offline-bootstrap-termination")?.reason,"EXPECTED_TERMINATION_HAS_FIXED_REASON").toBe(mode==="parent"?"terminated by parent signal":"terminated by signal");expect(out).not.toContain("stderr reason unavailable");}
});

for(const delay of [0,150])test(`cleanup kill after exit 1 preserves the bootstrap failure reason (${delay}ms)`,async()=>{
 const child=spawnGuardFixture([process.execPath,"-e",`
  import {recordNativeGuardChild} from ${JSON.stringify(join(import.meta.dir,"../scripts/test-native-guard.ts"))};
  import {readFileSync} from "node:fs";
  const boot=Bun.spawn(["/bin/sh","-c","echo fixture child failed >&2; exit 1"],{env:{PATH:"/usr/bin:/bin"},stdin:"ignore",stdout:"ignore",stderr:"pipe"});
  let text="";const drained=new Response(boot.stderr).text().then(value=>{text=value;});
  const reported=recordNativeGuardChild(boot,true,{drained,snapshot:()=>text});
  // Observe kernel exit without letting the JS exit callback run before cleanup.
  const deadline=Date.now()+${watchdogMs(2000)};
  for(;;){let exited=false;try{exited=/^[^)]+\\) Z /.test(readFileSync("/proc/"+boot.pid+"/stat","utf8"));}catch(error){if(error.code!=="ENOENT")throw error;exited=true;}if(exited)break;if(Date.now()>deadline)throw Error("SYNTHETIC_FAILURE_DID_NOT_EXIT");Bun.sleepSync(1);}
  Bun.sleepSync(${delay});boot.kill("SIGTERM");await reported;
 `],{env:{PATH:"/usr/bin:/bin"}});
 const [code,out]=await Promise.all([child.exited,child.guardOutput()]);expect(code,out).toBe(0);
 const record=out.split("\n").filter(line=>line.startsWith('{"kind":"native-offline-bootstrap-failure"')).map(line=>JSON.parse(line))[0];
 expect(record?.exitCode,"CLEANUP_KILL_MUST_NOT_RELABEL_FAILURE").toBe(1);
 expect(record?.reason).toContain("fixture child failed");
 expect(out).not.toContain('"kind":"native-offline-bootstrap-termination"');
});

for(const executed of [false,true])test(`nonzero synthetic child is labelled as ${executed?"native exit after exec":"bootstrap failure without exec"}`,async()=>{
 const guard=join(import.meta.dir,"../scripts/test-native-guard.ts"),entry=join(import.meta.dir,"../packages/ui-sdk/src/server/worker-entry.ts"),pipes=join(import.meta.dir,"../packages/ui-sdk/src/server/worker-pipes.ts");
 const child=spawnGuardFixture([process.execPath,"-e",`
  import {mock} from "bun:test";
  const guard={...await import(${JSON.stringify(guard)})};
  const audit=guard.auditNativeLaunch(["/bin/sh","-c","exit 1"],${JSON.stringify(executed?["/bin/sh"]:["/usr/bin/true"])},()=>{});audit.argv[0]=${JSON.stringify(Bun.which("strace"))};
  mock.module(${JSON.stringify(guard)},()=>({...guard,nativeWorkerBoundary(env){const plan=guard.nativeWorkerBoundary(env);if(!env.BRAIN_WORKER_LAUNCH)return plan;const launch=JSON.parse(env.BRAIN_WORKER_LAUNCH);return {...plan,native:true,env:{...env,BRAIN_WORKER_LAUNCH:JSON.stringify({...launch,argv:audit.argv})},nativeExecuted:audit.nativeExecuted,dispose:audit.dispose};}}));
  const {createWorkerPipes}=await import(${JSON.stringify(pipes)});const p=createWorkerPipes(),streams=p.streams();streams.stderr.resume();streams.stdout.resume();
  const boot=Bun.spawn([process.execPath,${JSON.stringify(entry)}],{env:{PATH:"/usr/bin:/bin",BRAIN_WORKER_LAUNCH:JSON.stringify({command:["/bin/sh","-c","exit 1"],argv:["/bin/sh","-c","exit 1"]})},stdin:p.child[0],stdout:p.child[1],stderr:p.child[2]});
  p.closeChild();streams.stdin.end();await boot.exited;
 `],{env:{PATH:"/usr/bin:/bin"}});
 const [,out]=await Promise.all([child.exited,child.guardOutput()]);
 const records=out.split("\n").filter(line=>line.startsWith('{"kind":"native-offline-')).map(line=>JSON.parse(line));
 const kind=executed?"native-offline-native-exit":"native-offline-bootstrap-failure";
 expect(records.find(record=>record.kind===kind),"POST_EXEC_EXIT_IS_NOT_BOOTSTRAP_FAILURE").toMatchObject({exitCode:1,signal:null});
 expect(records.some(record=>record.kind===(executed?"native-offline-bootstrap-failure":"native-offline-native-exit"))).toBe(false);
 expect(out).toContain(executed?"native payload exited nonzero without stderr":"worker bootstrap exited nonzero; stderr reason unavailable");
 expect(records.find(record=>record.kind==="native-offline-audit")?.nativeLaunched).toBe(executed);
});
