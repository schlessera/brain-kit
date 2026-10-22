import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compactBuildEvidence } from "../scripts/ci-build-evidence";
import { digest, identity, outputFiles } from "../scripts/ci-build-boundary";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
 const controller = mkdtempSync(join(tmpdir(), "odysseus-build-evidence-")); roots.push(controller);
 const workspace = join(controller,"workspace"), state = join(workspace,"tmp/isolated-ci-build/operation-Ithaca"), session = "00000000-0000-4000-8000-000000000001";
 mkdirSync(state,{recursive:true,mode:0o700});
 const file=(path:string,bytes:string)=>{mkdirSync(join(state,path,".."),{recursive:true,mode:0o700});writeFileSync(join(state,path),bytes);};
 for(const path of ["context.json","invocation.json","entry.json","container-boundary.json","diagnostics/isolated-producer.json"])file(path,"{}");
 file("cleanup.json",JSON.stringify({session,containerID:"a".repeat(64),drained:true,removed:true}));file("tool/bun","captured runtime fixture");
 file("parents/common/dist/index.js",'export const harbour="Ithaca";\n');
 const output=identity(outputFiles(join(state,"parents/common/dist")));
 const result={purpose:"qualification",authority:"none",session,key:digest("Ithaca inputs"),artifactDirectory:state,drained:true,removed:true,outputs:{common:output},producer:{runtime:{bun:digest("captured runtime fixture")}}};
 return {controller,workspace,state,result};
}
test("controller compaction retains exact output/runtime/evidence before removing only its owned successful capture",()=>{
 const f=fixture(), other=join(f.workspace,"tmp/isolated-ci-build/operation-other");mkdirSync(other,{mode:0o700});writeFileSync(join(other,"keep"),"Odysseus");
 const actual=compactBuildEvidence(f.workspace,f.controller,f.result), receipt=JSON.parse(readFileSync(join(actual.artifactDirectory,"retained.json"),"utf8"));
 expect(existsSync(f.state),"CI_BUILD_DRAINED_DUPLICATE_CAPTURE_REMOVED").toBe(false);expect(existsSync(join(other,"keep"))).toBe(true);
 expect(receipt.files.map((file:any)=>file.path)).toContain("cleanup.json");expect(receipt.removedCapture).toBe(true);
 expect(receipt.files.map((file:any)=>file.path),"CI_BUILD_CONTEXT_RECEIPT_RETAINED").toContain("context.json");
 expect(identity(outputFiles(join(f.controller,receipt.outputs.common.path))),"CI_BUILD_RETAINED_OUTPUT_IDENTITY").toBe(f.result.outputs.common);
 expect(digest(readFileSync(join(f.controller,"runtime",`bun-${f.result.producer.runtime.bun}`)))).toBe(f.result.producer.runtime.bun);
});
test("failed or foreign captures are preserved rather than compacted",()=>{
 const f=fixture();expect(()=>compactBuildEvidence(f.workspace,f.controller,{...f.result,removed:false}),"CI_BUILD_INCOMPLETE_CAPTURE_NEVER_DELETED").toThrow();expect(existsSync(f.state)).toBe(true);
 expect(()=>compactBuildEvidence(f.workspace,f.controller,{...f.result,artifactDirectory:f.controller}),"CI_BUILD_FOREIGN_CAPTURE_NEVER_DELETED").toThrow();expect(existsSync(f.state)).toBe(true);
});
