import { afterEach, expect, test } from "bun:test";
import { mkdirSync,mkdtempSync,rmSync,writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildDataRefusals } from "../scripts/ci-build-data";
import { offlinePackInstallArgs } from "../scripts/ci-build-consumers";
import { classifyBuildTrace } from "../scripts/ci-build-trace";
const roots:string[]=[];
afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
test("actual TypeScript data references refuse ambient paths without comment/string lookalikes",()=>{
 const root=mkdtempSync(join(tmpdir(),"odysseus-build-data-"));roots.push(root);mkdirSync(join(root,"packages/common/src"),{recursive:true});
 const path="packages/common/src/index.ts",records=[{path,mode:0o644,kind:"file" as const}];
 writeFileSync(join(root,path),'// import "/outside/harbour.ts";\nconst story=\'import("/outside/harbour.ts")\';\nimport type{Stats}from"node:fs";import"./harbour";\n');
 expect(buildDataRefusals(root,records)).toEqual([]);
 writeFileSync(join(root,path),'type T=import("/outside/harbour.ts");\n');
 expect(buildDataRefusals(root,records),"CI_BUILD_ACTUAL_EXTERNAL_REFERENCE_REFUSES_REUSE").toEqual([path+":external-reference"]);
 writeFileSync(join(root,path),'/// <reference path="../../../../outside/harbour.ts"/>\n');
 expect(buildDataRefusals(root,records),"CI_BUILD_EFFECTIVE_REFERENCE_ESCAPE_REFUSED").toEqual([path+":external-reference"]);
});
test("only the authoritative known packed installers receive native offline flags",()=>{
 const cwd="/consumer-work/pack-work/brainkit-consumer",tar="/consumer-work/pack-work/brainkit-tarballs/common.tgz";
 const actual=offlinePackInstallArgs(["/tool/bun","add",tar,"react","react-dom"],"/tool/bun",cwd,["common"]);
 expect(actual).toEqual(["/tool/bun","add","--offline","--ignore-scripts","--backend=copyfile","--cache-dir=/consumer-work/cache",tar,"react","react-dom"]);
 expect(()=>offlinePackInstallArgs(["/tool/bun","add","odysseus-unreviewed-package"],"/tool/bun",cwd,["common"]),"CI_BUILD_UNKNOWN_INSTALLER_HAS_NO_ONLINE_FALLBACK").toThrow();
 expect(offlinePackInstallArgs(["/tool/bun","pm","pack"],"/tool/bun",cwd,["common"])).toBeUndefined();
});
test("trace classification preserves kernel/time unknowns instead of image ownership",()=>{
 const result=classifyBuildTrace('22 100.001 openat(AT_FDCWD, "/repo/packages/common/src/index.ts", O_RDONLY) = 3</repo/packages/common/src/index.ts>\n22 100.002 openat(AT_FDCWD, "/proc/self/stat", O_RDONLY) = 4</proc/self/stat>\n22 100.003 getrandom(0x123, 8, 0) = 8\n22 100.004 +++ exited with 0 +++\n');
 expect(result.paths.some(path=>path.path==="packages/common/src/index.ts"&&path.domain==="captured-input")).toBe(true);
 expect(result.paths.some(path=>path.domain==="kernel-or-device-unqualified"),"CI_BUILD_KERNEL_IS_NOT_IMAGE_INPUT").toBe(true);
 expect(result.unknowns.some(reason=>reason.startsWith("ambient:getrandom:"))).toBe(true);expect(result.ambientQualified).toBe(false);expect(result.completeObservation).toBe(true);
});
test("truncated trace and unmatched process records cannot become complete observation",()=>{
 const result=classifyBuildTrace('22 100.001 openat(AT_FDCWD, "/repo/harbour", O_RDONLY <unfinished ...>\n');
 expect(result.completeObservation,"CI_BUILD_INCOMPLETE_TRACE_REFUSED").toBe(false);expect(result.ambientQualified).toBe(false);
});

test("trace records cannot hide an unterminated descendant or extra path operand",()=>{
 const result=classifyBuildTrace('22 100.001 clone(child_stack=NULL, flags=SIGCHLD) = 23\n23 100.002 rename("/repo/a", "/proc/harbour") = -1 EPERM (Operation not permitted)\n22 100.003 +++ exited with 0 +++\n');
 expect(result.completeObservation,"CI_BUILD_UNTERMINATED_DESCENDANT_REFUSED").toBe(false);
 expect(result.unknowns).toContain("additional-path-operands:rename:review-required");
});
