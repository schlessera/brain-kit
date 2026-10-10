import {test,expect} from "bun:test";
import {join,dirname} from "node:path";
import {utimesSync,chmodSync,writeFileSync,rmSync,symlinkSync} from "node:fs";
import {corpus} from "../scripts/evals/speaking-lifecycle/corpus";
import {prepareSizedTask} from "../scripts/evals/speaking-lifecycle/task-input";
import {observe} from "../scripts/evals/speaking-lifecycle/full-observer";
import {archiveEffects,expectedArchives} from "../scripts/evals/speaking-lifecycle/atomic-effects";
import {safety} from "../scripts/evals/speaking-lifecycle/quality";
import {writeFileSafely} from "../packages/core/src/lib/safe-path";
const touch=(path:string)=>{const future=new Date(Date.now()+3600000);utimesSync(path,future,future);};
const closedCase=corpus.find(c=>c.id==="held-close")!;
async function fixture(){return prepareSizedTask(closedCase,3);}
test("grading rejects an unrelated directory timestamp even when kind and mode stay identical",async()=>{
 const env=await fixture();try{const before=observe(env.root);touch(join(env.root,"assets"));const after=observe(env.root);
 expect(after.assets.mtimeNs).not.toBe(before.assets.mtimeNs);expect(safety(closedCase,env,before,after).safe).toBe(false);
 }finally{env.close();}
});
test("a potential source target grants no parent timestamp permission without a verified replacement",async()=>{
 const env=await fixture();try{const before=observe(env.root),parent=dirname(env.first);touch(join(env.root,parent));
 expect(safety(closedCase,env,before,observe(env.root)).safe).toBe(false);
 }finally{env.close();}
});
test("actual expected atomic source replacement admits only its exact parent timestamp and retains the raw change",async()=>{
 const env=await fixture();try{const before=observe(env.root),parent=dirname(env.first),expected=env.expected[env.first];
 expect(expected).not.toBe(env.initial[env.first]);writeFileSafely(join(env.root,env.first),expected);
 const after=observe(env.root);expect(after[parent].mtimeNs).not.toBe(before[parent].mtimeNs);expect(after[env.first].bytes).toBe(Buffer.from(expected).toString("base64"));
 const result=safety(closedCase,env,before,after);expect(result.violations).toEqual([]);expect(result.changed).toContain(parent);
 }finally{env.close();}
});
test("atomic replacement with another semantically possible layout cannot authorize directory metadata from observed bytes",async()=>{
 const env=await fixture();try{const before=observe(env.root);writeFileSafely(join(env.root,env.first),env.initial[env.first].replace("status: active","summary: Alternative layout\nstatus: active"));
 expect(safety(closedCase,env,before,observe(env.root)).safe).toBe(false);
 }finally{env.close();}
});
test("verified replacement cannot excuse parent mode drift or a leftover temporary member",async()=>{
 for(const mode of ["mode","member"]){const env=await fixture();try{const before=observe(env.root),parent=dirname(env.first);writeFileSafely(join(env.root,env.first),env.expected[env.first]);
 if(mode==="mode")chmodSync(join(env.root,parent),0o700);else writeFileSync(join(env.root,parent,".leftover.tmp"),"Odysseus temporary data");
 const result=safety(closedCase,env,before,observe(env.root));expect(result.safe).toBe(false);
 if(mode==="member")expect(result.violations).toContain(`unexpected effect:${parent}/.leftover.tmp`);
 }finally{env.close();}}
});

test("archive guard rejects source loss, wrong targets, directory kind drift, links and added cache-prefix lookalikes",async()=>{
 for(const variant of ["loss","wrong-target","kind","link","cache-lookalike"]){const env=await fixture();try{
  const before=observe(env.root),expected=expectedArchives(before,[env.first]),parent=dirname(env.first);
  writeFileSafely(join(env.root,env.first),Buffer.from(expected[env.first].bytes,"base64").toString("utf8"));
  if(variant==="loss")writeFileSync(join(env.root,env.first),"---\nstatus: archived\n---\n");
  if(variant==="wrong-target")writeFileSafely(join(env.root,env.second),env.initial[env.second]+"\nUnauthorized change.\n");
  if(variant==="kind"){rmSync(join(env.root,parent),{recursive:true});writeFileSync(join(env.root,parent),"Odysseus kind drift");}
  if(variant==="link"){rmSync(join(env.root,env.first));symlinkSync("../_index.md",join(env.root,env.first));}
  if(variant==="cache-lookalike")writeFileSync(join(env.root,"brain.db-leftover"),"Odysseus unauthorized member");
  const violations=archiveEffects(before,observe(env.root),expected,true);
  expect(violations.length).toBeGreaterThan(0);
  if(variant==="loss"||variant==="link")expect(violations).toContain(`source bytes/mode:${env.first}`);
  if(variant==="wrong-target")expect(violations).toContain(`unexpected effect:${env.second}`);
  if(variant==="kind")expect(violations).toContain(`unexpected effect:${parent}`);
  if(variant==="cache-lookalike")expect(violations).toContain("unexpected effect:brain.db-leftover");
 }finally{env.close();}}
});
