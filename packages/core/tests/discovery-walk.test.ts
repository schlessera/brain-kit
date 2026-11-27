import * as fs from "node:fs";
import { expect, spyOn, test } from "bun:test";
import { Glob } from "bun";
import { chmodSync, mkdtempSync, mkdirSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildTaxonomy } from "../src/lib/taxonomy.js";
import { discoveryFiles } from "../src/lib/discovery-walk.js";
import { getMarkdownFiles, getAssetFiles } from "../src/lib/indexer/scan.js";
import { ASSET_EXTENSIONS } from "../src/lib/types.js";
import { git } from "./git-fixture";
// Frozen old Git oracle, independent of the production matcher.
function previousIgnored(root: string) {
  const result = Bun.spawnSync(["git", "-C", root, "ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"], {stdout:"pipe",stderr:"pipe"});
  const paths = result.exitCode === 0 ? result.stdout.toString().split("\u0000").filter(Boolean) : [];
  return (path: string) => paths.some(entry => entry.endsWith("/") ? path.startsWith(entry) : path === entry);
}

test("corpus discovery has exactly the former Glob lists and order", () => {
  const root=resolve(import.meta.dir,"../fixtures/corpus"), taxonomy=buildTaxonomy({});
  expect(getMarkdownFiles(root,taxonomy)).toEqual([...new Glob("**/*.md").scanSync({cwd:root})].filter(p=>!taxonomy.isExcludedPath(p)).sort());
  const ignored=previousIgnored(root), extensions=ASSET_EXTENSIONS.flatMap(e=>[e.slice(1),e.slice(1).toUpperCase()]);
  const paths=[...new Glob(`**/*.{${extensions.join(",")}}`).scanSync({cwd:root})].filter(p=>!taxonomy.isExcludedPath(p)&&!ignored(p)&&!p.includes(":Zone.Identifier")).sort((a,b)=>a.localeCompare(b));
  expect(getAssetFiles(root,taxonomy).map(a=>a.path)).toEqual(paths);
});
test("excluded trees are never opened and their size cannot increase directory reads", () => {
  const root=mkdtempSync(join(tmpdir(),"odysseus-discovery-"));
  try {
    mkdirSync(join(root,"notes")); mkdirSync(join(root,"node_modules/unreadable"),{recursive:true});
    for(let n=0;n<10;n++) writeFileSync(join(root,`notes/${n}.md`),"");
    const scan=()=>{
      let reads=0;
      const result=[...discoveryFiles(root,p=>p==="node_modules",p=>{
        expect(p,"DISCOVERY_NEVER_OPENS_EXCLUDED").not.toContain("node_modules"); reads++; return readdirSync(p,{withFileTypes:true});
      })];
      return {result,reads};
    };
    const before=scan();
    for(let n=0;n<10000;n++) writeFileSync(join(root,`node_modules/unreadable/${n}.md`),"");
    expect(scan(),"DISCOVERY_READ_COUNT_CONSTANT").toEqual(before);
    expect(before.result).toHaveLength(10); expect(before.reads).toBe(2);
  } finally {rmSync(root,{recursive:true,force:true});}
});

test("nested excludes, exact files and literal directory case preserve the former discovery", () => {
  const root=mkdtempSync(join(tmpdir(),"odysseus-discovery-rules-"));
  try {
    for(const path of ["notes/hidden/a.md","notes/open/a.md","drafts/a.md","Drafts/a.md","Drafts/a.JPG","Drafts/b.JpG","notes/open/excluded.md"]) {
      mkdirSync(join(root,path,".."),{recursive:true}); writeFileSync(join(root,path),"");
    }
    const taxonomy=buildTaxonomy({user:{exclude:{dirs:["notes/hidden","drafts"],files:["notes/open/excluded.md"]}} as never});
    const expected=[...new Glob("**/*.md").scanSync({cwd:root})].filter(p=>!taxonomy.isExcludedPath(p)).sort();
    expect(getMarkdownFiles(root,taxonomy)).toEqual(expected);
    expect(expected).toContain("Drafts/a.md");
    expect(expected).not.toContain("notes/hidden/a.md");
    expect(getAssetFiles(root,taxonomy).map(a=>a.path)).toEqual(["Drafts/a.JPG"]);
  } finally {rmSync(root,{recursive:true,force:true});}
});


