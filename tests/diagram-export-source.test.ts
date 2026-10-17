import {afterEach,expect,test} from "bun:test";
import {chmodSync,mkdirSync,mkdtempSync,readFileSync,rmSync,symlinkSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {dirname,join,resolve} from "node:path";
import {diagramSourceDomains,diagramSourceSetup,materializeDiagramExportSource} from "../scripts/diagram-export-source.mjs";
import {prepareDiagramExportSource} from "../scripts/prepare-diagram-export-source.mjs";
const repo=resolve(import.meta.dir,".."),roots:string[]=[];
afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
function fixture(){
 const root=mkdtempSync(join(tmpdir(),"odysseus-diagram-source-"));roots.push(root);
 const write=(file:string,bytes:string|Buffer)=>{mkdirSync(dirname(join(root,file)),{recursive:true});writeFileSync(join(root,file),bytes);};
 for(const file of diagramSourceSetup)write(file,readFileSync(join(repo,file)));
 for(const name of diagramSourceDomains){write(`packages/${name}/package.json`,readFileSync(join(repo,`packages/${name}/package.json`)));write(`packages/${name}/src/specimen.ts`,'export const world="Odysseus";');}
 mkdirSync(join(root,"node_modules"));for(const name of diagramSourceDomains){const manifest=JSON.parse(readFileSync(join(root,`packages/${name}/package.json`),"utf8"));const link=join(root,"node_modules",manifest.name);mkdirSync(dirname(link),{recursive:true});symlinkSync(join(root,"packages",name),link,"dir");}mkdirSync(join(root,"home"));mkdirSync(join(root,"template"));
 const git=(...args:string[])=>{const p=Bun.spawnSync(["git",...args],{cwd:root,env:{PATH:process.env.PATH!,HOME:join(root,"home"),GIT_CONFIG_GLOBAL:"/dev/null",GIT_CONFIG_NOSYSTEM:"1",GIT_TEMPLATE_DIR:join(root,"template")},stdout:"pipe",stderr:"pipe"});if(p.exitCode)throw Error(new TextDecoder().decode(p.stderr));};
 git("init","-q");git("add",".");git("-c","user.name=Odysseus","-c","user.email=odysseus@example.com","-c","core.hooksPath=/dev/null","-c","commit.gpgSign=false","commit","-qm","owned native source fixture");
 return{root,write,git,view:()=>{const state=mkdtempSync(join(tmpdir(),"odysseus-diagram-view-"));roots.push(state);return state;}};
}
test("tracked source views preserve bytes/modes and rebase all six workspace roots",()=>{
 const {root,write,git,view}=fixture();write("packages/core/src/executable.ts","export const Odysseus=1;");chmodSync(join(root,"packages/core/src/executable.ts"),0o755);git("add",".");
 const record=prepareDiagramExportSource(root),source=materializeDiagramExportSource(root,view());
 expect(record.immutable).toBe(false);expect(record.checkout).toBeNull();expect(readFileSync(join(source,"packages/core/src/executable.ts"),"utf8")).toContain("Odysseus");
 for(const name of diagramSourceDomains){const manifest=JSON.parse(readFileSync(join(root,`packages/${name}/package.json`),"utf8"));expect(readFileSync(join(source,"node_modules",manifest.name,"package.json"),"utf8")).toBe(readFileSync(join(root,`packages/${name}/package.json`),"utf8"));}
 write("packages/core/src/untracked.js","throw Error('untracked source shadow');");expect(record.inputs.some(entry=>entry.path.endsWith("untracked.js"))).toBe(false);
});
test("passing source preparation rejects current edits and staged deletions",()=>{
 const {root,write}=fixture();write("packages/core/src/specimen.ts","changed source");expect(()=>prepareDiagramExportSource(root,true)).toThrow("differs from immutable HEAD");
 const second=fixture();second.git("rm","packages/core/src/specimen.ts");expect(()=>prepareDiagramExportSource(second.root,true)).toThrow("differs from immutable HEAD");
});
test("archive checkout, input bytes, file modes, aliases and missing enforcement fail before execution",()=>{
 for(const kind of ["checkout","bytes","mode","alias","guard"]){const{root,write,view}=fixture(),record=prepareDiagramExportSource(root,true),archive=join(root,"tmp/diagram-export-source.json");
  if(kind==="checkout")expect(()=>materializeDiagramExportSource(root,view(),"0".repeat(40))).toThrow("actual immutable checkout");
  else if(kind==="bytes"){write("packages/core/src/specimen.ts","changed source");expect(()=>materializeDiagramExportSource(root,view())).toThrow("bytes, modes or aliases changed");}
  else if(kind==="mode"){chmodSync(join(root,"packages/core/src/specimen.ts"),0o755);expect(()=>materializeDiagramExportSource(root,view())).toThrow("bytes, modes or aliases changed");}
  else if(kind==="alias"){const file=join(root,"packages/core/src/specimen.ts");rmSync(file);symlinkSync(join(root,"packages/common/src/specimen.ts"),file);expect(()=>materializeDiagramExportSource(root,view())).toThrow("bytes, modes or aliases changed");}
  else{record.inputs=record.inputs.filter(entry=>entry.path!=="scripts/test-network-guard.ts");writeFileSync(archive,JSON.stringify(record));expect(()=>materializeDiagramExportSource(root,view())).toThrow("Incomplete native diagram source archive");}
 }
});

test("missing installed workspace aliases cannot be silently supplied by source copying",()=>{
 const{root,view}=fixture();prepareDiagramExportSource(root);rmSync(join(root,"node_modules/@schlessera/brain"));expect(()=>materializeDiagramExportSource(root,view())).toThrow("Missing or redirected installed native workspace dependency");
});
