import { expect, test } from "bun:test";
import { join } from "node:path";
import { spawnGuardFixture } from "./helpers/native-receipt-fixture";

test("nonzero trusted bootstrap forwards protocol stderr and records a scrubbed reason", async () => {
 const pipes=join(import.meta.dir,"../packages/ui-sdk/src/server/worker-pipes.ts");
 const entry=join(import.meta.dir,"../packages/ui-sdk/src/server/worker-entry.ts");
 const child=spawnGuardFixture([process.execPath,"-e",`
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
  recordNativeGuardChild(boot,true,{...evidence,snapshot:()=> ["MY_PASSWORD=short-secret",'{"token":"tiny-token"}',"/home/odysseus/private.json",Array(4000).fill("benign").join(String.fromCharCode(10))].join(String.fromCharCode(10))});
  await boot.exited;await evidence.drained;await Bun.sleep(30);
 `],{env:{PATH:"/usr/bin:/bin"}});
 const [code,output]=await Promise.all([child.exited,child.guardOutput()]);expect(code,output).toBe(0);
 const record=JSON.parse(output.split("\n").find(line=>line.startsWith('{"kind":"native-offline-bootstrap-failure"'))!);
 expect(record.reason.length,"BOOTSTRAP_REASON_IS_BOUNDED").toBeLessThanOrEqual(4096);
 expect(record.reason.length).toBeGreaterThan(3000);
 for(const value of ["short-secret","tiny-token","/home/odysseus"])expect(record.reason,"BOOTSTRAP_REASON_IS_SCRUBBED").not.toContain(value);
});

test("diagnostic tee preserves FIFO-only bootstrap admission for a harmless executable",async()=>{
 const entry=join(import.meta.dir,"../packages/ui-sdk/src/server/worker-entry.ts"),pipes=join(import.meta.dir,"../packages/ui-sdk/src/server/worker-pipes.ts");
 const child=spawnGuardFixture([process.execPath,"-e",`
  import {createWorkerPipes} from ${JSON.stringify(pipes)};
  const p=createWorkerPipes(),streams=p.streams();streams.stderr.resume();streams.stdout.resume();
  const boot=Bun.spawn([process.execPath,${JSON.stringify(entry)}],{env:{PATH:"/usr/bin:/bin",BRAIN_WORKER_LAUNCH:JSON.stringify({command:["/usr/bin/true"],argv:["/usr/bin/true"]})},stdin:p.child[0],stdout:p.child[1],stderr:p.child[2]});
  p.closeChild();streams.stdin.end();const code=await boot.exited;if(code!==0)throw Error("SYNTHETIC_FIFO_BOOTSTRAP_REFUSED");await Bun.sleep(30);
 `],{env:{PATH:"/usr/bin:/bin"}});
 const [code,output]=await Promise.all([child.exited,child.guardOutput()]);expect(code,output).toBe(0);
 expect(output).toContain('"exitCode":0');expect(output).not.toContain('"kind":"native-offline-bootstrap-failure"');
});