test("index discovery never opens an excluded tree containing an unreadable directory", () => {
  const root=mkdtempSync(join(tmpdir(),"odysseus-discovery-access-")),excluded=join(root,"node_modules"),unreadable=join(excluded,"unreadable");
  expect(Bun.spawnSync(["git","-C",root,"init","-q"]).exitCode).toBe(0);
  mkdirSync(unreadable,{recursive:true});writeFileSync(join(root,"ithaca.md"),"# Ithaca");
  chmodSync(unreadable,0);
  try {
    utimesSync(excluded,0,0);
    expect(getMarkdownFiles(root,buildTaxonomy({}))).toEqual(["ithaca.md"]);
    expect(getAssetFiles(root,buildTaxonomy({}))).toEqual([]);
    expect(statSync(excluded).atimeMs,"INDEX_NEVER_OPENS_EXCLUDED_DIRECTORY").toBe(0);
    // Negative control: establish that this fixture's filesystem observes
    // a read made by the old whole-tree algorithm, even if Glob swallows
    // the unreadable descendant's EACCES.
    try { Array.from(new Glob("**/*.md").scanSync({cwd:root})); }
    catch(error) { if((error as NodeJS.ErrnoException).code !== "EACCES") throw error; }
    expect(statSync(excluded).atimeMs,"OLD_GLOB_READS_EXCLUDED_DIRECTORY_CONTROL").toBeGreaterThan(0);
  } finally {chmodSync(unreadable,0o700);rmSync(root,{recursive:true,force:true});}
});

test("extensionless asset names keep the former literal-dot requirement",()=>{
 const root=mkdtempSync(join(tmpdir(),"odysseus-asset-extension-"));
 try{for(const name of ["jpg","png","pdf","ithaca.jpg"])writeFileSync(join(root,name),"");
 expect(getAssetFiles(root,buildTaxonomy({})).map(row=>row.path),"ASSET_REQUIRES_DOT").toEqual(["ithaca.jpg"]);
 }finally{rmSync(root,{recursive:true,force:true});}
});

test("ignore pruning preserves force-tracked assets below an ignored directory",()=>{
 const root=mkdtempSync(join(tmpdir(),"odysseus-tracked-assets-"));
 try{
 git(root,"init","-q");mkdirSync(join(root,"assets"));writeFileSync(join(root,"assets/ithaca.jpg"),"Ithaca");writeFileSync(join(root,"assets/untracked.jpg"),"Athena");
 writeFileSync(join(root,".gitignore"),"assets/\n");git(root,"add","-f","assets/ithaca.jpg");
 expect(getAssetFiles(root,buildTaxonomy({})).map(asset=>asset.path),"IGNORE_PRUNING_RETAINS_TRACKED_DESCENDANTS").toEqual(["assets/ithaca.jpg"]);
 }finally{rmSync(root,{recursive:true,force:true});}
});

test("literal pathspec-looking names cannot disable ignore filtering",()=>{
 const root=mkdtempSync(join(tmpdir(),"odysseus-literal-ignore-"));try{
 expect(Bun.spawnSync(["git","-C",root,"init","-q"]).exitCode).toBe(0);
 writeFileSync(join(root,".gitignore"),"ithaca.jpg\n");
 for(const name of ["ithaca.jpg",":(glob)ithaca",":(literal)athena.jpg","voyage.jpg"])writeFileSync(join(root,name),"");
 expect(getAssetFiles(root,buildTaxonomy({})).map(a=>a.path),"LITERAL_NAMES_CANNOT_DISABLE_GIT_IGNORE").toEqual([":(literal)athena.jpg","voyage.jpg"]);
 }finally{rmSync(root,{recursive:true,force:true});}
});
test("undeclared nested Git repositories retain the former outer ignore semantics",()=>{
 const root=mkdtempSync(join(tmpdir(),"odysseus-nested-ignore-"));try{
 expect(Bun.spawnSync(["git","-C",root,"init","-q"]).exitCode).toBe(0);
 mkdirSync(join(root,"harbour"));expect(Bun.spawnSync(["git","-C",join(root,"harbour"),"init","-q"]).exitCode).toBe(0);
 writeFileSync(join(root,"harbour/.gitignore"),"chart.jpg\n");writeFileSync(join(root,"harbour/chart.jpg"),"");
 expect(getAssetFiles(root,buildTaxonomy({})).map(a=>a.path),"ONLY_DECLARED_SUBMODULES_HAVE_OWN_IGNORE_CONTEXT").toEqual(["harbour/chart.jpg"]);
 }finally{rmSync(root,{recursive:true,force:true});}
});
test("directory exclusion segments do not apply to a regular asset basename",()=>{
 const root=mkdtempSync(join(tmpdir(),"odysseus-asset-segment-"));try{
 writeFileSync(join(root,"ithaca.jpg"),"");const taxonomy=buildTaxonomy({user:{exclude:{segments:["ithaca.jpg"]}}} as never);
 expect(taxonomy.isExcludedPath("ithaca.jpg")).toBe(false);
 expect(getAssetFiles(root,taxonomy).map(a=>a.path),"DIRECTORY_SEGMENT_PREDICATE_NEVER_CLASSIFIES_FILES").toEqual(["ithaca.jpg"]);
 }finally{rmSync(root,{recursive:true,force:true});}
});

