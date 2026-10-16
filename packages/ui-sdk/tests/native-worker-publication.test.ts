/** Actual async publication over copied acquisition metadata; native storage is qualified separately. */
import { expect,spyOn,test } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";
import { prepareNativeWorkerStartupView } from "../src/server/worker-startup-view.js";
import { prepareNativeWorkerOutput } from "../src/server/worker-native-output.js";
import type { NativeStageChange } from "../src/server/native-brain-manager-protocol.js";

test("ignored derived DB byte preparation stays in its validated existing destination parent",async()=>{
 const store=fs.mkdtempSync("/tmp/odysseus-publication-parent-"),brain=join(store,"brain"),sourceUuid="11111111111141118111111111111790",uuid="22222222222242228222222222221790";
 fs.mkdirSync(join(brain,".brain"),{recursive:true});fs.writeFileSync(join(brain,".gitignore"),".brain/\n");fs.writeFileSync(join(brain,".brain/brain.db"),"Odysseus old projection");
 const statfs=fs.statfsSync,pretend=spyOn(fs,"statfsSync").mockImplementation(((path:any,options:any)=>{const value=statfs(path,options);return {...value,type:typeof value.type==="bigint"?0x9123683en:0x9123683e};}) as typeof fs.statfsSync);
 const checkpoints=new Map<string,string>();
 const start=fs.readFileSync(`/proc/${process.pid}/stat`,"utf8").replace(/^.*\) /s,"").split(" ")[19]!;
 const manager={
  async checkpoint(id:string){const path=join(store,".brain-native/checkpoints",id);fs.cpSync(brain,path,{recursive:true});checkpoints.set(id,path);return {id,path,sourceUuid,uuid,fsid:"11111111-1111-4111-8111-111111111790",rootId:"257",transaction:"8",readOnly:true as const};},
  async release(id:string){fs.rmSync(checkpoints.get(id)!,{recursive:true,force:true});return{id,state:"deleted" as const};},
  async prepareStage(id:string,checkpointId:string,allowanceBytes:number){const path=join(store,".brain-native/stages",id);fs.mkdirSync(path,{recursive:true});fs.cpSync(checkpoints.get(checkpointId)!,join(path,"merged"),{recursive:true});const info=fs.statSync(path,{bigint:true});return{id,path,checkpointId,checkpointUuid:uuid,sourceUuid,allowanceBytes,namespacePid:process.pid,namespaceStart:start,appUid:process.getuid!(),appGid:process.getgid!(),rootDevice:String(info.dev),rootInode:String(info.ino)};},
  async inspectStage(){return{checkpointId:[...checkpoints.keys()][0]!,checkpointUuid:uuid,changes:(async function*(){yield {pathHex:Buffer.from(".brain").toString("hex"),kind:"entry"} as NativeStageChange;yield {pathHex:Buffer.from(".brain/brain.db").toString("hex"),kind:"entry"} as NativeStageChange;})(),completed:Promise.resolve({exitCode:0 as const,bytes:0})};},
  async releaseStage(id:string){fs.rmSync(join(store,".brain-native/stages",id),{recursive:true,force:true});return{id,state:"deleted" as const};},
 };
 const view=await prepareNativeWorkerStartupView(brain,manager);let output:Awaited<ReturnType<typeof prepareNativeWorkerOutput>>|undefined,timer:ReturnType<typeof setInterval>|undefined;
 try{
  output=await prepareNativeWorkerOutput(brain,{startupView:view});const bytes=16*1024**2;fs.writeFileSync(join(output.output.source,".brain/brain.db"),Buffer.alloc(bytes,79));fs.chmodSync(join(output.output.source,".brain"),0o750);
  const rootTemps=new Set<string>(),parentTemps=new Set<string>();timer=setInterval(()=>{for(const name of fs.readdirSync(brain))if(name.startsWith(".maintenance-"))rootTemps.add(name);for(const name of fs.readdirSync(join(brain,".brain")))if(name.startsWith(".maintenance-"))parentTemps.add(name);},1);
  await output.publish();clearInterval(timer);timer=undefined;
  expect(rootTemps.size,"IGNORED_DERIVED_DB_TEMP_STAYS_IN_DESTINATION_PARENT").toBe(0);
  expect(parentTemps.size,"ASYNC_PREPARATION_WAS_ACTUALLY_OBSERVED").toBe(1);
  expect(fs.statSync(join(brain,".brain/brain.db")).size).toBe(bytes);
  expect(fs.statSync(join(brain,".brain")).mode & 0o777,"DIRECTORY_MODE_FINALIZES_AFTER_PARENT_LOCAL_COPY").toBe(0o750);
  expect(fs.readdirSync(join(brain,".brain")).filter(name=>name.startsWith(".maintenance-"))).toEqual([]);
 }finally{clearInterval(timer);await output?.cleanup();await view.cleanup();pretend.mockRestore();fs.rmSync(store,{recursive:true,force:true});}
});


