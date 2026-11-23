/** Explicit copied acquisition; tests call the production native publisher. */
import { spyOn } from "bun:test";
import * as fs from "node:fs";
import {join} from "node:path";
import {prepareNativeWorkerStartupView} from "../../src/server/worker-startup-view.js";
import {prepareNativeWorkerOutput} from "../../src/server/worker-native-output.js";
import type { NativeStageChange } from "../../src/server/native-brain-manager-protocol.js";
export async function nativeOutputFixture(root:string,brain:string,extraChanges:NativeStageChange[]=[]) {
 const actualStat=fs.statfsSync,stat=spyOn(fs,"statfsSync").mockImplementation(((...args:any[])=>{const value=Reflect.apply(actualStat,fs,args);return {...value,type:typeof value.type==="bigint"?0x9123683en:0x9123683e};}) as typeof fs.statfsSync);
 const checkpoints=new Map<string,string>(),uuid="a".repeat(32),sourceUuid="b".repeat(32);
 let stageRoot="",lowerId="";
 const start=fs.readFileSync(`/proc/${process.pid}/stat`,"utf8").replace(/^.*\) /s,"").split(" ")[19]!;
 const files=(directory:string,prefix=""):string[]=>fs.readdirSync(join(directory,prefix),{withFileTypes:true}).flatMap(entry=>{const rel=prefix+entry.name;return entry.isDirectory()?[rel,...files(directory,rel+"/")]:[rel];});
 const manager={
  async checkpoint(id:string){const path=join(root,".brain-native/checkpoints",id);fs.cpSync(brain,path,{recursive:true});checkpoints.set(id,path);return {id,path,uuid,sourceUuid,fsid:"11111111-1111-4111-8111-111111111790",rootId:"257",transaction:"1",readOnly:true as const};},
  async release(id:string){fs.rmSync(checkpoints.get(id)!,{recursive:true,force:true});return{id,state:"deleted" as const};},
  async prepareStage(id:string,checkpointId:string,allowanceBytes:number){stageRoot=join(root,".brain-native/stages",id);lowerId=checkpointId;fs.cpSync(checkpoints.get(checkpointId)!,join(stageRoot,"merged"),{recursive:true});const info=fs.statSync(stageRoot,{bigint:true});return{id,path:stageRoot,checkpointId,checkpointUuid:uuid,sourceUuid,allowanceBytes,namespacePid:process.pid,namespaceStart:start,appUid:process.getuid!(),appGid:process.getgid!(),rootDevice:String(info.dev),rootInode:String(info.ino)};},
  async inspectStage(){const source=join(stageRoot,"merged"),before=files(checkpoints.get(lowerId)!),after=new Set(files(source));return{checkpointId:lowerId,checkpointUuid:uuid,changes:(async function*(){yield* extraChanges;for(const rel of new Set([...before,...after]))yield {pathHex:Buffer.from(rel).toString("hex"),kind:after.has(rel)?"entry":"whiteout"} as NativeStageChange;})(),completed:Promise.resolve({exitCode:0 as const,bytes:0})};},
  async releaseStage(id:string){fs.rmSync(join(root,".brain-native/stages",id),{recursive:true,force:true});return{id,state:"deleted" as const};},
 };

 const view=await prepareNativeWorkerStartupView(brain,manager);
 const output=await prepareNativeWorkerOutput(brain,{startupView:view,areas:[".git",".brain-index","registry.md",".brain/scratch"]});
 return {output,view,manager,async close(){await output.cleanup();await view.cleanup();stat.mockRestore();}};
}