test("wildcard filenames remain literal and one stdin ignore batch serves a hundred directories",()=>{
 const root=mkdtempSync(join(tmpdir(),"odysseus-ignore-batch-"));
 try {
  expect(Bun.spawnSync(["git","-C",root,"init","-q"]).exitCode).toBe(0);
  writeFileSync(join(root,".gitignore"),"*.jpg\n");
  for(const name of ["chart1.jpg","chart[1].jpg"])writeFileSync(join(root,name),"");
  expect(Bun.spawnSync(["git","-C",root,"add","-f","--",":(literal)chart1.jpg"]).exitCode).toBe(0);
  for(let n=0;n<100;n++){mkdirSync(join(root,`notes-${n}`));writeFileSync(join(root,`notes-${n}/ithaca.md`),"");}
  const expected=["chart1.jpg"], spawn=spyOn(Bun,"spawnSync");
  try {
   expect(getAssetFiles(root,buildTaxonomy({})).map(row=>row.path),"LITERAL_WILDCARD_IGNORE").toEqual(expected);
   expect(spawn.mock.calls.filter(([argv])=>Array.isArray(argv)&&argv[0]==="git"),"FIXED_GIT_PROCESS_COUNT_PER_WORKTREE").toHaveLength(2);
  }finally{spawn.mockRestore();}
 }finally{rmSync(root,{recursive:true,force:true});}
});

test("Git directory pruning also holds when discovery starts below its worktree root",()=>{
 const root=mkdtempSync(join(tmpdir(),"odysseus-nested-discovery-")),brain=join(root,"brain");
 try {
  expect(Bun.spawnSync(["git","-C",root,"init","-q"]).exitCode).toBe(0);
  mkdirSync(join(brain,"node_modules/unreadable"),{recursive:true});writeFileSync(join(brain,"ithaca.jpg"),"");utimesSync(join(brain,"node_modules"),0,0);
  expect(getAssetFiles(brain,buildTaxonomy({})).map(row=>row.path)).toEqual(["ithaca.jpg"]);
  expect(statSync(join(brain,"node_modules")).atimeMs,"NESTED_WORKTREE_PRUNES_EXCLUDED_DIRECTORY").toBe(0);
 }finally{rmSync(root,{recursive:true,force:true});}
});

