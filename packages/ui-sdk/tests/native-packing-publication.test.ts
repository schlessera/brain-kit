/** Real publisher and Git objects; acquisition alone uses owned copied roots. */
import {watchdogMs} from "../../../scripts/test-deadlines.js";
import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {packingFixture} from "./helpers/native-packing-fixture.js";
import * as packDirectory from "../src/server/maintenance-pack-directory.js";
import { packRepository } from "../../core/src/lib/git-storage.js";

for (const interrupt of [false,".idx",".pack","multi-pack-index","flush"] as const) test(`replacement packs precede loose-object removal, interrupted=${interrupt}`,async()=>{
 const root=fs.mkdtempSync(join(tmpdir(),"odysseus-pack-publication-")),brain=join(root,"brain");fs.mkdirSync(brain);
 const git=(directory:string,...args:string[])=>Bun.spawnSync(["git","-C",directory,...args],{stdout:"pipe",stderr:"pipe"});
 expect(git(brain,"init","-q").exitCode).toBe(0);
 const blob=Bun.spawnSync(["git","-C",brain,"hash-object","-w","--stdin"],{stdin:Buffer.from("Odysseus retains the harbour chart."),stdout:"pipe",stderr:"pipe"});expect(blob.exitCode).toBe(0);
 let hash=blob.stdout.toString().trim();
 expect(git(brain,"update-ref","refs/odysseus/chart",hash).exitCode).toBe(0);
 if(interrupt==="flush"){
  packRepository(brain);expect(git(brain,"multi-pack-index","write").exitCode).toBe(0);
  const added=Bun.spawnSync(["git","-C",brain,"hash-object","-w","--stdin"],{stdin:Buffer.from("Athena revises the chart."),stdout:"pipe",stderr:"pipe"});expect(added.exitCode).toBe(0);hash=added.stdout.toString().trim();
  expect(git(brain,"update-ref","refs/athena/chart",hash).exitCode).toBe(0);
 }
 const loose=join(brain,".git/objects",hash.slice(0,2),hash.slice(2));
 const fixture=await packingFixture(root,brain),output=fixture.output;
 let rename:ReturnType<typeof spyOn>|undefined,sync:ReturnType<typeof spyOn>|undefined,exchange:ReturnType<typeof spyOn>|undefined;
 try{
  packRepository(output.output.source);expect(git(output.output.source,"multi-pack-index","write").exitCode).toBe(0);
  const added=Bun.spawnSync(["git","-C",output.output.source,"hash-object","-w","--stdin"],{stdin:Buffer.from("Telemachus charts a new route."),stdout:"pipe",stderr:"pipe"});expect(added.exitCode).toBe(0);
  const newHash=added.stdout.toString().trim();expect(git(output.output.source,"update-ref","refs/telemachus/chart",newHash).exitCode).toBe(0);
  // The new ref points only into its new pack, never a live loose object.
  packRepository(output.output.source);
  const renameFile=fs.renameSync,syncFile=fs.fsyncSync,exchangeDirectory=packDirectory.renamePackDirectory;let exchanged=false;
  exchange=spyOn(packDirectory,"renamePackDirectory").mockImplementation((...args)=>{exchangeDirectory(...args);exchanged=true;});
  rename=spyOn(fs,"renameSync").mockImplementation((from,to)=>{
   if(String(to).endsWith(".idx"))expect(fs.existsSync(loose),"LOOSE_OBJECT_SURVIVES_UNTIL_REPLACEMENT_INDEX").toBe(true);
   if(interrupt!=="flush"&&interrupt&&String(to).endsWith(interrupt))throw Error("Ithaca pack publication fault");
   return renameFile(from,to);
  });
  if(interrupt==="flush")sync=spyOn(fs,"fsyncSync").mockImplementation(fd=>{if(exchanged){exchanged=false;throw Error("Ithaca metadata flush fault");}return syncFile(fd);});
  if(interrupt)await expect(output.publish()).rejects.toThrow(interrupt==="flush"?"Ithaca metadata flush fault":"Ithaca pack publication fault");else await output.publish();
  expect(git(brain,"cat-file","-e",hash).exitCode,"LIVE_REF_NEVER_LOSES_ITS_OBJECT").toBe(0);
  if(!interrupt){expect(git(brain,"rev-parse","refs/telemachus/chart").stdout.toString().trim()).toBe(newHash);expect(git(brain,"cat-file","-e",newHash).exitCode,"NEW_REF_HAS_OBJECT").toBe(0);}
  else expect(git(brain,"rev-parse","--verify","refs/telemachus/chart").exitCode,"FAILED_PACK_INSTALL_PUBLISHES_NO_REF").not.toBe(0);
  expect(fs.existsSync(loose)).toBe(Boolean(interrupt));
  if(interrupt==="flush")expect(fs.readdirSync(join(brain,".git/objects")).some(name=>name.startsWith(".brain-maintenance-")),"UNCONFIRMED_ACTIVATION_RETAINS_OLD_GENERATION").toBe(true);
  expect(git(brain,"count-objects","-v").stdout.toString(),"FAILED_PUBLICATION_LEAVES_NO_GIT_GARBAGE").toMatch(/^garbage: 0$/m);
 }finally{rename?.mockRestore();sync?.mockRestore();exchange?.mockRestore();await fixture.close();fs.rmSync(root,{recursive:true,force:true});}
});

