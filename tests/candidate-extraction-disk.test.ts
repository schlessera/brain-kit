import { expect,test } from "bun:test";
import { readFileSync,writeFileSync,chmodSync,symlinkSync,unlinkSync,linkSync,mkdtempSync,rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { stage,materialize,observe,cli } from "../scripts/evals/candidate-extraction/disk-fixture";
import { workload } from "../scripts/evals/candidate-extraction/workload";
import { ownedClosure,closureDigest } from "../scripts/evals/candidate-extraction/closure";
test("all neutral full brains retain exact source/context and never selection labels",()=>{
 expect(workload).toHaveLength(24);
 for(const c of workload){const f=stage(c);try{
  expect(readFileSync(join(f.root,"sources/notice.txt"),"utf8")).toBe(c.source);
  expect(JSON.parse(readFileSync(join(f.root,"sources/context.json"),"utf8"))).toEqual(c.context);
  expect(JSON.stringify(materialize(c))).not.toContain('"gold"');expect(JSON.stringify(materialize(c))).not.toContain('"split"');
  expect(Object.keys(observe(f.root)).length).toBeGreaterThan(25);
 }finally{f.close();}}
});
test("real config loads both modules and configured opportunity/assembly paths",async()=>{
 const f=stage(workload.find(c=>c.domain==="job")!);try{
  const check=await cli(f.root,["config","check","--json"]);expect(check.code).toBe(0);const data=JSON.parse(check.stdout);
  expect(data.valid).toBe(true);expect(data.taxonomy.types.opportunity.dir).toBe("harbour/opportunities");expect(data.taxonomy.types.conference.dir).toBe("assemblies");
  const module=await cli(f.root,["config","get","modules"]);expect(module.code).toBe(0);expect(JSON.parse(module.stdout)["./modules/jobs"].criteria).toBe("context/search-criteria.md");
  const before=observe(f.root),indexed=await cli(f.root,["index","--force","--json"]);expect(indexed.code).toBe(0);
  const pipeline=await cli(f.root,["jobs","pipeline","--json"]);expect(pipeline.code).toBe(0);expect(pipeline.stderr).toBe("");
  expect(readFileSync(join(f.root,"owner/letter.md"),"utf8")).toContain("Keep this owner-written paragraph unchanged.");
  expect(observe(f.root)["owner/binary.bin"]).toEqual(before["owner/binary.bin"]);
 }finally{f.close();}
});
test("whole observation detects added member, binary change, chmod and symlink retarget",()=>{
 const f=stage(workload[0]!);try{const initial=observe(f.root);
  writeFileSync(join(f.root,"owner/binary.bin"),Buffer.from([0,254,13,10,128]));expect(observe(f.root)["owner/binary.bin"]).not.toEqual(initial["owner/binary.bin"]);
  chmodSync(join(f.root,"owner/letter.md"),0o600);expect(observe(f.root)["owner/letter.md"]).not.toEqual(initial["owner/letter.md"]);
  symlinkSync("letter.md",join(f.root,"owner/link"));const linked=observe(f.root);unlinkSync(join(f.root,"owner/link"));symlinkSync("binary.bin",join(f.root,"owner/link"));expect(observe(f.root)["owner/link"]).not.toEqual(linked["owner/link"]);
  writeFileSync(join(f.root,"owner/new.md"),"new");expect(Object.hasOwn(observe(f.root),"owner/new.md")).toBe(true);
 }finally{f.close();}
});
test("owned closure rejects outside physical hardlinks and binds executable/link target bytes",()=>{
 const root=mkdtempSync(join(tmpdir(),"candidate-closure-")),outside=mkdtempSync(join(tmpdir(),"candidate-outside-"));try{
  writeFileSync(join(root,"a"),"first");let digest=closureDigest(ownedClosure(root));chmodSync(join(root,"a"),0o700);expect(closureDigest(ownedClosure(root))).not.toBe(digest);
  symlinkSync("a",join(root,"link"));digest=closureDigest(ownedClosure(root));writeFileSync(join(root,"a"),"second");expect(closureDigest(ownedClosure(root))).not.toBe(digest);
  linkSync(join(root,"a"),join(outside,"shared"));expect(()=>ownedClosure(root)).toThrow("shares inode outside owned tree");unlinkSync(join(outside,"shared"));expect(()=>ownedClosure(root)).not.toThrow();
  unlinkSync(join(root,"link"));symlinkSync(join(outside,"shared"),join(root,"link"));writeFileSync(join(outside,"shared"),"external");expect(()=>ownedClosure(root)).toThrow("link leaves owned tree");
 }finally{rmSync(root,{recursive:true,force:true});rmSync(outside,{recursive:true,force:true});}
});
