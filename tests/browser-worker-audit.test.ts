import {afterEach,expect,test} from "bun:test";
import {chmodSync,mkdirSync,mkdtempSync,readFileSync,rmSync,symlinkSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {dirname,join,resolve} from "node:path";
import {hasAuditedWorkerBoundary,pdfWorkerInput,workerAuditFile,workerAuditIdentity} from "../scripts/browser-worker-audit";
const repo=resolve(import.meta.dir,".."),roots:string[]=[],guard="scripts/browser-worker-boundary.ts",setup="packages/ui-kit/tests/visual/worker-boundary-setup.ts",config="packages/ui-kit/vitest.config.ts";
afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
function fixture(){const root=mkdtempSync(join(tmpdir(),"browser-worker-audit-"));roots.push(root);const write=(file:string,text:string)=>{mkdirSync(dirname(join(root,file)),{recursive:true});writeFileSync(join(root,file),text);};for(const file of [guard,setup,config])write(file,readFileSync(join(repo,file),"utf8"));write("spec.ts","export const specimen=1;");write("data.json",'{"fixture":"Odysseus"}');write("fixtures/a.txt","owned directory bytes");const closure={files:[guard,setup,config,"spec.ts","data.json","fixtures","fixtures/a.txt"].sort(),directories:["fixtures"],external:[],unresolved:[pdfWorkerInput]},selected=[{file:"spec.ts",project:"visual"}];
 const manifest=()=>write(workerAuditFile,JSON.stringify({version:1,category:"browser",identity:workerAuditIdentity(root,closure,selected),diagnostic:{observed:1,workerAttempts:0}}));manifest();return{root,write,closure,selected,manifest};}
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
