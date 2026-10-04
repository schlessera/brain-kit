import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { brainConfigSchema } from "../src/lib/config";
import { openDatabase } from "../src/lib/db";
import { indexAll } from "../src/lib/indexer";
import { ingest } from "../src/lib/ingestion";
import { loadModules } from "../src/lib/module-loader";
import type { LoadedModule, ModuleContribution } from "../src/lib/module-types";
import { buildTaxonomy, type Taxonomy } from "../src/lib/taxonomy";

const roots: string[]=[];
const databases: Database[]=[];
const configuredPrototypeName: string="constructor";
afterEach(()=>{
  for(const db of databases.splice(0)) db.close();
  for(const root of roots.splice(0)) rmSync(root,{recursive:true,force:true});
});

function corpus(): {root:string;db:Database} {
  const root=mkdtempSync(join(tmpdir(),"brain-taxonomy-own-"));roots.push(root);
  mkdirSync(join(root,"notes"));
  for(const name of ["raft","harbour"]) writeFileSync(join(root,"notes",name+".md"),
    `---\ntype: note\ntitle: ${name}\ncreated: 2026-01-01\n---\n\nFictional ${name} planning evidence.\n`);
  const db=openDatabase(":memory:");databases.push(db);
  return {root,db};
}

function markdownSnapshot(root:string): Record<string,string> {
  return Object.fromEntries([...new Bun.Glob("**/*.md").scanSync({cwd:root,onlyFiles:true})]
    .sort().map(path=>[path,readFileSync(join(root,path)).toString("base64")]));
}

async function modules(root:string, contributions: ModuleContribution[]): Promise<LoadedModule[]> {
  const entries: Record<string,unknown>={};
  for(const [i,contribution] of contributions.entries()) {
    const key=`./modules/fixture-${i}`, dir=join(root,key);
    mkdirSync(dir,{recursive:true});entries[key]={marker:"loaded-fixture"};
    // Real two-phase manifests and loader validation; no preassembled loaded
    // objects that bypass the contribution path under test.
    writeFileSync(join(dir,"module.ts"),`
import { z } from ${JSON.stringify(Bun.resolveSync("zod",import.meta.dir))};
import { defineModule } from ${JSON.stringify(fileURLToPath(new URL("../src/lib/module-types.ts",import.meta.url)))};
import { writeFileSync } from "node:fs";
import { join } from "node:path";
export default defineModule({
  name: "fixture-${i}", configSchema: z.object({ marker: z.literal("loaded-fixture") }),
  setup(config) {
    writeFileSync(join(import.meta.dir,"setup-observed.json"),JSON.stringify(config));
    return ${JSON.stringify(contribution)};
  },
});
`);
  }
  const loaded=await loadModules(brainConfigSchema.parse({modules:entries}),root);
  expect(loaded).toHaveLength(contributions.length);
  for(const mod of loaded) expect(JSON.parse(readFileSync(join(mod.dir,"setup-observed.json"),"utf8")))
    .toEqual({marker:"loaded-fixture"});
  return loaded;
}

async function captureConstructor(taxonomy:Taxonomy, root:string, db:Database, expectedDir:string): Promise<void> {
  const before=markdownSnapshot(root);
  expect(Object.keys(before)).toHaveLength(2);
  expect(taxonomy.validTypes()).toContain("note");
  expect(taxonomy.validTypes()).toContain("constructor");
  expect(taxonomy.isValidType("constructor")).toBe(true);
  const out=await ingest({content:"Raft signal\n\nPlan a fictional harbour repair."},db,{root,taxonomy});
  expect(out).toMatchObject({type:"constructor",action:"created",indexed:true});
  expect(out.path).toBe(expectedDir+"/raft-signal.md");
  expect(readFileSync(join(root,out.path),"utf8")).toContain("type: constructor");
  expect(db.query("SELECT type FROM documents WHERE path = ?").get(out.path)).toEqual({type:"constructor"});
  for(const [path,bytes] of Object.entries(before)) expect(readFileSync(join(root,path)).toString("base64")).toBe(bytes);
}

