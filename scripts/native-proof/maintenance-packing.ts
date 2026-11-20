/** Real dedicated-stage proof: one incompressible object larger than 256 MiB. */
import { join } from "node:path";
import type { HostBoundary } from "../../packages/ui-server/src/brain/host-boundary.js";

export async function proveNativeMaintenancePacking(boundary: HostBoundary, source: string, brain: string) {
  const cli=[process.execPath,join(source,"packages/core/src/cli/brain.ts")];
  const env={PATH:"/usr/bin:/bin",BRAIN_ROOT:brain};
  const bytes=272*1024**2;
  // The repeat distance exceeds deflate's 32 KiB window. Stream fixture bytes
  // into the worker's Git; none are retained in this repository.
  const program=`const chunk=Buffer.alloc(1024*1024);let x=123456789;
    for(let i=0;i<chunk.length;i++){x^=x<<13;x^=x>>>17;x^=x<<5;chunk[i]=x&255;}
    const git=Bun.spawn(["git","hash-object","-w","--stdin"],{stdin:"pipe",stdout:"pipe",stderr:"pipe"});
    const output=new Response(git.stdout).text(),errors=new Response(git.stderr).text();
    for(let n=0;n<272;n++){git.stdin.write(chunk);await git.stdin.flush();}git.stdin.end();
    const code=await git.exited;if(code!==0)throw Error(await errors);console.log(await output);`;
  const started=performance.now();
  const seeded=await boundary.run({argv:[process.execPath,"--config=/dev/null","-e",program],env,credentials:false,gate:"exclusive",
    purpose:"Odysseus large packing fixture",packingAllowanceBytes:512*1024**2,outputAreas:[".git"]});
  if(seeded.exitCode!==0)throw Error(`NATIVE_PACKING_SEED: ${seeded.stderr}`);
  const result=await boundary.run({argv:[...cli,"maintain","--json"],env,credentials:true,gate:"exclusive",purpose:"Odysseus native packing proof"});
  const report=JSON.parse(result.stdout) as {step:string;result:string}[];
  const git=report.find(row=>row.step==="git");
  if(!git || !/^ok — packed [1-9][0-9]* loose object\(s\)/.test(git.result))throw Error(`NATIVE_DEDICATED_PACKING_PROGRESS: ${JSON.stringify({report,stderr:result.stderr})}`);
  const check=await boundary.run({argv:[...cli,"storage","pack","--dry-run","--json"],env,credentials:false,gate:"shared",publish:false,purpose:"Odysseus packing garbage proof"});
  const value=JSON.parse(check.stdout);
  if(check.exitCode!==0 || value.garbage?.count!==0)throw Error(`NATIVE_PACKING_NO_GARBAGE: ${check.stdout}`);
  const counts=await boundary.run({argv:["git","count-objects","-v"],env,credentials:false,gate:"shared",publish:false,purpose:"Odysseus packed object proof"});
  if(counts.exitCode!==0 || !/^count: 0$/m.test(counts.stdout) || !/^garbage: 0$/m.test(counts.stdout))throw Error(`NATIVE_PACKING_LOOSE_OBJECTS_DRAINED: ${counts.stdout}`);
  const installed=await boundary.run({argv:[process.execPath,"--config=/dev/null","-e",
    'const fs=require("node:fs");console.log(JSON.stringify(fs.readdirSync(".git/objects/pack").filter(n=>n.endsWith(".pack")).map(n=>({name:n,bytes:fs.statSync(".git/objects/pack/"+n).size}))));'],
    env,credentials:false,gate:"shared",publish:false,purpose:"Odysseus individual installed pack proof"});
  if(installed.exitCode!==0)throw Error(`NATIVE_PACKING_INSTALLED_FILES: ${installed.stderr}`);
  const packs=JSON.parse(installed.stdout) as {name:string;bytes:number}[];
  if(!Array.isArray(packs) || !packs.every(pack=>Number.isSafeInteger(pack.bytes)&&pack.bytes>=0)
    || !packs.some(pack=>pack.bytes>256*1024**2))throw Error("NATIVE_PACKING_OUTPUT_EXCEEDS_GENERIC_STAGE");
  const receipt={bytes,packBytes:Math.max(...packs.map(pack=>pack.bytes)),packs,elapsedMs:performance.now()-started,git:git.result,garbage:value.garbage,plan:value.headroom};
  return receipt;
}
