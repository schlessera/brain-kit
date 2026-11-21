/** Real publisher and Git objects; acquisition alone uses owned copied roots. */
import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { prepareNativeWorkerStartupView } from "../src/server/worker-startup-view.js";
import { prepareNativeWorkerOutput } from "../src/server/worker-native-output.js";
import type { NativeStageChange } from "../src/server/native-brain-manager-protocol.js";
import { packRepository } from "../../core/src/lib/git-storage.js";

for (const interrupt of [false,".idx",".pack"] as const) test(`replacement packs precede loose-object removal, interrupted=${interrupt}`,async()=>{
 const root=fs.mkdtempSync(join(tmpdir(),"odysseus-pack-publication-")),brain=join(root,"brain");fs.mkdirSync(brain);
 const git=(directory:string,...args:string[])=>Bun.spawnSync(["git","-C",directory,...args],{stdout:"pipe",stderr:"pipe"});
 expect(git(brain,"init","-q").exitCode).toBe(0);
 const blob=Bun.spawnSync(["git","-C",brain,"hash-object","-w","--stdin"],{stdin:Buffer.from("Odysseus retains the harbour chart."),stdout:"pipe",stderr:"pipe"});expect(blob.exitCode).toBe(0);
 const hash=blob.stdout.toString().trim(),loose=join(brain,".git/objects",hash.slice(0,2),hash.slice(2));
 expect(git(brain,"update-ref","refs/odysseus/chart",hash).exitCode).toBe(0);
 const actualStat=fs.statfsSync,stat=spyOn(fs,"statfsSync").mockImplementation(((...args:any[])=>{const value=Reflect.apply(actualStat,fs,args);return {...value,type:typeof value.type==="bigint"?0x9123683en:0x9123683e};}) as typeof fs.statfsSync);
 const checkpoints=new Map<string,string>(),uuid="a".repeat(32),sourceUuid="b".repeat(32);
 let stageRoot="",lowerId="";
 const start=fs.readFileSync(`/proc/${process.pid}/stat`,"utf8").replace(/^.*\) /s,"").split(" ")[19]!;
 const files=(directory:string,prefix=""):string[]=>fs.readdirSync(join(directory,prefix),{withFileTypes:true}).flatMap(entry=>{const rel=prefix+entry.name;return entry.isDirectory()?[rel,...files(directory,rel+"/")]:[rel];});
 const manager={
  async checkpoint(id:string){const path=join(root,".brain-native/checkpoints",id);fs.cpSync(brain,path,{recursive:true});checkpoints.set(id,path);return {id,path,uuid,sourceUuid,fsid:"11111111-1111-4111-8111-111111111790",rootId:"257",transaction:"1",readOnly:true as const};},
  async release(id:string){fs.rmSync(checkpoints.get(id)!,{recursive:true,force:true});return{id,state:"deleted" as const};},
  async prepareStage(id:string,checkpointId:string,allowanceBytes:number){stageRoot=join(root,".brain-native/stages",id);lowerId=checkpointId;fs.cpSync(checkpoints.get(checkpointId)!,join(stageRoot,"merged"),{recursive:true});const info=fs.statSync(stageRoot,{bigint:true});return{id,path:stageRoot,checkpointId,checkpointUuid:uuid,sourceUuid,allowanceBytes,namespacePid:process.pid,namespaceStart:start,appUid:process.getuid!(),appGid:process.getgid!(),rootDevice:String(info.dev),rootInode:String(info.ino)};},
  async inspectStage(){const source=join(stageRoot,"merged"),before=files(checkpoints.get(lowerId)!),after=new Set(files(source));return{checkpointId:lowerId,checkpointUuid:uuid,changes:(async function*(){for(const rel of new Set([...before,...after]))yield {pathHex:Buffer.from(rel).toString("hex"),kind:after.has(rel)?"entry":"whiteout"} as NativeStageChange;})(),completed:Promise.resolve({exitCode:0 as const,bytes:0})};},
  async releaseStage(id:string){fs.rmSync(join(root,".brain-native/stages",id),{recursive:true,force:true});return{id,state:"deleted" as const};},
 };
 let view:Awaited<ReturnType<typeof prepareNativeWorkerStartupView>>|undefined,output:Awaited<ReturnType<typeof prepareNativeWorkerOutput>>|undefined,link:ReturnType<typeof spyOn>|undefined;
 try{
  view=await prepareNativeWorkerStartupView(brain,manager);output=await prepareNativeWorkerOutput(brain,{startupView:view,areas:[".git"]});
  packRepository(output.output.source);
  const original=fs.linkSync;
  link=spyOn(fs,"linkSync").mockImplementation((from,to)=>{
   if(String(to).endsWith(".idx")){
    expect(fs.existsSync(loose),"LOOSE_OBJECT_SURVIVES_UNTIL_REPLACEMENT_INDEX").toBe(true);

   }
   if(interrupt && String(to).endsWith(interrupt))throw Error("Ithaca pack publication fault");
   return original(from,to);
  });
  if(interrupt)await expect(output.publish()).rejects.toThrow("Ithaca pack publication fault");else await output.publish();
  expect(git(brain,"cat-file","-e",hash).exitCode,"LIVE_REF_NEVER_LOSES_ITS_OBJECT").toBe(0);
  expect(fs.readdirSync(join(brain,".git/objects/pack")).some(name=>name.endsWith(".pack")),"REPLACEMENT_PACK_INSTALLED_BEFORE_DELETE").toBe(!interrupt);
  if(interrupt)expect(fs.readdirSync(join(brain,".git/objects/pack")),"FAILED_INSTALL_PUBLISHES_NO_PACK_GARBAGE").toEqual([]);
  expect(fs.existsSync(loose)).toBe(Boolean(interrupt));
  expect(git(brain,"count-objects","-v").stdout.toString(),"FAILED_PUBLICATION_LEAVES_NO_GIT_GARBAGE").toMatch(/^garbage: 0$/m);
 }finally{link?.mockRestore();await output?.cleanup();await view?.cleanup();stat.mockRestore();fs.rmSync(root,{recursive:true,force:true});}
});