describe("configured own taxonomy entries",()=>{
  for(const type of ["constructor","toString","__proto__","hasOwnProperty","valueOf"]) {
    test(`real ingestion rejects unconfigured ${type} before changing Markdown`,async()=>{
      const {root,db}=corpus(), taxonomy=buildTaxonomy({});
      await indexAll(db,{root,taxonomy,quiet:true});
      const before=markdownSnapshot(root);
      expect(Object.keys(before)).toHaveLength(2);
      expect(db.query("SELECT count(*) AS n FROM documents").get()).toEqual({n:2});
      await expect(ingest({type,content:"Raft signal\n\nAn invalid explicit type must not write."},db,{root,taxonomy}))
        .rejects.toThrow(`Invalid type "${type}"`);
      expect(taxonomy.isValidType(type)).toBe(false);
      expect(taxonomy.validTypes()).not.toContain(type);
      expect(markdownSnapshot(root)).toEqual(before);
      expect(db.query("SELECT count(*) AS n FROM documents").get()).toEqual({n:2});
    });
  }

  // The installed record schema drops __proto__ itself; the other inherited
  // hint keys below actually survive validation and reach the resolver.
  for(const type of ["constructor","toString","hasOwnProperty","valueOf"]) {
    test(`user hints reject unconfigured ${type}`,()=>{
      const user=brainConfigSchema.parse({taxonomy:{classifierHints:{[type]:["raft signal"]}}});
      expect(Object.hasOwn(user.taxonomy!.classifierHints!,type)).toBe(true);
      expect(user.taxonomy!.classifierHints![type]).toEqual(["raft signal"]);
      expect(()=>buildTaxonomy({user})).toThrow(`brain.config declares classifierHints for unknown type "${type}"`);
    });

    test(`loaded module hints reject unconfigured ${type}`,async()=>{
      const {root}=corpus();
      const loaded=await modules(root,[{taxonomy:{classifierHints:{[type]:["raft signal"]}}}]);
      expect(Object.hasOwn(loaded[0]!.manifest.taxonomy!.classifierHints!,type)).toBe(true);
      expect(loaded[0]!.manifest.taxonomy!.classifierHints![type]).toEqual(["raft signal"]);
      expect(()=>buildTaxonomy({modules:loaded})).toThrow(`module "fixture-0" declares classifierHints for unknown type "${type}"`);
    });
  }

  test("a schema-valid user constructor type classifies, captures and indexes",async()=>{
    const {root,db}=corpus();
    const user=brainConfigSchema.parse({taxonomy:{types:{constructor:{dir:"rafts"}},classifierHints:{constructor:["raft signal"]}}});
    expect(Object.hasOwn(user.taxonomy!.types!,"constructor")).toBe(true);
    const taxonomy=buildTaxonomy({user});
    expect(taxonomy.types[configuredPrototypeName].owner).toBe("user");
    await captureConstructor(taxonomy,root,db,"rafts");
  });

  test("a loaded module constructor is a real owner and captures its hinted type",async()=>{
    const {root,db}=corpus();
    const loaded=await modules(root,[{taxonomy:{types:{constructor:{dir:"rafts"}},classifierHints:{constructor:["raft signal"]}}}]);
    expect(Object.hasOwn(loaded[0]!.manifest.taxonomy!.types!,"constructor")).toBe(true);
    let taxonomy!: Taxonomy;
    expect(()=>{taxonomy=buildTaxonomy({modules:loaded});}).not.toThrow();
    expect(taxonomy.types[configuredPrototypeName].owner).toBe("module:fixture-0");
    await captureConstructor(taxonomy,root,db,"rafts");
  });

  test("a user override preserves a loaded constructor type's existing fields",async()=>{
    const {root,db}=corpus();
    const loaded=await modules(root,[{taxonomy:{types:{constructor:{dir:"rafts",staleDays:30,orphanExempt:true}},classifierHints:{constructor:["raft signal"]}}}]);
    const user=brainConfigSchema.parse({taxonomy:{types:{constructor:{dir:"repairs"}}}});
    expect(Object.hasOwn(user.taxonomy!.types!,"constructor")).toBe(true);
    let taxonomy!: Taxonomy;
    expect(()=>{taxonomy=buildTaxonomy({modules:loaded,user});}).not.toThrow();
    expect(taxonomy.types[configuredPrototypeName]).toMatchObject({owner:"user",dir:"repairs",staleDays:30,orphanExempt:true});
    expect(taxonomy.expectedPrefixesFor("constructor")).toEqual(["repairs/"]);
    expect(taxonomy.isOrphanExempt("constructor")).toBe(true);
    await captureConstructor(taxonomy,root,db,"repairs");
  });

  test("a loaded module still cannot replace a core-owned type",async()=>{
    const {root}=corpus();
    const loaded=await modules(root,[{taxonomy:{types:{note:{dir:"rafts"}}}}]);
    expect(Object.keys(loaded[0]!.manifest.taxonomy!.types!)).toEqual(["note"]);
    expect(()=>buildTaxonomy({modules:loaded})).toThrow('type "note" already owned by core');
  });

  test("two loaded modules still cannot own the same configured type",async()=>{
    const {root}=corpus();
    const loaded=await modules(root,[{taxonomy:{types:{raft:{dir:"rafts"}}}},{taxonomy:{types:{raft:{dir:"repairs"}}}}]);
    for(const mod of loaded) expect(Object.keys(mod.manifest.taxonomy!.types!)).toEqual(["raft"]);
    expect(()=>buildTaxonomy({modules:loaded})).toThrow('type "raft" already owned by module:fixture-0');
  });

  test("type queries ignore an inherited spec while retaining configured own values",()=>{
    const taxonomy=buildTaxonomy({user:brainConfigSchema.parse({taxonomy:{types:{raft:{dir:"rafts",orphanExempt:true}}}})});
    Object.setPrototypeOf(taxonomy.types,{ghost:{dir:"ghosts",prefixes:["ghosts/"],orphanExempt:true}});
    expect(Object.hasOwn(taxonomy.types,"raft")).toBe(true);
    expect(Object.hasOwn(taxonomy.types,"ghost")).toBe(false);
    expect(taxonomy.dirForType("ghost")).toBeNull();
    expect(taxonomy.expectedPrefixesFor("ghost")).toBeNull();
    expect(taxonomy.isOrphanExempt("ghost")).toBe(false);
    expect(taxonomy.dirForType("raft")).toBe("rafts");
    expect(taxonomy.expectedPrefixesFor("raft")).toEqual(["rafts/"]);
    expect(taxonomy.isOrphanExempt("raft")).toBe(true);
  });
});
