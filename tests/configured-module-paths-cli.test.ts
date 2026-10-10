// The real `brain` CLI on a disk-backed brain with a local jobs module and
// configured opportunity/assembly directories: `config check`, `config get`,
// `index --force` and `jobs pipeline` agree and leave owner files alone. The
// candidate-extraction eval's disk fixture first exercised this (#1386 split it
// from the harness tests in experiments/candidate-extraction-disk.test.ts);
// tests/fixtures/candidate-extraction/ only stages the brain.
import { expect,test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stage,observe,cli } from "./fixtures/candidate-extraction/disk-fixture";
test("real config loads both modules and configured opportunity/assembly paths",async()=>{
 const f=stage();try{
  const check=await cli(f.root,["config","check","--json"]);expect(check.code).toBe(0);const data=JSON.parse(check.stdout);
  expect(data.valid).toBe(true);expect(data.taxonomy.types.opportunity.dir).toBe("harbour/opportunities");expect(data.taxonomy.types.conference.dir).toBe("assemblies");
  const module=await cli(f.root,["config","get","modules"]);expect(module.code).toBe(0);expect(JSON.parse(module.stdout)["./modules/jobs"].criteria).toBe("context/search-criteria.md");
  const before=observe(f.root),indexed=await cli(f.root,["index","--force","--json"]);expect(indexed.code).toBe(0);
  const pipeline=await cli(f.root,["jobs","pipeline","--json"]);expect(pipeline.code).toBe(0);expect(pipeline.stderr).toBe("");
  expect(readFileSync(join(f.root,"owner/letter.md"),"utf8")).toContain("Keep this owner-written paragraph unchanged.");
  expect(observe(f.root)["owner/binary.bin"]).toEqual(before["owner/binary.bin"]);
 }finally{f.close();}
});
