import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { boundBrowserRuntimeInputs, browserImporters } from "../scripts/bound-browser-runtime-inputs";
const repo=resolve(import.meta.dir,".."),roots:string[]=[];
const files=["scripts/browser-shards.ts","scripts/browser-sequencer.ts","scripts/captures/fonts.ts","packages/ui-kit/tests/visual/rank-footer-browser.ts"];
const data=["scripts/captures/font-lock.json","scripts/captures/fonts.css","packages/ui-kit/.storybook/preview-head.html"];
afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
function fixture(){const root=mkdtempSync(join(tmpdir(),"bound-browser-runtime-"));roots.push(root);
  const write=(file:string,bytes:string)=>{mkdirSync(dirname(join(root,file)),{recursive:true});writeFileSync(join(root,file),bytes);};
  symlinkSync(join(repo,"node_modules"),join(root,"node_modules"),"dir");for(const file of [...files,...data])write(file,readFileSync(join(repo,file),"utf8"));return{root,write};}
test("exact sealed callers bind only the cost default and checksum-verified font reader bytes",()=>{
  const {root}=fixture(),bindings=boundBrowserRuntimeInputs(root,files);
  expect(bindings.get("scripts/browser-shards.ts")?.get('readFileSync(path, "utf8")')).toEqual(["scripts/browser-shard-costs.json"]);
  expect(bindings.get("scripts/captures/fonts.ts")?.size).toBe(4);
  expect(bindings.get("scripts/captures/fonts.ts")?.get('readFile(resolve(cache, entry.file))')).toEqual(["scripts/captures/font-lock.json"]);
  expect(boundBrowserRuntimeInputs(root,files.filter(file=>!file.includes("rank-footer"))).has("scripts/captures/fonts.ts")).toBe(false);
});
test("new imports, reexports and literal loaders cannot extend a sealed reader's caller domain",()=>{
  for(const source of ['import {readFontLock} from "./scripts/captures/fonts.ts";','export {verifyFontCache} from "./scripts/captures/fonts.ts";','await import("./scripts/captures/fonts.ts");','require("./scripts/captures/fonts.ts");']){
    const {root,write}=fixture();write("extra.ts",source);expect(boundBrowserRuntimeInputs(root,[...files,"extra.ts"]).has("scripts/captures/fonts.ts")).toBe(false);
  }
});
test("reader, caller and pinned font data drift fail fresh rather than trusting parameter claims",()=>{
  for(const file of ["scripts/captures/fonts.ts","packages/ui-kit/tests/visual/rank-footer-browser.ts",...data]){
    const {root,write}=fixture();write(file,readFileSync(join(root,file),"utf8")+"\n// drift\n");expect(boundBrowserRuntimeInputs(root,files).has("scripts/captures/fonts.ts")).toBe(false);
  }
  const {root,write}=fixture();write("scripts/browser-sequencer.ts",readFileSync(join(root,"scripts/browser-sequencer.ts"),"utf8").replace("readBrowserCosts()","readBrowserCosts(externalPath)"));expect(boundBrowserRuntimeInputs(root,files).has("scripts/browser-shards.ts")).toBe(false);
});

const diagramOwner="packages/module-diagrams/src/fonts.ts",diagramCaller="packages/ui-react/tests/browser/diagram-export-command.ts";
const diagramFonts=[2,4,6,7].map(face=>`packages/module-diagrams/assets/fonts/${face}.ttf`);
function diagramFixture(){const {root,write}=fixture();for(const file of [diagramOwner,diagramCaller,...diagramFonts]){mkdirSync(dirname(join(root,file)),{recursive:true});writeFileSync(join(root,file),readFileSync(join(repo,file)));}return{root,write};}
test("argument-free diagram font producer binds all four exact bundled font blobs",()=>{
 const {root}=diagramFixture(),selected=[diagramOwner,diagramCaller];
 expect([...boundBrowserRuntimeInputs(root,selected).get(diagramOwner)!.values()]).toEqual([diagramFonts]);
});
test("diagram font, reader, caller, symlink and new importer drift refuse the binding",()=>{
 for(const file of [diagramOwner,diagramCaller,...diagramFonts]){const {root}=diagramFixture();writeFileSync(join(root,file),Buffer.concat([readFileSync(join(root,file)),Buffer.from("drift")]));expect(boundBrowserRuntimeInputs(root,[diagramOwner,diagramCaller]).has(diagramOwner)).toBe(false);}
 const {root}=diagramFixture();rmSync(join(root,diagramFonts[0]!));symlinkSync(join(repo,diagramFonts[0]!),join(root,diagramFonts[0]!));expect(boundBrowserRuntimeInputs(root,[diagramOwner,diagramCaller]).has(diagramOwner)).toBe(false);
 for(const source of [`import {diagramFontCss as css} from "./${diagramOwner}";`,`export * from "./${diagramOwner}";`,`await import("./${diagramOwner}");`]){const {root,write}=diagramFixture();write("extra.ts",source);expect(boundBrowserRuntimeInputs(root,[diagramOwner,diagramCaller,"extra.ts"]).has(diagramOwner)).toBe(false);}
});

test("runtime importer seals address JavaScript implementations rather than declaration neighbors",()=>{
 const{root,write}=fixture();write("entry.ts",'import{readFixture}from"./reader.mjs";readFixture("Odysseus");');write("reader.mjs","export const readFixture=value=>value;");write("reader.d.mts","export declare const readFixture:(value:string)=>string;");
 const imports=browserImporters(root,["entry.ts","reader.mjs","reader.d.mts"]);expect([...imports.get("reader.mjs")??[]]).toEqual(["entry.ts"]);expect(imports.has("reader.d.mts")).toBe(false);
});
