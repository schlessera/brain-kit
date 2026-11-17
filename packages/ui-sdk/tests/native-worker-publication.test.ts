/** Actual async publication over copied acquisition metadata; native storage is qualified separately. */
import { expect,spyOn,test } from "bun:test";
import * as fs from "node:fs";
import { dirname, join } from "node:path";
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


for (const rel of ["context", ".git", "notes", "group", "group/private"]) test(`native host publication ${rel === "notes" ? "permits ordinary directory deletion" : rel.startsWith("group") ? `retains provider folder ${rel}` : `preserves protected ancestor ${rel}`}`,async()=>{
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
  output=await prepareNativeWorkerOutput(brain,{startupView:view,folderPaths:["group/private"]});
  fs.rmdirSync(join(output.output.source,rel));fs.writeFileSync(join(output.output.source,".athena.md"),"Athena updated");
  if (rel === "notes") {
   await output.publish();
   expect(fs.existsSync(join(brain,rel)),"ORDINARY_EMPTY_DIRECTORY_DELETION_STILL_PUBLISHES").toBe(false);
   expect(fs.readFileSync(join(brain,".athena.md"),"utf8")).toBe("Athena updated");
  } else {
   await expect(output.publish(),rel.startsWith("group") ? "HOST_PUBLICATION_CANNOT_REMOVE_RETAINED_PROVIDER_FOLDER" : "HOST_PUBLICATION_CANNOT_REMOVE_PROTECTED_ANCESTOR").rejects.toThrow(rel.startsWith("group") ? "retained provider folder topology" : "protected input");
   expect(fs.statSync(join(brain,rel)).isDirectory(),"PROTECTED_ANCESTOR_REMAINS_IN_LIVE_BRAIN").toBe(true);
   expect(fs.readFileSync(join(brain,".athena.md"),"utf8"),"PROTECTED_ANCESTOR_REFUSAL_PRECEDES_ALL_PUBLICATION").toBe("Athena original");
  }
 } finally {await output?.cleanup();await view.cleanup();pretend.mockRestore();fs.rmSync(store,{recursive:true,force:true});}
});

