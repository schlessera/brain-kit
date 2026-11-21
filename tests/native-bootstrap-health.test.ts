import { watchdogMs } from "../scripts/test-deadlines";
import { expect, test } from "bun:test";
import { join } from "node:path";
import { spawnGuardFixture } from "./helpers/native-receipt-fixture";

test("guard FIFO completion keeps keyless admission health within one second",async()=>{
 const entry=join(import.meta.dir,"../packages/ui-sdk/src/server/worker-entry.ts"),pipes=join(import.meta.dir,"../packages/ui-sdk/src/server/worker-pipes.ts");
 const child=spawnGuardFixture([process.execPath,"-e",`
  import {mock} from "bun:test";
  const actual={...await import("node:stream/promises")};
  mock.module("node:stream/promises",()=>({...actual,pipeline:(source,sink)=>{const end=sink.end.bind(sink);sink.end=(...args)=>{setTimeout(()=>end(...args),50);return sink;};return actual.pipeline(source,sink);}}));
  const guard={...await import(${JSON.stringify(join(import.meta.dir,"../scripts/test-native-guard.ts"))})};
  mock.module(${JSON.stringify(join(import.meta.dir,"../scripts/test-native-guard.ts"))},()=>({...guard,nativeWorkerBoundary(env){return {...guard.nativeWorkerBoundary(env),native:Boolean(env.BRAIN_WORKER_LAUNCH)};}}));
  import {readFileSync} from "node:fs";
  import {createWorkerPipes} from ${JSON.stringify(pipes)};
  const server=Bun.serve({hostname:"127.0.0.1",port:0,async fetch(request){
   if(new URL(request.url).pathname==="/health")return new Response("healthy");
   const p=createWorkerPipes();try{
    const boot=Bun.spawn([process.execPath,${JSON.stringify(entry)}],{env:{PATH:"/usr/bin:/bin",BRAIN_WORKER_LAUNCH:JSON.stringify({command:["/usr/bin/true"],argv:["/usr/bin/true"]})},stdin:p.child[0],stdout:p.child[1],stderr:p.child[2]});
    await boot.exited;p.closeChild();p.closeInput();console.log("BOOT_EXITED");
    readFileSync(p.parent[1],"utf8");readFileSync(p.parent[2],"utf8");
    return new Response("qualified");
   }finally{p.cleanup();}
  }});console.log(server.port);
 `],{env:{PATH:"/usr/bin:/bin"}});
 const reader=child.stdout.getReader();let qualification:Promise<unknown>|undefined;
 try{
  const first=await reader.read(),port=Number(new TextDecoder().decode(first.value).trim()),origin=`http://127.0.0.1:${port}`;
  expect((await fetch(origin+"/health")).status).toBe(200);
  qualification=fetch(origin+"/qualify").then(response=>response.text()).catch(()=>undefined);
  let announced="";while(!announced.includes("BOOT_EXITED")){const part=await reader.read();if(part.done)throw Error("qualification exited before completion");announced+=new TextDecoder().decode(part.value);}
  const started=performance.now();
  const status=await fetch(origin+"/health",{signal:AbortSignal.timeout(1000)}).then(response=>response.status,()=>null);
  expect(status,"KEYLESS_ADMISSION_HEALTH_WITHIN_ONE_SECOND").toBe(200);
  expect(performance.now()-started).toBeLessThanOrEqual(1000);
  expect(await qualification).toBe("qualified");
 }finally{child.kill("SIGKILL");await child.exited;await qualification;await child.guardOutput();reader.releaseLock();}
},watchdogMs(10000));
