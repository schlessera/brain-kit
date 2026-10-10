/** Neutral author-provisional brains. No label, split or expected output enters disk input. */
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync, lstatSync, readdirSync, readlinkSync, utimesSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import type { Case } from "./workload";
export const ROOT = resolve(import.meta.dir,"../../..");
export const DAY = "2026-07-12";
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const doc=(type:string,title:string,body:string)=>`---\ntype: ${type}\ntitle: ${JSON.stringify(title)}\ncreated: ${DAY}\nupdated: ${DAY}\nstatus: active\nrelevance: primary\n---\n\n${body}\n`;
export function materialize(c: Case) {
 const config={modules:{"./modules/speaking":{},"./modules/jobs":{criteria:"context/search-criteria.md",opportunitiesDir:"harbour/opportunities",dbPath:"data/jobs.db"}},
  taxonomy:{types:{conference:{dir:"assemblies"},talk:{dir:"addresses"},opportunity:{dir:"harbour/opportunities"}},canonical:{identity:"context/identity.md"}}};
 const files:Record<string,string>={
  "brain.config.json":JSON.stringify(config,null,2)+"\n",
  "sources/notice.txt":c.source,
  "sources/context.json":JSON.stringify(c.context,null,2)+"\n",
  "context/identity.md":doc("identity","Odysseus's positioning","Odysseus plans voyages, keeps a ship ledger and explains safe crew coordination. Do not invent expertise or past appearances."),
  "context/search-criteria.md":doc("note","Crew search criteria","Must have: a stated role and an honest description of compensation. Prefer clear responsibilities. Unknown compensation requires discussion; do not invent currency, timezone, contact or application details."),
  "context/content-strategy.md":doc("note","Address themes","Explain voyage planning and keeping the shore ledger. Preserve uncertainty and cite the notice's exact evidence."),
  "me/bios/short.md":doc("note","Short speaker bio","Odysseus plans voyages and keeps the shore ledger."),
  "addresses/_proposals.md":doc("note","Prior proposals","No earlier proposal for this notice is recorded."),
  "assemblies/_index.md":doc("note","Assembly register","No researched assembly is recorded."),
  "harbour/opportunities/_index.md":doc("note","Crew opportunity register","No researched opportunity is recorded."),
  "owner/letter.md":doc("note","Penelope's letter","Keep this owner-written paragraph unchanged."),
 };
 for(const name of ["speaking","jobs"]){files[`modules/${name}/module.ts`]=`export {default} from ${JSON.stringify(join(ROOT,"packages",`module-${name}`,"src/module.ts"))};\n`;
  const walk=(path:string)=>{const full=join(ROOT,"packages",`module-${name}`,"skills",path);for(const member of readdirSync(full)){const rel=path?`${path}/${member}`:member;
   if(lstatSync(join(full,member)).isDirectory())walk(rel);else files[`modules/${name}/skills/${rel}`]=readFileSync(join(full,member),"utf8");}};walk("");}
 return {files,binaryFiles:{"owner/binary.bin":Buffer.from([0,255,13,10,128]).toString("base64")},config,request:{domain:c.domain,sourcePath:"sources/notice.txt",contextPath:"sources/context.json",
  referenceDate:DAY,instruction:c.domain==="cfp"?"Research the complete notice, retaining exact sources and uncertainty. Use conference-research and prepare the submission constraints; discuss missing information before changes.":"Research the complete notice against the criteria and identity. Use research-opportunity; discuss whether to pursue before changes."}};
}
export function stage(c:Case) {
 const root=mkdtempSync(join(tmpdir(),"candidate-brain-")),built=materialize(c);
 for(const [path,text] of Object.entries(built.files)){mkdirSync(dirname(join(root,path)),{recursive:true});writeFileSync(join(root,path),text);}
 for(const [path,bytes] of Object.entries(built.binaryFiles))writeFileSync(join(root,path),Buffer.from(bytes,"base64"));
 // Fixed fixture timestamps; independent full-file observation retains subsequent changes.
 const set=(path:string)=>{const s=lstatSync(path);if(s.isDirectory())for(const n of readdirSync(path))set(join(path,n));utimesSync(path,new Date(`${DAY}T00:00:00Z`),new Date(`${DAY}T00:00:00Z`));};set(root);
 return {...built,root,close:()=>rmSync(root,{recursive:true,force:true})};
}
/** Every member, binary bytes, mode, mtime and literal symlink target; no following outside links. */
export function observe(root:string) {
 const out:Record<string,unknown>={};
 const walk=(path:string)=>{const full=join(root,path),s=lstatSync(full,{bigint:true});
  const kind=s.isDirectory()?"directory":s.isSymbolicLink()?"symlink":s.isFile()?"file":"other";
  out[path]={kind,mode:Number(s.mode),mtimeNs:s.mtimeNs.toString(),size:s.size.toString(),
   ...(kind==="file"?{bytes:readFileSync(full).toString("base64"),sha256:sha(readFileSync(full))}:kind==="symlink"?{target:readlinkSync(full)}:{})};
  if(kind==="directory")for(const n of readdirSync(full).sort())walk(path==="."?n:`${path}/${n}`);};walk(".");return out;
}
export async function cli(root:string,args:string[]) {
 const home=mkdtempSync(join(tmpdir(),"candidate-cli-home-"));
 try{const child=Bun.spawn([process.execPath,join(ROOT,"packages/core/src/cli/brain.ts"),...args],{
  cwd:root,env:{PATH:`${dirname(process.execPath)}:/usr/bin:/bin`,HOME:home,BRAIN_ROOT:root,TZ:"UTC"},stdin:"ignore",stdout:"pipe",stderr:"pipe"});
  const [stdout,stderr,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);return {args,stdout,stderr,code};
 }finally{rmSync(home,{recursive:true,force:true});}
}