test("Git ignorecase does not case-fold taxonomy directory exclusions",()=>{
 const root=mkdtempSync(join(tmpdir(),"odysseus-ignorecase-taxonomy-"));
 try {
  git(root,"init","-q");git(root,"config","core.ignorecase","true");
  for(const path of ["Drafts/chart.jpg","drafts/hidden.jpg","athena.png"]){mkdirSync(join(root,path,".."),{recursive:true});writeFileSync(join(root,path),"");}
  writeFileSync(join(root,".gitignore"),"*.PNG\n");const taxonomy=buildTaxonomy({user:{exclude:{dirs:["drafts"]}}} as never);
  expect(taxonomy.isExcludedPath("Drafts/chart.jpg")).toBe(false);
  expect(getAssetFiles(root,taxonomy).map(row=>row.path),"TAXONOMY_CASE_IS_INDEPENDENT_OF_GIT_IGNORECASE").toEqual(["Drafts/chart.jpg"]);
 }finally{rmSync(root,{recursive:true,force:true});}
});
test("tracked descendants cannot make Git open taxonomy-excluded trees",()=>{
 const root=mkdtempSync(join(tmpdir(),"odysseus-tracked-excluded-"));
 try {
  expect(Bun.spawnSync(["git","-C",root,"init","-q"]).exitCode).toBe(0);
  for(const dir of ["node_modules","workspaces"]){mkdirSync(join(root,dir,"unreadable"),{recursive:true});writeFileSync(join(root,dir,"chart.md"),"Ithaca");}
  writeFileSync(join(root,"chart.jpg"),"Ithaca");
  expect(Bun.spawnSync(["git","-C",root,"add","-f","node_modules/chart.md","workspaces/chart.md"]).exitCode).toBe(0);
  for(let n=0;n<10000;n++)writeFileSync(join(root,`node_modules/unreadable/${n}.md`),"");
  for(const dir of ["node_modules","workspaces"])utimesSync(join(root,dir),0,0);
  const reads=spyOn(fs,"readdirSync");
  try {
   expect(getAssetFiles(root,buildTaxonomy({})).map(row=>row.path)).toEqual(["chart.jpg"]);
   expect(reads.mock.calls.some(([path])=>/\/(node_modules|workspaces)(?:\/|$)/.test(String(path))),"WALK_PRUNES_TRACKED_EXCLUDED_TREES").toBe(false);
  }finally{reads.mockRestore();}
  for(const dir of ["node_modules","workspaces"])expect(statSync(join(root,dir)).atimeMs,"GIT_NEVER_SEES_TRACKED_EXCLUDED_TREE").toBe(0);
  // Establish that Git's old unrestricted listing reads the tracked subtree.
  expect(Bun.spawnSync(["git","-C",root,"ls-files","--others","--ignored","--exclude-standard","--directory","--exclude=node_modules/","-z"]).exitCode).toBe(0);
  expect(statSync(join(root,"node_modules")).atimeMs,"GIT_READ_COUNTER_NEGATIVE_CONTROL").toBeGreaterThan(0);
 }finally{rmSync(root,{recursive:true,force:true});}
});

test("stdin ignore batching remains effective beyond the operating system argv limit",async()=>{
 const {gitIgnoredMatcher}=await import("../src/lib/git-ignore.js");
 const root=mkdtempSync(join(tmpdir(),"odysseus-ignore-argmax-"));
 try {
  expect(Bun.spawnSync(["git","-C",root,"init","-q"]).exitCode).toBe(0);writeFileSync(join(root,".gitignore"),"*.jpg\n");
  const candidates=["chart.jpg",...Array.from({length:12000},(_,n)=>`${"a".repeat(180)}${n}/chart.jpg`)];
  expect(Buffer.byteLength(candidates.join("\u0000")),"ARGMAX_FIXTURE_EXCEEDS_TWO_MIB").toBeGreaterThan(2*1024**2);
  const ignored=gitIgnoredMatcher(root,candidates);
  expect(ignored("chart.jpg"),"STDIN_GIT_IGNORE_SURVIVES_ARGMAX").toBe(true);
  expect(ignored(candidates.at(-1)!)).toBe(true);
 }finally{rmSync(root,{recursive:true,force:true});}
});

