import assert from "node:assert/strict";
import {diagramFontCss} from "../../../module-diagrams/src/fonts.ts";
/// <reference types="@vitest/browser-playwright" />
import {readFileSync,writeFileSync,mkdirSync,mkdtempSync,rmSync} from "node:fs";
import {spawn} from "node:child_process";
import {resolve,join} from "node:path";
import {materializeDiagramExportSource} from "../../../../scripts/diagram-export-source.mjs";
import {zeroRequestReplay} from "../../../ui-kit/tests/visual/zero-request-replay.ts";
import {chromium} from "playwright";
import type {BrowserCommand} from "vitest/node";
/** Actual optional-renderer CLI in the pinned offline browser environment. */
export const diagramFontStyles:BrowserCommand<[],string>=async()=>diagramFontCss();
export const diagramArtifact:BrowserCommand<[],unknown>=async(ctx)=>{
 const repo=resolve("../.."),base=resolve(repo,"tmp/diagram-export-proof",ctx.context.browser()!.browserType().name());
 mkdirSync(base,{recursive:true});
 const directory=mkdtempSync(join(base,"native-")),state=mkdtempSync("/tmp/odysseus-export-");
 const home=join(state,"home"),temp=join(state,"tmp");mkdirSync(home);mkdirSync(temp);
 try{
 const checkout=process.env.BRAIN_PROOF_CASE_CHECKOUT?JSON.parse(process.env.BRAIN_PROOF_CASE_CHECKOUT).sha:undefined;
 if(process.env.BRAIN_PROOF_CASE_CHECKOUT!==undefined)assert(typeof checkout==="string"&&/^[0-9a-f]{40}$/.test(checkout),"NATIVE_EXPORT_ACTUAL_CHECKOUT");
 const producer=materializeDiagramExportSource(repo,state,checkout,process.env.BRAIN_PROOF_NATIVE_DIAGRAM_INPUTS?JSON.parse(process.env.BRAIN_PROOF_NATIVE_DIAGRAM_INPUTS):undefined);
 // The pinned browser launcher mounts this exact Bun executable. No ambient
 // BUN_OPTIONS, credentials, configuration roots or executable override enter.
 const child=spawn("/usr/local/bin/bun",["--preload",resolve(producer,"scripts/test-network-child-preload.ts"),"--preload",resolve(producer,"packages/module-diagrams/tests/fixtures/export-native-boundary.ts"),resolve(producer,"packages/module-diagrams/tests/fixtures/export-artifact-probe.ts"),directory],{cwd:producer,env:{PATH:"/usr/local/bin:/usr/bin:/bin",LANG:"C.UTF-8",TZ:"UTC",HOME:home,TMPDIR:temp,PUPPETEER_EXECUTABLE_PATH:chromium.executablePath()},stdio:["ignore","pipe","pipe"]});
 let out="",err="";child.stdout.on("data",b=>{out+=String(b);});child.stderr.on("data",b=>{err+=String(b);});const artifacts=await new Promise<{format:string;bytes:number;pixelEquivalent?:boolean}[]>((res,reject)=>{child.once("error",reject);child.once("close",(code,signal)=>{if(code!==0||signal)reject(Error(`Diagram native CLI failed ${code}/${signal}: ${err}\n${out}`));else{try{res(JSON.parse(out));}catch(error){reject(error);}}});});
 const svg=readFileSync(resolve(directory,"release.svg"),"utf8"),width=Number(/width="([0-9.]+)"/.exec(svg)![1]),height=Number(/height="([0-9.]+)"/.exec(svg)![1]);
 const browser=await chromium.launch({headless:true,executablePath:chromium.executablePath(),args:["--disable-gpu"]});const context=await browser.newContext({viewport:{width,height},deviceScaleFactor:2});const page=await context.newPage();const replay=await zeroRequestReplay(page);
 try{
  await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0}svg{display:block}</style></head><body>${svg}</body></html>`);replay.assert("diagram artifact content");await page.evaluate(()=>document.fonts.ready);replay.assert("diagram artifact fonts");const reference=await page.locator("svg").screenshot();writeFileSync(resolve(directory,"reference.png"),reference);
  const identical=await page.evaluate(async([actual,expected])=>{const pixels=async(base64:string)=>{const image=new Image();image.src=`data:image/png;base64,${base64}`;await image.decode();const canvas=document.createElement("canvas");canvas.width=image.width;canvas.height=image.height;const ctx=canvas.getContext("2d")!;ctx.drawImage(image,0,0);return ctx.getImageData(0,0,canvas.width,canvas.height).data;};const a=await pixels(actual!),b=await pixels(expected!);return a.length===b.length&&a.every((value,i)=>value===b[i]);},[readFileSync(resolve(directory,"release.png")).toString("base64"),reference.toString("base64")]);
  replay.assert("diagram artifact pixels");artifacts.find(artifact=>artifact.format==="png")!.pixelEquivalent=identical;return artifacts;
 }finally{await context.close();await browser.close();}
 }finally{rmSync(state,{recursive:true,force:true});}
};
declare module "vitest/browser"{interface BrowserCommands{diagramFontStyles():Promise<string>;diagramArtifact():Promise<{format:string;bytes:number;width?:number;height?:number;fonts?:string[];pixelEquivalent?:boolean}[]>;}}
/** Compare the complete native SVG, including content outside ordinary viewports. */
export const diagramRasterComparison:BrowserCommand<[string,string,string],boolean>=async(ctx,name,before,after)=>{
 if(!/^[a-z0-9-]+$/.test(name))throw Error("Invalid diagram proof name");
 const directory=resolve("../../tmp/diagram-export-proof",ctx.context.browser()!.browserType().name());
 const page=await ctx.context.newPage();const replay=await zeroRequestReplay(page);const captures:Buffer[]=[];
 try{for(const [suffix,html] of [["before",before],["after",after]]){await page.setContent(`<!doctype html><html><body style="margin:0">${html}</body></html>`);replay.assert("diagram comparison content");const size=await page.locator("svg").evaluate(element=>{const box=element.getBoundingClientRect();return {width:Math.ceil(box.width),height:Math.ceil(box.height),nativeWidth:Number(element.getAttribute("width")),nativeHeight:Number(element.getAttribute("height"))};});assert(size.width>0&&size.height>0,"NATIVE_CAPTURE_NONZERO");assert.equal(size.width,size.nativeWidth,"NATIVE_CAPTURE_FULL_WIDTH");assert.equal(size.height,size.nativeHeight,"NATIVE_CAPTURE_FULL_HEIGHT");await page.setViewportSize({width:size.width,height:size.height});await page.evaluate(()=>document.fonts.ready);replay.assert("diagram comparison fonts");const capture=await page.locator("svg").screenshot(),ratio=await page.evaluate(()=>devicePixelRatio);assert.equal(capture.readUInt32BE(16),Math.round(size.width*ratio),"CAPTURE_PNG_FULL_WIDTH");assert.equal(capture.readUInt32BE(20),Math.round(size.height*ratio),"CAPTURE_PNG_FULL_HEIGHT");mkdirSync(directory,{recursive:true});writeFileSync(resolve(directory,`${name}-${suffix}.png`),capture);replay.assert("diagram comparison capture");captures.push(capture);}return captures[0]!.equals(captures[1]!);}finally{await page.close();}
};
declare module "vitest/browser"{interface BrowserCommands{diagramRasterComparison(name:string,before:string,after:string):Promise<boolean>;}}
