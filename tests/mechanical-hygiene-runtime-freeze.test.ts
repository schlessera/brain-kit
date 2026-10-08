import { test, expect } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { closureTree, source } from "../scripts/evals/mechanical-hygiene/freeze";
import { hash } from "../scripts/evals/mechanical-hygiene/protocol";

test("complete installed closure observes binary bytes membership modes and owned links",()=>{
  const root=mkdtempSync("/tmp/hygiene-runtime-closure-");
  try{
    const file=join(root,"runtime.bin");writeFileSync(file,new Uint8Array([0,255,12]),{mode:0o644});
    const original=closureTree(root);expect((original["runtime.bin"] as any).bytes).toBe(3);
    chmodSync(file,0o640);expect(hash(JSON.stringify(closureTree(root)))).not.toBe(hash(JSON.stringify(original)));
    const modeChanged=closureTree(root);writeFileSync(file,new Uint8Array([0,254,12]));expect(hash(JSON.stringify(closureTree(root)))).not.toBe(hash(JSON.stringify(modeChanged)));
    writeFileSync(join(root,"extra.data"),"Odysseus added a runtime member.");expect(Object.keys(closureTree(root))).toContain("extra.data");
    symlinkSync(join(source,"README.md"),join(root,"module-link"));const linked=closureTree(root);
    expect((linked["module-link"] as any).kind).toBe("symlink");expect((linked["module-link"] as any).resolved).toBe("README.md");
    unlinkSync(join(root,"module-link"));symlinkSync(join(source,"ROADMAP.md"),join(root,"module-link"));expect(hash(JSON.stringify(closureTree(root)))).not.toBe(hash(JSON.stringify(linked)));
    unlinkSync(join(root,"module-link"));symlinkSync(file,join(root,"module-link"));expect(()=>closureTree(root)).toThrow("leaves the owned runtime");
  }finally{rmSync(root,{recursive:true,force:true});}
});