// #2878: a worker's `brain_search` holds a real read-only connection on the
// live index. SQLite writes that connection's read mark into `brain.db-shm`,
// so the live sidecar's bytes differ from the checkpoint's although nothing
// indexed changed. Each SQLite connection runs in its own process, as in a
// hosted brain, so its locks and shared-memory mapping are not the test's.
const INDEX = ".brain-index/brain.db", CONNECTION = join(import.meta.dir, "fixtures/index-sqlite-connection.ts");
const CHILD = [process.execPath, "--no-env-file", "--preload", join(import.meta.dir, "../../../scripts/test-network-child-preload.ts"), CONNECTION];
function sqlite(mode: "seed" | "write" | "read", path: string, value?: string) {
 const result = Bun.spawnSync([...CHILD, mode, path, ...(value ? [value] : [])], { env: { PATH: process.env.PATH }, stdout: "pipe", stderr: "pipe" });
 expect(result.exitCode, result.stderr.toString()).toBe(0);
 return result.stdout.toString().trim();
}
async function holdReader(path: string, mode: "hold" | "pin" = "hold") {
 const child = Bun.spawn([...CHILD, mode, path], { env: { PATH: process.env.PATH }, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
 const lines = child.stdout.getReader(), stderr = new Response(child.stderr).text();
 const first = await lines.read();
 expect(new TextDecoder().decode(first.value).trim(), "READONLY_CONNECTION_READ_THE_LIVE_INDEX").toBe(JSON.stringify({ value: "Ogygia" }));
 return { alive: () => child.exitCode === null, async stop() { child.stdin.end(); const code = await child.exited; await lines.cancel(); expect(code, await stderr).toBe(0); } };
}
async function indexPublication(interleave: (paths: { live: string; checkpoint: string; stage: string }) => Promise<(() => Promise<void>) | void>, options: { withoutShm?: boolean; beforeCheckpoint?: (live: string) => Promise<() => Promise<void>> } = {}) {
 const store=fs.mkdtempSync("/tmp/odysseus-index-publication-"),brain=join(store,"brain"),sourceUuid="11111111111141118111111111111790",uuid="22222222222242228222222222221790";
 fs.mkdirSync(join(brain,"notes"),{recursive:true});fs.writeFileSync(join(brain,"notes/odysseus.md"),"Odysseus leaves Ogygia");
 sqlite("seed",join(brain,INDEX));if(options.withoutShm)fs.rmSync(join(brain,`${INDEX}-shm`));
 const statfs=fs.statfsSync,pretend=spyOn(fs,"statfsSync").mockImplementation(((path:any,options:any)=>{const value=statfs(path,options);return {...value,type:typeof value.type==="bigint"?0x9123683en:0x9123683e};}) as typeof fs.statfsSync);
 const checkpoints=new Map<string,string>(),family=["brain.db","brain.db-wal","brain.db-shm","brain.db-journal"].map(name=>`.brain-index/${name}`);
 const start=fs.readFileSync(`/proc/${process.pid}/stat`,"utf8").replace(/^.*\) /s,"").split(" ")[19]!;
 const manager={
  async checkpoint(id:string){const path=join(store,".brain-native/checkpoints",id);fs.cpSync(brain,path,{recursive:true});checkpoints.set(id,path);return {id,path,sourceUuid,uuid,fsid:"11111111-1111-4111-8111-111111111790",rootId:"257",transaction:"8",readOnly:true as const};},
  async release(id:string){fs.rmSync(checkpoints.get(id)!,{recursive:true,force:true});return{id,state:"deleted" as const};},
  async prepareStage(id:string,checkpointId:string,allowanceBytes:number){const path=join(store,".brain-native/stages",id);fs.mkdirSync(path,{recursive:true});fs.cpSync(checkpoints.get(checkpointId)!,join(path,"merged"),{recursive:true});const info=fs.statSync(path,{bigint:true});return{id,path,checkpointId,checkpointUuid:uuid,sourceUuid,allowanceBytes,namespacePid:process.pid,namespaceStart:start,appUid:process.getuid!(),appGid:process.getgid!(),rootDevice:String(info.dev),rootInode:String(info.ino)};},
  async inspectStage(){return{checkpointId:[...checkpoints.keys()][0]!,checkpointUuid:uuid,changes:(async function*(){for(const rel of [...family,"notes/odysseus.md"])yield {pathHex:Buffer.from(rel).toString("hex"),kind:"entry"} as NativeStageChange;})(),completed:Promise.resolve({exitCode:0 as const,bytes:0})};},
  async releaseStage(id:string){fs.rmSync(join(store,".brain-native/stages",id),{recursive:true,force:true});return{id,state:"deleted" as const};},
 };
 let early:(()=>Promise<void>)|undefined,view:Awaited<ReturnType<typeof prepareNativeWorkerStartupView>>|undefined,output:Awaited<ReturnType<typeof prepareNativeWorkerOutput>>|undefined,stop:(()=>Promise<void>)|void=undefined;
 try {
  early=await options.beforeCheckpoint?.(brain);
  view=await prepareNativeWorkerStartupView(brain,manager);
  output=await prepareNativeWorkerOutput(brain,{startupView:view});
  // The maintenance worker's refresh: a real writer on the stage's index, then the note it indexed.
  sqlite("write",join(output.output.source,INDEX),"Ithaca");fs.writeFileSync(join(output.output.source,"notes/odysseus.md"),"Odysseus reaches Ithaca");
  stop=await interleave({live:brain,checkpoint:view.root,stage:output.output.source});
  const live=()=>JSON.stringify([...family,"notes/odysseus.md"].map(rel=>{const path=join(brain,rel),info=fs.lstatSync(path,{throwIfNoEntry:false});
   return info?.isSymbolicLink()?["link",fs.readlinkSync(path)]:info?["file",fs.readFileSync(path).toString("hex")]:undefined;}));
  const before=live();let failure:unknown;try{await output.publish();}catch(error){failure=error;}
  // A new connection while every earlier reader is still open.
  const attempt=failure?undefined:Bun.spawnSync([...CHILD,"read",join(brain,INDEX)],{env:{PATH:process.env.PATH},stdout:"pipe",stderr:"pipe"});
  const fresh=attempt&&(attempt.exitCode===0?attempt.stdout.toString().trim():attempt.stderr.toString().match(/SQLITE_[A-Z_]+/)?.[0]??`exit ${attempt.exitCode}`);
  return {failure,brain,unchanged:before===live(),fresh,note:()=>fs.readFileSync(join(brain,"notes/odysseus.md"),"utf8")};
 } finally {try{await stop?.();await early?.();}finally{await output?.cleanup();await view?.cleanup();pretend.mockRestore();}}
}

for (const [name,options] of [
 ["holds",{}],["creates an absent sidecar while it holds",{withoutShm:true}],["holds while the refresh removed its sidecar",{removeStageShm:true}],
] as const) test(`a concurrent read-only index connection that ${name} does not refuse the refreshed index`,async()=>{
 let reader:Awaited<ReturnType<typeof holdReader>>|undefined,overlapped=false,shmChanged=false;
 const result=await indexPublication(async({live,checkpoint,stage})=>{
  if("removeStageShm" in options)fs.rmSync(join(stage,`${INDEX}-shm`));
  reader=await holdReader(join(live,INDEX));
  const before=fs.existsSync(join(checkpoint,`${INDEX}-shm`))?fs.readFileSync(join(checkpoint,`${INDEX}-shm`)):undefined;
  shmChanged=!before||!fs.readFileSync(join(live,`${INDEX}-shm`)).equals(before);
  return async()=>{overlapped=reader!.alive();await reader!.stop();};
 },"withoutShm" in options?{withoutShm:true}:{});
 try {
  expect(shmChanged,"REAL_READONLY_CONNECTION_CHANGED_LIVE_SHM").toBe(true);
  expect(result.failure,"READONLY_SEARCH_MUST_NOT_BLOCK_INDEX_REFRESH").toBeUndefined();
  expect(overlapped,"READONLY_CONNECTION_OVERLAPPED_PUBLICATION").toBe(true);
  expect(result.fresh,"REFRESHED_INDEX_IS_VISIBLE_TO_A_NEW_CONNECTION").toBe(JSON.stringify({value:"Ithaca"}));
  expect(result.note()).toBe("Odysseus reaches Ithaca");
 } finally {fs.rmSync(dirname(result.brain),{recursive:true,force:true});}
});

for (const removed of [false,true]) test(`the refreshed index never shares a wal-index an earlier reader still holds${removed?" after the refresh removed its sidecar":""}`,async()=>{
 // A search still inside its read transaction keeps the last writer's
 // checkpoint from resetting the live WAL, so the wal-index that reader holds
 // describes frames. The refresh's own writer checkpoints and truncates its WAL.
 const result=await indexPublication(async({stage})=>{if(removed)fs.rmSync(join(stage,`${INDEX}-shm`));},{beforeCheckpoint:async live=>{
  const reader=await holdReader(join(live,INDEX),"pin");sqlite("write",join(live,INDEX),"Aeaea");
  expect(fs.statSync(join(live,`${INDEX}-wal`)).size,"LIVE_WAL_KEEPS_UNCHECKPOINTED_FRAMES").toBeGreaterThan(0);
  return ()=>reader.stop();
 }});
 try {
  expect(result.failure,"READONLY_SEARCH_MUST_NOT_BLOCK_INDEX_REFRESH").toBeUndefined();
  expect(result.fresh,"NEW_CONNECTION_READS_THE_REFRESH_NOT_THE_OLD_WAL_INDEX").toBe(JSON.stringify({value:"Ithaca"}));
 } finally {fs.rmSync(dirname(result.brain),{recursive:true,force:true});}
});

for (const [name,interleave,refusal] of [
 ["a concurrent index writer",async({live}:{live:string})=>{sqlite("write",join(live,INDEX),"Scheria");},/^stale maintenance output: \.brain-index\/brain\.db(-wal)?$/],
 ["a concurrent note writer",async({live}:{live:string})=>{fs.writeFileSync(join(live,"notes/odysseus.md"),"Odysseus reaches Scheria");},/^stale maintenance output: notes\/odysseus\.md$/],
 ["a link planted over the shared-memory sidecar",async({live}:{live:string})=>{fs.rmSync(join(live,`${INDEX}-shm`));fs.symlinkSync("../notes/odysseus.md",join(live,`${INDEX}-shm`));},/^stale maintenance output: \.brain-index\/brain\.db-shm$/],
] as const) test(`native index publication still refuses ${name}`,async()=>{
 const result=await indexPublication(interleave);
 try {
  expect(result.failure,"OTHER_CONCURRENT_OUTPUT_CHANGE_STILL_REFUSES").toBeInstanceOf(Error);
  expect((result.failure as Error).message).toMatch(refusal);
  expect(result.unchanged,"REFUSAL_PUBLISHED_NO_INDEX_OR_NOTE_BYTES").toBe(true);
 } finally {fs.rmSync(dirname(result.brain),{recursive:true,force:true});}
});
