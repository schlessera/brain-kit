import assert from "node:assert/strict";
import {assertNativeExportBoundary} from "./export-native-boundary.ts";
import {copyFileSync,mkdirSync,readFileSync,writeFileSync} from "node:fs";
import {join} from "node:path";
import {cleanup,makeTempBrain,runCli} from "../../../core/tests/cli-harness.js";
const root=makeTempBrain({empty:true});
try{
 writeFileSync(join(root,"brain.config.ts"),'import {defineConfig} from "@schlessera/brain";export default defineConfig({modules:{"@schlessera/brain-module-diagrams":{}}});');
 writeFileSync(join(root,"release.diagram.yaml"),readFileSync(new URL("../../skills/diagram/references/examples/sequence.diagram.yaml",import.meta.url)));
 mkdirSync(process.argv[2]!,{recursive:true});
 const vector=await runCli(root,["diagram","export","release.diagram.yaml","--theme","print","--format","svg","--json"]);assert.equal(vector.code,0,vector.stderr+vector.stdout);assertNativeExportBoundary(root,"svg");copyFileSync(join(root,JSON.parse(vector.stdout).output),join(process.argv[2]!,"release.svg"));
 const artifacts:{format:string;bytes:number;width?:number;height?:number;fonts?:string[]}[]=[];
 for(const format of ["png","pdf"]){const result=await runCli(root,["diagram","export","release.diagram.yaml","--theme","print","--format",format,"--json"],{PUPPETEER_EXECUTABLE_PATH:process.env.PUPPETEER_EXECUTABLE_PATH!,BRAIN_CHROME_NO_SANDBOX:"1"});assert.equal(result.code,0,result.stderr+result.stdout);assertNativeExportBoundary(root,format);const value=JSON.parse(result.stdout),bytes=readFileSync(join(root,value.output));assert.equal(bytes.length,value.bytes);assert.equal(value.ok,true);assert.equal(bytes.subarray(0,format==="png"?8:4).toString("hex"),format==="png"?"89504e470d0a1a0a":"25504446");const fonts=format==="pdf"?["JetBrainsMono","PlusJakartaSans"].filter(name=>bytes.toString("latin1").includes(name)):undefined;if(format==="pdf")assert.equal(fonts!.length,2,"actual exported PDF embeds both painted kit families");const geometry=format==="png"?{width:bytes.readUInt32BE(16),height:bytes.readUInt32BE(20)}:{};if(format==="png"){assert.ok(geometry.width!>=760);assert.ok(geometry.height!>200);}else{assert.ok(bytes.length>1000);assert.equal((bytes.toString("latin1").match(/\/Type \/Page\b/g)??[]).length,1,"native vector PDF contains exactly one figure page");}mkdirSync(process.argv[2]!,{recursive:true});copyFileSync(join(root,value.output),join(process.argv[2]!,`release.${format}`));artifacts.push({format,bytes:bytes.length,...geometry,...(fonts?{fonts}:{})});}
 console.log(JSON.stringify(artifacts));
}finally{cleanup(root);}
