import {expect,test} from "bun:test";
import * as fs from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {nativeOutputFixture} from "./helpers/native-output-fixture.js";
for(const discard of [true,false])test(`production native publisher selects Git separately from ordinary outputs: discard=${discard}`,async()=>{
 const root=fs.mkdtempSync(join(tmpdir(),"odysseus-native-discard-")),brain=join(root,"brain");fs.mkdirSync(brain);
 for(const directory of [".git/objects/pack",".brain-index",".brain/scratch"])fs.mkdirSync(join(brain,directory),{recursive:true});
 for(const path of [".git/packed-refs",".git/removed",".brain-index/brain.db","registry.md",".brain/scratch/chart.txt"])fs.writeFileSync(join(brain,path),"Odysseus before");
 const fixture=await nativeOutputFixture(root,brain),output=fixture.output;
 try {
  for(const path of [".git/packed-refs",".git/objects/pack/tmp_pack_Ithaca",".brain-index/brain.db","registry.md",".brain/scratch/chart.txt"])fs.writeFileSync(join(output.output.source,path),"Athena after");
  fs.rmSync(join(output.output.source,".git/removed"));if(discard)output.discardGit();await output.publish();
  expect(fs.readFileSync(join(brain,".git/packed-refs"),"utf8"),"NATIVE_DISCARD_RETAINS_GIT_BYTES").toBe(discard?"Odysseus before":"Athena after");
  expect(fs.existsSync(join(brain,".git/removed")),"NATIVE_DISCARD_RETAINS_GIT_DELETION").toBe(discard);
  expect(fs.existsSync(join(brain,".git/objects/pack/tmp_pack_Ithaca")),"NATIVE_DISCARD_OMITS_NEW_GIT_FILE").toBe(!discard);
  for(const path of [".brain-index/brain.db","registry.md",".brain/scratch/chart.txt"])expect(fs.readFileSync(join(brain,path),"utf8"),"NATIVE_DISCARD_PUBLISHES_OTHER_AREAS").toBe("Athena after");
 }finally{await fixture.close();fs.rmSync(root,{recursive:true,force:true});}
});

test("discarding Git byte paths with invalid UTF-8 still publishes ordinary output",async()=>{
 const root=fs.mkdtempSync(join(tmpdir(),"odysseus-native-git-bytes-")),brain=join(root,"brain");fs.mkdirSync(join(brain,".git/refs/tags"),{recursive:true});
 fs.writeFileSync(join(brain,"registry.md"),"Odysseus before");
 // Sealed deletion metadata can name any Git filename byte, even though the
 // fixture's copied acquisition does not support copying such names itself.
 const pathHex=Buffer.concat([Buffer.from(".git/refs/tags/"),Buffer.from([0xff])]).toString("hex");
 const fixture=await nativeOutputFixture(root,brain,[{pathHex,kind:"whiteout"}]);
 try {
  fs.writeFileSync(join(fixture.output.output.source,"registry.md"),"Athena after");fixture.output.discardGit();
  await expect(fixture.output.publish(),"GIT_BYTE_PATH_DISCARD_DOES_NOT_DECODE").resolves.toBeUndefined();
  expect(fs.readFileSync(join(brain,"registry.md"),"utf8"),"GIT_BYTE_PATH_DISCARD_PRESERVES_OTHER_OUTPUT").toBe("Athena after");
 }finally{await fixture.close();fs.rmSync(root,{recursive:true,force:true});}
});

test("successful native publication adds a readable pack to the live Git directory",async()=>{
 const root=fs.mkdtempSync(join(tmpdir(),"odysseus-native-pack-success-")),brain=join(root,"brain");fs.mkdirSync(brain);
 const git=(directory:string,...args:string[])=>{
  const result=Bun.spawnSync(["git","-C",directory,...args],{stdin:Buffer.from("Ithaca harbour"),stdout:"pipe",stderr:"pipe",env:{PATH:process.env.PATH,GIT_CONFIG_GLOBAL:"/dev/null",GIT_CONFIG_NOSYSTEM:"1"}});
  expect(result.exitCode,result.stderr.toString()).toBe(0);return result.stdout.toString().trim();
 };
 git(brain,"init","-q");const hash=git(brain,"hash-object","-w","--stdin");
 const fixture=await nativeOutputFixture(root,brain);
 try {
  git(fixture.output.output.source,"maintenance","run","--task=loose-objects");
  git(fixture.output.output.source,"maintenance","run","--task=loose-objects");
  expect(fs.readdirSync(join(brain,".git/objects/pack"))).toEqual([]);
  await fixture.output.publish();
  const live=fs.readdirSync(join(brain,".git/objects/pack")),packs=live.filter(name=>name.endsWith(".pack"));
  expect(packs.length,"NATIVE_SUCCESS_PUBLISHES_LIVE_PACK").toBeGreaterThan(0);
  for(const pack of packs)expect(live).toContain(pack.replace(/\.pack$/,".idx"));
  expect(git(brain,"cat-file","blob",hash),"NATIVE_PUBLISHED_PACK_IS_READABLE").toBe("Ithaca harbour");
 }finally{await fixture.close();fs.rmSync(root,{recursive:true,force:true});}
});