for(const point of ["index","exchange"])test(`SIGKILL at ${point} leaves complete live packs and recoverable private files`,async()=>{
 const root=fs.mkdtempSync(join(tmpdir(),"odysseus-killed-pack-")),brain=join(root,"brain");fs.mkdirSync(brain);
 const git=(...args:string[])=>Bun.spawnSync(["git","-C",brain,...args],{stdout:"pipe",stderr:"pipe"});
 expect(git("init","-q").exitCode).toBe(0);
 const object=Bun.spawnSync(["git","-C",brain,"hash-object","-w","--stdin"],{stdin:Buffer.from("Odysseus retains Ithaca."),stdout:"pipe",stderr:"pipe"});
 expect(object.exitCode).toBe(0);const hash=object.stdout.toString().trim();expect(git("update-ref","refs/odysseus/ithaca",hash).exitCode).toBe(0);
 const child=Bun.spawn([process.execPath,join(import.meta.dir,"helpers/interrupted-pack-publisher.ts"),root,brain,point],{stdout:"pipe",stderr:"pipe",timeout:watchdogMs(10000)});
 try {
  const reader=child.stdout.getReader();const signal=await reader.read();
  expect(new TextDecoder().decode(signal.value),"REAL_PUBLISHER_REACHED_KILL_POINT").toBe("STOP\n");
  child.kill("SIGKILL");await child.exited;await reader.cancel();
  expect(child.signalCode).toBe("SIGKILL");
  expect(git("cat-file","-e",hash).exitCode,"KILL_RETAINS_LIVE_REF_OBJECT").toBe(0);
  expect(git("count-objects","-v").stdout.toString(),"KILL_LEAVES_NO_ORPHAN_INDEX_OR_TEMP").toMatch(/^garbage: 0$/m);
  const names=fs.readdirSync(join(brain,".git/objects/pack"));
  expect(names.some(name=>name.startsWith(".maintenance-"))).toBe(false);
  for(const name of names.filter(name=>name.endsWith(".idx")))expect(names).toContain(name.replace(/\.idx$/,".pack"));
  expect(fs.readdirSync(join(brain,".git/objects")).some(name=>name.startsWith(".brain-maintenance-"))).toBe(true);
  const objects=fs.openSync(join(brain,".git/objects"),fs.constants.O_RDONLY|fs.constants.O_DIRECTORY);
  try{packDirectory.recoverPackDirectories(objects);}finally{fs.closeSync(objects);}
  expect(fs.readdirSync(join(brain,".git/objects")).some(name=>name.startsWith(".brain-maintenance-")),"KILL_RECOVERY_DRAINS_PRIVATE_TRANSACTION").toBe(false);
  expect(git("cat-file","-e",hash).exitCode).toBe(0);
 }finally{if(child.exitCode===null){child.kill("SIGKILL");await child.exited;}fs.rmSync(root,{recursive:true,force:true});}
});

test("Git step receipts are bounded, execution-private and excluded from publication",async()=>{
 const root=fs.mkdtempSync(join(tmpdir(),"odysseus-git-receipt-")),brain=join(root,"brain");fs.mkdirSync(brain);
 expect(Bun.spawnSync(["git","-C",brain,"init","-q"]).exitCode).toBe(0);
 const fixture=await packingFixture(root,brain),output=fixture.output;
 try {
  expect(await output.gitSucceeded(),"ABSENT_GIT_RECEIPT_DISCARDS_OUTPUT").toBe(false);
  fs.writeFileSync(join(output.output.source,output.gitResultPath),"packed\n");
  expect(await output.gitSucceeded()).toBe(true);
  await output.publish();expect(fs.existsSync(join(brain,output.gitResultPath)),"GIT_RECEIPT_NEVER_PUBLISHED").toBe(false);
 }finally{await fixture.close();fs.rmSync(root,{recursive:true,force:true});}
});