for (const rel of ["context", ".git", "notes"]) test(`native host publication ${rel === "notes" ? "permits ordinary directory deletion" : `preserves protected ancestor ${rel}`}`,async()=>{
 const store=fs.mkdtempSync("/tmp/odysseus-publication-parent-"),brain=join(store,"brain"),sourceUuid="11111111111141118111111111111790",uuid="22222222222242228222222222221790";
 fs.mkdirSync(join(brain,rel),{recursive:true});fs.writeFileSync(join(brain,".athena.md"),"Athena original");
 const statfs=fs.statfsSync,pretend=spyOn(fs,"statfsSync").mockImplementation(((path:any,options:any)=>{const value=statfs(path,options);return {...value,type:typeof value.type==="bigint"?0x9123683en:0x9123683e};}) as typeof fs.statfsSync);
 const checkpoints=new Map<string,string>();
 const start=fs.readFileSync(`/proc/${process.pid}/stat`,"utf8").replace(/^.*\) /s,"").split(" ")[19]!;
 const manager={
  async checkpoint(id:string){const path=join(store,".brain-native/checkpoints",id);fs.cpSync(brain,path,{recursive:true});checkpoints.set(id,path);return {id,path,sourceUuid,uuid,fsid:"11111111-1111-4111-8111-111111111790",rootId:"257",transaction:"8",readOnly:true as const};},
  async release(id:string){fs.rmSync(checkpoints.get(id)!,{recursive:true,force:true});return{id,state:"deleted" as const};},
  async prepareStage(id:string,checkpointId:string,allowanceBytes:number){const path=join(store,".brain-native/stages",id);fs.mkdirSync(path,{recursive:true});fs.cpSync(checkpoints.get(checkpointId)!,join(path,"merged"),{recursive:true});const info=fs.statSync(path,{bigint:true});return{id,path,checkpointId,checkpointUuid:uuid,sourceUuid,allowanceBytes,namespacePid:process.pid,namespaceStart:start,appUid:process.getuid!(),appGid:process.getgid!(),rootDevice:String(info.dev),rootInode:String(info.ino)};},
  async inspectStage(){return{checkpointId:[...checkpoints.keys()][0]!,checkpointUuid:uuid,changes:(async function*(){yield {pathHex:Buffer.from(".athena.md").toString("hex"),kind:"entry"} as NativeStageChange;yield {pathHex:Buffer.from(rel).toString("hex"),kind:"whiteout"} as NativeStageChange;})(),completed:Promise.resolve({exitCode:0 as const,bytes:0})};},
  async releaseStage(id:string){fs.rmSync(join(store,".brain-native/stages",id),{recursive:true,force:true});return{id,state:"deleted" as const};},
 };
 const view=await prepareNativeWorkerStartupView(brain,manager);let output:Awaited<ReturnType<typeof prepareNativeWorkerOutput>>|undefined;
 try {
  output=await prepareNativeWorkerOutput(brain,{startupView:view});
  fs.rmdirSync(join(output.output.source,rel));fs.writeFileSync(join(output.output.source,".athena.md"),"Athena updated");
  if (rel === "notes") {
   await output.publish();
   expect(fs.existsSync(join(brain,rel)),"ORDINARY_EMPTY_DIRECTORY_DELETION_STILL_PUBLISHES").toBe(false);
   expect(fs.readFileSync(join(brain,".athena.md"),"utf8")).toBe("Athena updated");
  } else {
   await expect(output.publish(),"HOST_PUBLICATION_CANNOT_REMOVE_PROTECTED_ANCESTOR").rejects.toThrow("protected input");
   expect(fs.statSync(join(brain,rel)).isDirectory(),"PROTECTED_ANCESTOR_REMAINS_IN_LIVE_BRAIN").toBe(true);
   expect(fs.readFileSync(join(brain,".athena.md"),"utf8"),"PROTECTED_ANCESTOR_REFUSAL_PRECEDES_ALL_PUBLICATION").toBe("Athena original");
  }
 } finally {await output?.cleanup();await view.cleanup();pretend.mockRestore();fs.rmSync(store,{recursive:true,force:true});}
});
