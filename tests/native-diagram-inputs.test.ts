import {afterEach,expect,test} from "bun:test";
import {chmodSync,cpSync,lstatSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,realpathSync,rmSync,symlinkSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {dirname,join,resolve} from "node:path";
import {diagramSourceSetup,diagramSourceDomains} from "../scripts/diagram-export-source.mjs";
import {nativeDiagramInputs} from "../scripts/native-diagram-inputs";
const repo=resolve(import.meta.dir,".."),roots:string[]=[],owner="packages/ui-react/tests/browser/diagram-export-command.ts",caller="packages/ui-kit/vitest.config.ts";
afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
test("fixed native qualification binds all owned source, importers, caller and installed origin",()=>{
 const root=mkdtempSync(join(tmpdir(),"odysseus-native-inputs-"));roots.push(root);
 const listed=Bun.spawnSync(["git","ls-files","-z"],{cwd:repo,stdout:"pipe",stderr:"pipe"});expect(listed.exitCode).toBe(0);
 const files=[...new Set([...listed.stdout.toString().split("\0").filter(path=>diagramSourceDomains.some(name=>path.startsWith(`packages/${name}/`))),...diagramSourceSetup,owner,caller,"scripts/ci-proof.ts"])];
 for(const file of files){mkdirSync(dirname(join(root,file)),{recursive:true});writeFileSync(join(root,file),readFileSync(join(repo,file)));chmodSync(join(root,file),lstatSync(join(repo,file)).mode&0o777);}
 mkdirSync(join(root,"node_modules"));
 for(const top of readdirSync(join(repo,"node_modules"))){if(top.startsWith("."))continue;const names=top.startsWith("@")?readdirSync(join(repo,"node_modules",top)).map(name=>`${top}/${name}`):[top];for(const name of names){if(name.startsWith("@schlessera/"))continue;const target=join(root,"node_modules",name);mkdirSync(dirname(target),{recursive:true});symlinkSync(realpathSync(join(repo,"node_modules",name)),target,"dir");}}
 const importers=new Map([[owner,new Set([caller])]]),bind=()=>nativeDiagramInputs(root,[owner,caller],importers);
 expect(bind()?.files.length,"COMPLETE_NATIVE_SOURCE_AND_INSTALLATION_QUALIFICATION").toBe(853);
 importers.get(owner)!.add("new-caller.ts");expect(bind()).toBeUndefined();importers.get(owner)!.delete("new-caller.ts");
 const original=readFileSync(join(root,owner));writeFileSync(join(root,owner),original.toString()+"\n// changed native operation\n");expect(bind()).toBeUndefined();writeFileSync(join(root,owner),original);
 const added="packages/core/src/unused-native-probe.ts";writeFileSync(join(root,added),"export const Odysseus=1;");expect(bind(),"NATIVE_SOURCE_ADDITION_REQUIRES_REQUALIFICATION").toBeUndefined();rmSync(join(root,added));
 const specimen="packages/core/src/cli/brain.ts",mode=lstatSync(join(root,specimen)).mode&0o777;chmodSync(join(root,specimen),mode^0o111);expect(bind()).toBeUndefined();chmodSync(join(root,specimen),mode);
 const clone=join(root,"relocated/marked");mkdirSync(dirname(clone));cpSync(realpathSync(join(root,"node_modules/marked")),clone,{recursive:true});rmSync(join(root,"node_modules/marked"));symlinkSync(clone,join(root,"node_modules/marked"),"dir");expect(bind()).toBeUndefined();
});
