/** Synthetic processes only: a non-dumpable supervisor must not become RTK authority. */
import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { watchdogMs } from "../scripts/test-deadlines";

test("owned RTK adapter requires one exact live audited descendant and the original launch",async()=>{
 const directory=mkdtempSync(join(tmpdir(),"odysseus-rtk-adapter-")),repo=join(import.meta.dir,"..");
 try{
  const script=join(directory,"probe.ts");
  writeFileSync(script,`
import {spyOn} from "bun:test";
import * as fs from "node:fs";
import {enterMeasurementRtkView} from ${JSON.stringify(join(repo,"scripts/measurement-rtk-fixture.ts"))};
import {recordNativeGuardChild,observeNativeFixtureRtkSpawn,registerNativeFixtureRtk} from ${JSON.stringify(join(repo,"scripts/test-native-guard.ts"))};
import {rewriteWorkerRtk} from ${JSON.stringify(join(repo,"packages/ui-sdk/src/server/worker-rtk.ts"))};
await enterMeasurementRtkView();
const python=fs.realpathSync("/usr/bin/python3");
const selectedAliasRoot=fs.mkdtempSync("/tmp/odysseus-selected-runtime-");const selectedAlias=selectedAliasRoot+"/python";fs.symlinkSync(python,selectedAlias);
const source='import ctypes,subprocess,sys,json\\nctypes.CDLL(None).prctl(4,0,0,0,0)\\nchildren=[subprocess.Popen([sys.executable,"-I","-S","-c","import time;time.sleep(30)"]) for _ in range(2)]\\nprint(json.dumps([p.pid for p in children]),flush=True)\\nsys.stdin.readline()\\nfor p in children: p.terminate();p.wait()';
const env={PATH:"/usr/local/bin:/usr/bin:/bin",HOME:"/nonexistent"};
const child=Bun.spawn([python,"-I","-S","-c",source],{env,stdin:"pipe",stdout:"pipe",stderr:"pipe"});
recordNativeGuardChild(child);
try{
 const reader=child.stdout.getReader(),ready=await reader.read();reader.releaseLock();
 const pids=JSON.parse(new TextDecoder().decode(ready.value));
 const start=(pid)=>fs.readFileSync('/proc/'+pid+'/stat','utf8').replace(/^.*\\) /s,'').split(' ')[19];
 const launch={env:{...env},brainPath:"/tmp"};
 const worker={pid:child.pid,exited:child.exited};
 const outcomes=[];
 function refuses(label,fn){let refused=false;try{fn();}catch{refused=true;}if(!refused)throw Error(label);outcomes.push(label);}
 refuses("UNREGISTERED_ROOT",()=>observeNativeFixtureRtkSpawn(process.pid,launch,[python],()=>new Map()));
 refuses("AMBIGUOUS_SELECTED_RUNTIME",()=>observeNativeFixtureRtkSpawn(child.pid,launch,[python,"/usr/bin/true"],()=>new Map()));
 observeNativeFixtureRtkSpawn(child.pid,launch,[python],()=>new Map());
 refuses("MISSING_PAYLOAD",()=>registerNativeFixtureRtk(worker));
 observeNativeFixtureRtkSpawn(child.pid,launch,[python],()=>new Map(pids.map(pid=>[pid,start(pid)])));
 refuses("AMBIGUOUS_PAYLOAD_NOT_FIRST_DESCENDANT",()=>registerNativeFixtureRtk(worker));
 observeNativeFixtureRtkSpawn(child.pid,launch,["/usr/bin/true"],()=>new Map([[pids[0],start(pids[0])]]));
 refuses("WRONG_EXECUTABLE",()=>registerNativeFixtureRtk(worker));
 observeNativeFixtureRtkSpawn(child.pid,launch,[python],()=>new Map([[pids[0],"reused-start"]]));
 refuses("REUSED_PAYLOAD",()=>registerNativeFixtureRtk(worker));
 observeNativeFixtureRtkSpawn(child.pid,launch,[python],()=>new Map([[pids[0],start(pids[0])]]));
 const read=fs.readFileSync;
 const spy=spyOn(fs,"readFileSync").mockImplementation((path,...args)=>{const value=read(path,...args);return path==='/proc/'+child.pid+'/stat'?value.replace(/^(.*\\) )(.*)$/s,(_,prefix,rest)=>{const fields=rest.split(' ');fields[19]='reused-root';return prefix+fields.join(' ');}):value;});
 try{refuses("REUSED_ROOT",()=>registerNativeFixtureRtk(worker));}finally{spy.mockRestore();}
 // The non-dumpable supervisor remains unreadable; only its proven child is admitted.
 refuses("BROKER_STAYS_NONDUMPABLE",()=>fs.readFileSync('/proc/'+child.pid+'/environ'));
 observeNativeFixtureRtkSpawn(child.pid,launch,[selectedAlias],()=>new Map([[pids[0],start(pids[0])]]));
 registerNativeFixtureRtk(worker);
 launch.env.PATH="/unregistered";
 const rewritten=await rewriteWorkerRtk(worker,"touch /tmp/brain-worker-scratch/original");
 if(rewritten!=="touch /tmp/brain-worker-scratch/rewritten")throw Error("OWNED_PAYLOAD_REWRITES_WITH_ORIGINAL_LAUNCH: "+rewritten);
 outcomes.push("OWNED_PAYLOAD_REWRITES_WITH_ORIGINAL_LAUNCH");console.log(JSON.stringify(outcomes));
}finally{child.stdin.end("done\\n");await child.exited;fs.rmSync(selectedAliasRoot,{recursive:true,force:true});}
`);
  const child=Bun.spawn([process.execPath,script],{env:{PATH:"/usr/bin:/bin"},stdout:"pipe",stderr:"pipe",timeout:watchdogMs(20000)});
  const [code,out,err]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
  expect(code,"OWNED_RTK_ADAPTER "+err).toBe(0);
  expect(JSON.parse(out.trim())).toEqual(["UNREGISTERED_ROOT","AMBIGUOUS_SELECTED_RUNTIME","MISSING_PAYLOAD","AMBIGUOUS_PAYLOAD_NOT_FIRST_DESCENDANT","WRONG_EXECUTABLE","REUSED_PAYLOAD","REUSED_ROOT","BROKER_STAYS_NONDUMPABLE","OWNED_PAYLOAD_REWRITES_WITH_ORIGINAL_LAUNCH"]);
 }finally{rmSync(directory,{recursive:true,force:true});}
},watchdogMs(30000));
