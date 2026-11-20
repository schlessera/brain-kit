import { expect, test } from "bun:test";
import { Glob } from "bun";
import { chmodSync, mkdtempSync, mkdirSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildTaxonomy } from "../src/lib/taxonomy.js";
import { discoveryFiles } from "../src/lib/discovery-walk.js";
import { getMarkdownFiles, getAssetFiles } from "../src/lib/indexer/scan.js";
import { ASSET_EXTENSIONS } from "../src/lib/types.js";
import { gitIgnoredMatcher } from "../src/lib/git-ignore.js";

test("corpus discovery has exactly the former Glob lists and order", () => {
  const root=resolve(import.meta.dir,"../fixtures/corpus"), taxonomy=buildTaxonomy({});
  expect(getMarkdownFiles(root,taxonomy)).toEqual([...new Glob("**/*.md").scanSync({cwd:root})].filter(p=>!taxonomy.isExcludedPath(p)).sort());
  const ignored=gitIgnoredMatcher(root), extensions=ASSET_EXTENSIONS.flatMap(e=>[e.slice(1),e.slice(1).toUpperCase()]);
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
