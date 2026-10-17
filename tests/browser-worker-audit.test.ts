import {afterEach,expect,test} from "bun:test";
import {chmodSync,mkdirSync,mkdtempSync,readFileSync,rmSync,symlinkSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {dirname,join,resolve} from "node:path";
import {hasAuditedWorkerBoundary,inspectWorkerAudit,pdfWorkerInput,workerAuditFile,workerAuditIdentity} from "../scripts/browser-worker-audit";
const repo=resolve(import.meta.dir,".."),roots:string[]=[],guard="scripts/browser-worker-boundary.ts",setup="packages/ui-kit/tests/visual/worker-boundary-setup.ts",config="packages/ui-kit/vitest.config.ts";
afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
function fixture(){const root=mkdtempSync(join(tmpdir(),"browser-worker-audit-"));roots.push(root);const write=(file:string,text:string)=>{mkdirSync(dirname(join(root,file)),{recursive:true});writeFileSync(join(root,file),text);};for(const file of [guard,setup,config])write(file,readFileSync(join(repo,file),"utf8"));write("spec.ts","export const specimen=1;");write("data.json",'{"fixture":"Odysseus"}');write("fixtures/a.txt","owned directory bytes");const closure={files:[guard,setup,config,"spec.ts","data.json","fixtures","fixtures/a.txt"].sort(),directories:["fixtures"],external:[],unresolved:[pdfWorkerInput]},selected=[{file:"spec.ts",project:"visual"}];
 const manifest=()=>write(workerAuditFile,JSON.stringify({version:2,category:"browser",identity:workerAuditIdentity(root,closure,selected),guardedFreshProofRequired:true,sourceAudit:{version:1,selected:selected.length,files:closure.files.length},historicalDiagnostic:{observed:1,workerAttempts:0}}));manifest();return{root,write,closure,selected,manifest};}
test("capability audit joins exact enforced hooks and all selected source/data/resource identities",()=>{
  const {root,closure,selected,write}=fixture();expect(hasAuditedWorkerBoundary(root,closure,selected)).toBe(true);
  write("data.json",'{"fixture":"Penelope"}');expect(hasAuditedWorkerBoundary(root,closure,selected)).toBe(false);
});
test("new callers, inventory, directory membership, mode and unsupported resources require a new audit",()=>{
  const {root,closure,selected}=fixture();
  expect(hasAuditedWorkerBoundary(root,closure,[...selected,{file:"new.ts",project:"visual"}])).toBe(false);
  expect(hasAuditedWorkerBoundary(root,{...closure,directories:["changed"]},selected)).toBe(false);
  expect(hasAuditedWorkerBoundary(root,{...closure,unresolved:[pdfWorkerInput,"Unknown external resource"]},selected)).toBe(false);
  chmodSync(join(root,"data.json"),0o755);expect(hasAuditedWorkerBoundary(root,closure,selected)).toBe(false);
});
test("edited enforcement cannot be blessed by merely recomputing manifest metadata",()=>{
  for(const file of [guard,setup,config]){const {root,closure,selected,write,manifest}=fixture();write(file,readFileSync(join(root,file),"utf8")+"\n// guard drift\n");manifest();expect(hasAuditedWorkerBoundary(root,closure,selected)).toBe(false);}
});
test("missing/symbolic files and a manifest self-hash cannot establish the audit identity",()=>{
  const {root,closure,selected}=fixture();expect(workerAuditIdentity(root,{...closure,files:[...closure.files,workerAuditFile]},selected)).toBeUndefined();
  rmSync(join(root,"spec.ts"));expect(workerAuditIdentity(root,closure,selected)).toBeUndefined();symlinkSync(join(root,"data.json"),join(root,"spec.ts"));expect(workerAuditIdentity(root,closure,selected)).toBeUndefined();
});

test("legacy observation metadata cannot admit the newly audited domain",()=>{
 const {root,write,closure,selected}=fixture();
 write(workerAuditFile,JSON.stringify({version:1,category:"browser",identity:workerAuditIdentity(root,closure,selected),diagnostic:{observed:selected.length,workerAttempts:0}}));
 expect(hasAuditedWorkerBoundary(root,closure,selected),"OLD_OBSERVATION_IS_NOT_CURRENT_DOMAIN_ADMISSION").toBe(false);
});

test("missing or inconsistent current-domain capability metadata stays fresh",()=>{
 for(const mutate of [(v:any)=>delete v.sourceAudit,(v:any)=>{v.sourceAudit.selected++},(v:any)=>{v.sourceAudit.files++},(v:any)=>{v.guardedFreshProofRequired=false},(v:any)=>delete v.historicalDiagnostic]){const {root,write,closure,selected}=fixture(),record=JSON.parse(readFileSync(join(root,workerAuditFile),"utf8"));mutate(record);write(workerAuditFile,JSON.stringify(record));expect(hasAuditedWorkerBoundary(root,closure,selected)).toBe(false);}
});

test("covered byte drift stays unavailable and the bounded manifest names only the changed identity",()=>{
 const {root,closure,selected,write}=fixture();
 const before=inspectWorkerAudit(root,closure,selected);
 write("data.json",'{"fixture":"Penelope"}');
 const after=inspectWorkerAudit(root,closure,selected);
 expect(after.qualified,"COVERED_DRIFT_REMAINS_UNQUALIFIED").toBe(false);
 expect(after.diagnostic.expectedIdentity).toBe(before.diagnostic.actualIdentity);
 expect(after.diagnostic.actualIdentity).not.toBe(before.diagnostic.actualIdentity);
 const oldFiles=(before.diagnostic as any).material.files,newFiles=(after.diagnostic as any).material.files;
 const changed=newFiles.filter((entry:any)=>JSON.stringify(entry)!==JSON.stringify(oldFiles.find((old:any)=>old[0]===entry[0])));
 expect(changed.map((entry:any)=>entry[0]),"WORKER_DIAGNOSTIC_NAMES_CHANGED_BLOB").toEqual(["data.json"]);
 expect(JSON.stringify(after.diagnostic)).not.toContain(root);
 expect(JSON.stringify(after.diagnostic)).not.toContain("Penelope");
 expect(JSON.stringify(after.diagnostic).length).toBeLessThan(768*1024);
});

test("unknown native inputs expose bounded evidence without admission material",()=>{
 const {root,closure,selected}=fixture();
 const unknown={...closure,unresolved:[pdfWorkerInput,"Undeclared input spec.ts: readFile(secretSourceContents)"],nativeDiagramDiagnostic:{version:1 as const,status:"source-mismatch",stage:"runtime",expected:{source:"a".repeat(64),installation:"b".repeat(64)},actual:{source:"c".repeat(64),installation:"b".repeat(64),runtime:"d".repeat(64)}}};
 expect(workerAuditIdentity(root,unknown,selected),"UNSUPPORTED_INPUT_HAS_NO_ADMISSION_IDENTITY").toBeUndefined();
 const inspected=inspectWorkerAudit(root,unknown,selected),diagnostic=inspected.diagnostic as any;
 expect(inspected.qualified,"UNKNOWN_NATIVE_INPUT_ALWAYS_REQUIRES_FRESH").toBe(false);
 expect(diagnostic.admissionSupported).toBe(false);
 expect(diagnostic.native?.status,"UNKNOWN_NATIVE_DIAGNOSTIC_IS_NON_NULL").toBe("source-mismatch");
 expect(diagnostic.native.actual.source).toBe("c".repeat(64));
 expect(diagnostic.material.files.some((entry:any)=>entry[0]==="data.json")).toBe(true);
 expect(diagnostic.unresolved).toContainEqual({code:"undeclared-input",owner:"spec.ts"});
 expect(JSON.stringify(diagnostic)).not.toContain(root);
 expect(JSON.stringify(diagnostic)).not.toContain("secretSourceContents");
});