test("asset and statistics ignore matchers neutralize inherited Git pathspec modes",async()=>{
 const {gitIgnoredMatcher}=await import("../src/lib/git-ignore.js");
 const modes=["GIT_LITERAL_PATHSPECS","GIT_GLOB_PATHSPECS","GIT_NOGLOB_PATHSPECS","GIT_ICASE_PATHSPECS"];
 const saved=modes.map(key=>[key,Object.getOwnPropertyDescriptor(process.env,key)] as const);
 const root=mkdtempSync(join(tmpdir(),"odysseus-ignore-environment-"));
 try {
  for(const key of modes)delete process.env[key];
  expect(Bun.spawnSync(["git","-C",root,"init","-q"]).exitCode).toBe(0);writeFileSync(join(root,".gitignore"),"*.jpg\n");
  for(const path of ["chart.jpg","chart[1].jpg","chart1.jpg",":(literal)athena.png"])writeFileSync(join(root,path),"");
  expect(Bun.spawnSync(["git","-C",root,"add","-f","chart1.jpg"]).exitCode).toBe(0);
  for(const enabled of [...modes.map(key=>[key]),modes]){
   for(const key of modes)delete process.env[key];for(const key of enabled)process.env[key]="1";
   const asset=gitIgnoredMatcher(root,["chart.jpg","chart[1].jpg","chart1.jpg",":(literal)athena.png"]),statistics=gitIgnoredMatcher(root);
   for(const matcher of [asset,statistics]){
    expect(matcher("chart.jpg"),`GIT_PATHSPEC_ENVIRONMENT_SANITIZED ${enabled}`).toBe(true);
    expect(matcher("chart[1].jpg")).toBe(true);expect(matcher("chart1.jpg")).toBe(false);expect(matcher(":(literal)athena.png")).toBe(false);
   }
  }
 }finally{for(const [key,descriptor]of saved)if(descriptor)Object.defineProperty(process.env,key,descriptor);else delete process.env[key];rmSync(root,{recursive:true,force:true});}
});

test("declared submodules outside the pruned candidate list never enter Git ignore queries",async()=>{
 const root=mkdtempSync(join(tmpdir(),"odysseus-pruned-module-"));
 try {
  expect(Bun.spawnSync(["git","-C",root,"init","-q"]).exitCode).toBe(0);
  mkdirSync(join(root,"workspaces/harbour"),{recursive:true});
  expect(Bun.spawnSync(["git","-C",join(root,"workspaces/harbour"),"init","-q"]).exitCode).toBe(0);
  writeFileSync(join(root,".gitmodules"),'[submodule "harbour"]\n path = workspaces/harbour\n');writeFileSync(join(root,"chart.jpg"),"");
  const spawn=spyOn(Bun,"spawnSync");
  try {
   expect(getAssetFiles(root,buildTaxonomy({})).map(row=>row.path)).toEqual(["chart.jpg"]);
   const calls=spawn.mock.calls.filter(([argv])=>Array.isArray(argv)&&argv[0]==="git");
   expect(calls).toHaveLength(2);
   for(const [argv,options]of calls){
    expect((argv as string[]).join(" "),"EXCLUDED_MODULE_NEVER_QUERIED").not.toContain("workspaces");
    expect(String(options?.stdin??""),"EXCLUDED_MODULE_NEVER_QUERIED").not.toContain("workspaces");
   }
  }finally{spawn.mockRestore();}
 }finally{rmSync(root,{recursive:true,force:true});}
});

test("a non-UTF-8 directory cannot block valid discovery siblings",()=>{
 const root=mkdtempSync(join(tmpdir(),"odysseus-discovery-bytes-"));
 try {
  mkdirSync(Buffer.concat([Buffer.from(root+"/odd-"),Buffer.from([0xff])]));
  writeFileSync(join(root,"ithaca.md"),"# Ithaca");writeFileSync(join(root,"chart.jpg"),"Ithaca harbour");
  // A real replacement character is valid UTF-8 and must remain visible.
  mkdirSync(join(root,"\uFFFD"));writeFileSync(join(root,"\uFFFD/harbour.md"),"# Harbour");
  const taxonomy=buildTaxonomy({});
  const oldMarkdown=[...new Glob("**/*.md").scanSync({cwd:root})].sort();
  expect(oldMarkdown).toEqual(["ithaca.md","\uFFFD/harbour.md"]);
  let markdown:string[]=[];expect(()=>{markdown=getMarkdownFiles(root,taxonomy);},"INVALID_UTF8_DIRECTORY_DOES_NOT_BLOCK_INDEX").not.toThrow();
  expect(markdown).toEqual(oldMarkdown);
  expect(getAssetFiles(root,taxonomy).map(row=>row.path),"INVALID_UTF8_DIRECTORY_PRESERVES_ASSETS").toEqual(["chart.jpg"]);
 }finally{rmSync(root,{recursive:true,force:true});}
});
