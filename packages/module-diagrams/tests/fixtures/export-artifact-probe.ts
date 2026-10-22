import assert from "node:assert/strict";
import {originGroup} from "./origin-group.ts";
import {assertNativeExportBoundary} from "./export-native-boundary.ts";
import {copyFileSync,mkdirSync,readFileSync,writeFileSync} from "node:fs";
import {join} from "node:path";
import {cleanup,makeTempBrain,runCli} from "../../../core/tests/cli-harness.js";
const root=makeTempBrain({empty:true});
const artifacts:{format:string;bytes:number;width?:number;height?:number;fonts?:string[]}[]=[];
try{
 writeFileSync(join(root,"brain.config.ts"),'import {defineConfig} from "@schlessera/brain";export default defineConfig({modules:{"@schlessera/brain-module-diagrams":{}}});');
 writeFileSync(join(root,"release.diagram.yaml"),readFileSync(new URL("../../skills/diagram/references/examples/sequence.diagram.yaml",import.meta.url)));
 mkdirSync(process.argv[2]!,{recursive:true});
 const vector=await runCli(root,["diagram","export","release.diagram.yaml","--theme","print","--format","svg","--json"]);assert.equal(vector.code,0,vector.stderr+vector.stdout);assertNativeExportBoundary(root,"svg");copyFileSync(join(root,JSON.parse(vector.stdout).output),join(process.argv[2]!,"release.svg"));
 for(const format of ["png","pdf"]){const result=await runCli(root,["diagram","export","release.diagram.yaml","--theme","print","--format",format,"--json"],{PUPPETEER_EXECUTABLE_PATH:process.env.PUPPETEER_EXECUTABLE_PATH!,BRAIN_CHROME_NO_SANDBOX:"1"});assert.equal(result.code,0,result.stderr+result.stdout);assertNativeExportBoundary(root,format);const value=JSON.parse(result.stdout),bytes=readFileSync(join(root,value.output));assert.equal(bytes.length,value.bytes);assert.equal(value.ok,true);assert.equal(bytes.subarray(0,format==="png"?8:4).toString("hex"),format==="png"?"89504e470d0a1a0a":"25504446");const fonts=format==="pdf"?["JetBrainsMono","PlusJakartaSans"].filter(name=>bytes.toString("latin1").includes(name)):undefined;if(format==="pdf")assert.equal(fonts!.length,2,"actual exported PDF embeds both painted kit families");const geometry=format==="png"?{width:bytes.readUInt32BE(16),height:bytes.readUInt32BE(20)}:{};if(format==="png"){assert.ok(geometry.width!>=760);assert.ok(geometry.height!>200);}else{assert.ok(bytes.length>1000);assert.equal((bytes.toString("latin1").match(/\/Type \/Page\b/g)??[]).length,1,"native vector PDF contains exactly one figure page");}mkdirSync(process.argv[2]!,{recursive:true});copyFileSync(join(root,value.output),join(process.argv[2]!,`release.${format}`));artifacts.push({format,bytes:bytes.length,...geometry,...(fonts?{fonts}:{})});}
}finally{cleanup(root);}
// A second owned brain keeps the original release fixture and its receipts intact.
const originRoot=makeTempBrain({empty:true});
const origin:{format:string;bytes:number;width?:number;height?:number}[]=[];
try{
 writeFileSync(join(originRoot,"brain.config.ts"),'import {defineConfig} from "@schlessera/brain";export default defineConfig({modules:{"@schlessera/brain-module-diagrams":{}}});');
 writeFileSync(join(originRoot,"origin.diagram.yaml"),JSON.stringify(originGroup));
 for(const format of ["svg","png","pdf"]){
  const result=await runCli(originRoot,["diagram","export","origin.diagram.yaml","--theme","print","--format",format,"--json"],format==="svg"?{}:{PUPPETEER_EXECUTABLE_PATH:process.env.PUPPETEER_EXECUTABLE_PATH!,BRAIN_CHROME_NO_SANDBOX:"1"});
  assert.equal(result.code,0,result.stderr+result.stdout);assertNativeExportBoundary(originRoot,format,"origin.diagram.yaml");
  const value=JSON.parse(result.stdout),bytes=readFileSync(join(originRoot,value.output));assert.equal(value.ok,true);assert.equal(bytes.length,value.bytes);
  if(format==="svg")assert.ok(bytes.toString("utf8").includes('viewBox="-20 -24 192 120"'),"NATIVE_ORIGIN_SVG_VIEWBOX");
  if(format==="png"){assert.equal(bytes.subarray(0,8).toString("hex"),"89504e470d0a1a0a","NATIVE_ORIGIN_PNG_MAGIC");assert.equal(bytes.readUInt32BE(16),640,"NATIVE_ORIGIN_PNG_WIDTH");assert.equal(bytes.readUInt32BE(20),240,"NATIVE_ORIGIN_PNG_HEIGHT");}
  if(format==="pdf"){assert.equal(bytes.subarray(0,4).toString("ascii"),"%PDF","NATIVE_ORIGIN_PDF_MAGIC");assert.equal((bytes.toString("latin1").match(/\/Type \/Page\b/g)??[]).length,1,"NATIVE_ORIGIN_PDF_ONE_PAGE");}
  copyFileSync(join(originRoot,value.output),join(process.argv[2]!,`origin.${format}`));
  origin.push({format,bytes:bytes.length,...(format==="png"?{width:640,height:240}:{})});
 }
}finally{cleanup(originRoot);}
// The producer publishes neither release nor origin until all six children drain.
console.log(JSON.stringify({release:artifacts,origin}));
