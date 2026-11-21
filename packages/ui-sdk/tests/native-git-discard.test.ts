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
