import {test,expect} from "bun:test";
import {mkdtempSync,writeFileSync,statSync,utimesSync,renameSync,rmSync} from "node:fs";
import {join} from "node:path";
import {hashFrozenFile} from "../scripts/evals/import-enrichment/frozen-file";
import {sha as hash} from "../scripts/evals/import-enrichment/freeze";
test("complete freeze hash notices same-size writes with restored mtime and inode replacement",()=>{
  const root=mkdtempSync("/tmp/import-enrichment-cache-control-");
  try{
    const path=join(root,"source.ts");writeFileSync(path,"Odysseus");const before=statSync(path);
    expect(hashFrozenFile(path)).toBe(hash("Odysseus"));expect(hashFrozenFile(path)).toBe(hash("Odysseus"));
    writeFileSync(path,"Penelope");utimesSync(path,before.atime,before.mtime);
    expect(hashFrozenFile(path)).toBe(hash("Penelope"));
    const next=join(root,"next.ts");writeFileSync(next,"Telemach");utimesSync(next,before.atime,before.mtime);renameSync(next,path);
    expect(hashFrozenFile(path)).toBe(hash("Telemach"));
  }finally{rmSync(root,{recursive:true,force:true});}
});
