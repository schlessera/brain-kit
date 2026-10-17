import {afterEach,expect,test} from "bun:test";
import assert from "node:assert/strict";
import {chmodSync,cpSync,lstatSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,realpathSync,rmSync,symlinkSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {dirname,join,resolve} from "node:path";
import {diagramSourceSetup,diagramSourceDomains} from "../scripts/diagram-export-source.mjs";
import {nativeDiagramInputs,nativeDiagramSourceInventory,type NativeDiagramDiagnostic} from "../scripts/native-diagram-inputs";
const repo=resolve(import.meta.dir,".."),roots:string[]=[],owner="packages/ui-react/tests/browser/diagram-export-command.ts",caller="packages/ui-kit/vitest.config.ts";
// Delivered #2293 owns the qualified bytes. Never substitute HEAD/worktree bytes,
// Git archive filters, or a newly computed candidate fingerprint for this control.
const frozen="0d780605fe1ea9a281cce947b1f0074f3f3e7acc";
const qualifiedSource="e8502b6ffb3c575f2e9a1c93dea8dbf5ceda93ece367da9d542cb10b1c9ac32b";
const qualifiedInstallation="0c2758c046f2b69d5f33b66521baf3098db5f44256b73ec96961c98d381e6245";
const ownedPaths=[...diagramSourceSetup,...diagramSourceDomains.map(name=>`packages/${name}`),owner,caller,"scripts/ci-proof.ts"];
afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
function fixture(current=false){
 const root=mkdtempSync(join(tmpdir(),"odysseus-native-inputs-"));roots.push(root);
 const tree=Bun.spawnSync(["git","ls-tree","-r","-z",current?"HEAD":frozen,"--",...ownedPaths],{cwd:repo,stdout:"pipe",stderr:"pipe"});
 expect(tree.exitCode,"FROZEN_SOURCE_OWNER_MUST_BE_AVAILABLE_OFFLINE").toBe(0);
 const entries=tree.stdout.toString().split("\0").filter(Boolean).map(row=>{const tab=row.indexOf("\t"),[mode,kind,oid]=row.slice(0,tab).split(" ");expect(kind).toBe("blob");expect(["100644","100755"]).toContain(mode);return{mode,oid,path:row.slice(tab+1)};});
 // Match the repository's immutable source protocol: read raw objects in one
 // batch, verifying each header/length and complete output before using it.
 const batch=Bun.spawnSync(["git","cat-file","--batch"],{cwd:repo,stdin:Buffer.from(entries.map(entry=>entry.oid).join("\n")+"\n"),stdout:"pipe",stderr:"pipe"});
 expect(batch.exitCode).toBe(0);const bytes=Buffer.from(batch.stdout);let offset=0;
 for(const entry of entries){
  const end=bytes.indexOf(10,offset);expect(end).toBeGreaterThanOrEqual(offset);
  const [oid,kind,length]=bytes.subarray(offset,end).toString("ascii").split(" "),size=Number(length);
  expect(oid).toBe(entry.oid);expect(kind).toBe("blob");expect(Number.isSafeInteger(size)&&size>=0&&end+1+size<bytes.length).toBe(true);
  const target=join(root,entry.path);mkdirSync(dirname(target),{recursive:true});
  writeFileSync(target,bytes.subarray(end+1,end+1+size));chmodSync(target,entry.mode==="100755"?0o755:0o644);offset=end+size+2;
 }
 expect(offset).toBe(bytes.length);
 if(!current){const source=nativeDiagramSourceInventory(root);expect(source.inputs.length,"COMPLETE_FROZEN_SOURCE_INVENTORY").toBe(859);expect(source.sha256,"INDEPENDENT_FROZEN_SOURCE_IDENTITY").toBe(qualifiedSource);}
 mkdirSync(join(root,"node_modules"));
 for(const top of readdirSync(join(repo,"node_modules"))){if(top.startsWith("."))continue;const names=top.startsWith("@")?readdirSync(join(repo,"node_modules",top)).map(name=>`${top}/${name}`):[top];for(const name of names){if(name.startsWith("@schlessera/"))continue;const target=join(root,"node_modules",name);mkdirSync(dirname(target),{recursive:true});symlinkSync(realpathSync(join(repo,"node_modules",name)),target,"dir");}}
 let diagnostic:NativeDiagramDiagnostic|undefined;
 const importers=new Map([[owner,new Set([caller])]]),bind=()=>nativeDiagramInputs(root,[owner,caller],importers,value=>{diagnostic=value;});
 return{root,importers,bind,diagnostic:()=>diagnostic};
}
function sourceRefused(control:ReturnType<typeof fixture>,name:string){
 expect(control.bind(),name).toBeUndefined();const diagnostic=control.diagnostic();
 assert(diagnostic,"UNKNOWN_NATIVE_BINDING_MUST_REPORT_DIAGNOSTIC");
 expect(diagnostic.status,"UNKNOWN_NATIVE_BINDING_HAS_REASON").toBe("source-mismatch");
 assert(diagnostic.actual?.source,"SOURCE_REFUSAL_MUST_REPORT_ACTUAL_IDENTITY");
 expect(diagnostic.expected.source).toBe(qualifiedSource);
 expect(diagnostic.actual.source).not.toBe(diagnostic.expected.source);
 expect(diagnostic.actual.installation).toBe(qualifiedInstallation);
 expect(JSON.stringify(diagnostic)).not.toContain(control.root);
}
test("fixed native qualification binds the independently frozen complete source without Docker or image lookup",()=>{
 const control=fixture(),path=process.env.PATH,bin=join(control.root,"commands");mkdirSync(bin);symlinkSync(realpathSync(process.execPath),join(bin,"bun"));
 try{
  process.env.PATH=bin;const binding=control.bind();
  expect(binding?.files.length,"COMPLETE_NATIVE_QUALIFICATION_WITHOUT_DOCKER_OR_IMAGE_LOOKUP").toBe(859);
  expect(binding?.files.toSorted()).toEqual(nativeDiagramSourceInventory(control.root).inputs.map(entry=>entry.path).toSorted());
  expect(binding?.identity.source).toBe(qualifiedSource);expect(binding?.identity.installation).toBe(qualifiedInstallation);
  expect(control.diagnostic()?.status).toBe("qualified");
 }finally{if(path===undefined)delete process.env.PATH;else process.env.PATH=path;}
});
test("an additional native importer requires fresh proof",()=>{
 const control=fixture();control.importers.get(owner)!.add("new-caller.ts");
 expect(control.bind(),"NATIVE_IMPORTER_REQUIRES_FRESH_PROOF").toBeUndefined();expect(control.diagnostic()?.status).toBe("unsealed-role");
});
test.each([owner,caller,"scripts/ci-proof.ts"])("changed pinned native input %s requires fresh proof",file=>{
 const control=fixture(),target=join(control.root,file);writeFileSync(target,readFileSync(target,"utf8")+"\n// changed native operation\n");
 expect(control.bind(),"NATIVE_PIN_REQUIRES_FRESH_PROOF").toBeUndefined();expect(control.diagnostic()?.status).toBe("source-pin-mismatch");
 const pin=control.diagnostic()?.pins?.find(pin=>pin.path===file);
 assert(pin,"PIN_REFUSAL_MUST_REPORT_EXPECTED_PIN");assert(pin.actual,"PIN_REFUSAL_MUST_REPORT_ACTUAL_PIN");
 expect(pin.actual).not.toBe(pin.expected);
});
test("added package source requires native requalification",()=>{
 const control=fixture();writeFileSync(join(control.root,"packages/core/src/unused-native-probe.ts"),"export const Odysseus=1;");
 sourceRefused(control,"NATIVE_SOURCE_ADDITION_REQUIRES_REQUALIFICATION");
});
test("changed package content requires native requalification",()=>{
 const control=fixture(),target=join(control.root,"packages/core/src/cli/brain.ts");writeFileSync(target,readFileSync(target,"utf8")+"\n// changed package content\n");
 sourceRefused(control,"NATIVE_SOURCE_CONTENT_REQUIRES_REQUALIFICATION");
});
test("changed package executable mode requires native requalification",()=>{
 const control=fixture(),target=join(control.root,"packages/core/src/cli/brain.ts");chmodSync(target,(lstatSync(target).mode&0o777)^0o111);
 sourceRefused(control,"NATIVE_SOURCE_MODE_REQUIRES_REQUALIFICATION");
});
test("relocated installed native dependency requires fresh proof",()=>{
 const control=fixture(),clone=join(control.root,"relocated/marked");mkdirSync(dirname(clone));cpSync(realpathSync(join(control.root,"node_modules/marked")),clone,{recursive:true});rmSync(join(control.root,"node_modules/marked"));symlinkSync(clone,join(control.root,"node_modules/marked"),"dir");
 expect(control.bind(),"NATIVE_INSTALLED_ORIGIN_REQUIRES_FRESH_PROOF").toBeUndefined();expect(control.diagnostic()?.stage).toBe("installation");expect(control.diagnostic()?.errorCode,"UNKNOWN_INSTALLED_ORIGIN_HAS_BOUNDED_REASON").toBe("NATIVE_DEPENDENCY_ORIGIN_CHANGED");
});
test("the actual current candidate qualifies only when its complete frozen source and pins match",()=>{
 const control=fixture(true),source=nativeDiagramSourceInventory(control.root),binding=control.bind(),diagnostic=control.diagnostic();
 assert(diagnostic,"CURRENT_CANDIDATE_MUST_REPORT_DIAGNOSTIC");
 // A legitimate new file or pinned proof/caller edit is an unsupported operation,
 // not a broken positive fixture. The frozen positive above must still qualify.
 if(source.sha256===qualifiedSource&&diagnostic.pins?.every(pin=>pin.owned&&pin.actual===pin.expected)){
  expect(binding?.identity.source).toBe(qualifiedSource);expect(diagnostic?.status).toBe("qualified");
 }else{
  expect(binding,"CHANGED_CANDIDATE_MUST_KEEP_FRESH_NATIVE_PROOF").toBeUndefined();expect(["source-mismatch","source-pin-mismatch"]).toContain(diagnostic.status);
 }
});
