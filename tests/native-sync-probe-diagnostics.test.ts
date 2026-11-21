import { expect, test } from "bun:test";
import { join } from "node:path";
import { watchdogMs } from "../scripts/test-deadlines";
import { spawnGuardFixture } from "./helpers/native-receipt-fixture";

for(const classification of ["non-native","unclassified"] as const)test(`separate-UID synchronous broker probe keeps stderr FIFO independent of the native tee: ${classification}`,async()=>{
 const root=join(import.meta.dir,".."),guard=join(root,"scripts/test-native-guard.ts"),entry=join(root,"packages/ui-sdk/src/server/worker-entry.ts");
 // Synthetic control server; the ready/status/close client is the production broker.
 const server=`import os,sys,json,socket
cfg=json.loads(sys.argv[1]); listener=socket.socket(socket.AF_UNIX,socket.SOCK_SEQPACKET);listener.bind(cfg['socket']);listener.listen(4)
start=open('/proc/self/stat').read().rsplit(') ',1)[1].split()[19]
with open(cfg['ready']+'.tmp','w') as f: json.dump(dict(ok=True,workerUid=os.getuid()+1,worker=dict(pid=os.getpid(),start=start),roots={}),f)
os.replace(cfg['ready']+'.tmp',cfg['ready'])
while True:
 peer,_=listener.accept();request=json.loads(peer.recv(65537));assert request['secret']==cfg['secret']
 peer.send(json.dumps(dict(ok=True,exited=True,code=0)).encode());peer.close()
 if request['operation']=='close': break
listener.close();print('synthetic-probe-stderr',file=sys.stderr)
`;
 const child=spawnGuardFixture([process.execPath,"-e",`
  import {mock} from "bun:test";
  const guard={...await import(${JSON.stringify(guard)})};let tees=0;
  mock.module(${JSON.stringify(guard)},()=>({...guard,nativeWorkerBoundary(env){const plan=guard.nativeWorkerBoundary(env);const launch=env.BRAIN_WORKER_LAUNCH&&JSON.parse(env.BRAIN_WORKER_LAUNCH);if(launch?.command?.[0]==="/usr/bin/true")return {...plan,native:true};${classification==="unclassified"?"const {native,...unknown}=plan;return unknown;":"return plan;"}},prepareNativeBootstrapDiagnostics(options){tees++;return guard.prepareNativeBootstrapDiagnostics(options);}}));
  const {createWorkerPipes}=await import(${JSON.stringify(join(root,"packages/ui-sdk/src/server/worker-pipes.ts"))});
  const {prepareWorkerIdentity}=await import(${JSON.stringify(join(root,"packages/ui-sdk/src/server/worker-identity.ts"))});
  const {readFileSync,writeSync}=await import("node:fs");
  // Explicit synthetic classification keeps the native tee active in this process.
  const native=createWorkerPipes(),streams=native.streams();streams.stdout.resume();streams.stderr.resume();
  const first=Bun.spawn([process.execPath,${JSON.stringify(entry)}],{env:{PATH:"/usr/bin:/bin",BRAIN_WORKER_LAUNCH:JSON.stringify({command:["/usr/bin/true"],argv:["/usr/bin/true"]})},stdin:native.child[0],stdout:native.child[1],stderr:native.child[2]});
  native.closeChild();streams.stdin.end();
  const p=createWorkerPipes(),broker=prepareWorkerIdentity("/usr/bin/true",[],[]),config=JSON.parse(broker.command[5]);
  const command=["/usr/bin/python3","-I","-S","-u","-c",${JSON.stringify(server)},JSON.stringify(config)];
  const supervisor=Bun.spawn([process.execPath,${JSON.stringify(entry)}],{env:{PATH:"/usr/bin:/bin",BRAIN_WORKER_LAUNCH:JSON.stringify({command,argv:command})},stdin:p.child[0],stdout:p.child[1],stderr:p.child[2]});
  // Same blocking branch as probeWorkerHost: do not await supervisor.exited.
  broker.ready(supervisor.pid,Date.now()+${watchdogMs(1000)});broker.request("release");const status=broker.request("status");if(!status.exited)throw Error("synthetic broker did not exit");broker.close();writeSync(1,"BROKER_CLOSED\\n");
  p.closeChild();p.closeInput();const output=readFileSync(p.parent[1],"utf8"),errors=readFileSync(p.parent[2],"utf8");p.cleanup();await first.exited;native.cleanup();
  if(output!==""||!errors.includes("synthetic-probe-stderr"))throw Error("SYNC_PROBE_PROTOCOL_CORRUPTED");
  if(tees!==1)throw Error("ONLY_NATIVE_PLAN_RECEIVES_TEE");console.log("SYNC_PROBE_FIFO_COMPLETED");
 `],{env:{PATH:"/usr/bin:/bin"},timeout:watchdogMs(2000)});
 const [code,out,errors]=await Promise.all([child.exited,new Response(child.stdout).text(),child.guardOutput()]);
 expect(out,"SYNC_BROKER_SEQUENCE_COMPLETED "+errors).toContain("BROKER_CLOSED");
 expect(code,"SYNC_PROBE_FIFO_COMPLETES_WITHOUT_EVENT_LOOP "+errors).toBe(0);
 expect(out).toContain("SYNC_PROBE_FIFO_COMPLETED");
},watchdogMs(10000));
