import assert from "node:assert/strict";
import {diagramFontCss} from "../../../module-diagrams/src/fonts.ts";
/// <reference types="@vitest/browser-playwright" />
import {readFileSync,writeFileSync,mkdirSync,mkdtempSync,rmSync} from "node:fs";
import {createHash} from "node:crypto";
import {resolve,join} from "node:path";
import {zeroRequestReplay} from "../../../ui-kit/tests/visual/zero-request-replay.ts";
import {chromium,type Page} from "playwright";
import type {BrowserCommand} from "vitest/node";
/** Actual optional-renderer CLI in the pinned offline browser environment. */
export const diagramFontStyles:BrowserCommand<[],string>=async()=>diagramFontCss();
export const diagramArtifact:BrowserCommand<[],unknown>=async(ctx)=>{
 const repo=resolve("../.."),base=resolve(repo,"tmp/diagram-export-proof",ctx.context.browser()!.browserType().name());
 mkdirSync(base,{recursive:true});
 const session=process.env.BRAIN_NATIVE_DIAGRAM_PREPARED;assert(typeof session==="string"&&/^[a-f0-9-]{36}$/.test(session),"NATIVE_EXPORT_OWNED_PREPARATION_SESSION");
 const directory=mkdtempSync(join(base,"native-")),engine=ctx.context.browser()!.browserType().name(),prepared=resolve(repo,"tmp/diagram-export-native-prepared",session,engine);
 const receipt=JSON.parse(readFileSync(resolve(prepared,"producer.json"),"utf8"));
 assert.equal(receipt.session,session,"NATIVE_EXPORT_PRODUCER_SESSION");assert.equal(receipt.version,1,"NATIVE_EXPORT_PRODUCER_RECEIPT");assert.equal(receipt.engine,engine,"NATIVE_EXPORT_PRODUCER_ENGINE");
 const checkout=process.env.BRAIN_PROOF_CASE_CHECKOUT?JSON.parse(process.env.BRAIN_PROOF_CASE_CHECKOUT).sha:undefined;
 if(checkout!==undefined)assert.equal(receipt.checkout,checkout,"NATIVE_EXPORT_ACTUAL_CHECKOUT");
 const expected=process.env.BRAIN_PROOF_NATIVE_DIAGRAM_INPUTS?JSON.parse(process.env.BRAIN_PROOF_NATIVE_DIAGRAM_INPUTS):undefined;
 if(expected){assert.equal(receipt.source,expected.source,"NATIVE_EXPORT_RECEIPT_SOURCE");assert.equal(receipt.installation,expected.installation,"NATIVE_EXPORT_RECEIPT_INSTALLATION");assert.equal(receipt.runtime.sha256,expected.runtime,"NATIVE_EXPORT_RECEIPT_RUNTIME");}
 for(const format of ["svg","png","pdf"]){const name=`release.${format}`,bytes=readFileSync(resolve(prepared,name));assert.equal(createHash("sha256").update(bytes).digest("hex"),receipt.files[name],"NATIVE_EXPORT_ARTIFACT_CHANGED");writeFileSync(resolve(directory,name),bytes);}
 const artifacts=receipt.artifacts as {format:string;bytes:number;pixelEquivalent?:boolean}[];
 const svg=readFileSync(resolve(directory,"release.svg"),"utf8"),width=Number(/width="([0-9.]+)"/.exec(svg)![1]),height=Number(/height="([0-9.]+)"/.exec(svg)![1]);
 const browser=await chromium.launch({headless:true,executablePath:chromium.executablePath(),args:["--disable-gpu",...fullRasterChromiumArgs]});const context=await browser.newContext({viewport:{width,height},deviceScaleFactor:2});const page=await context.newPage();const replay=await zeroRequestReplay(page);
 try{
  await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0}svg{display:block}</style></head><body>${svg}</body></html>`);replay.assert("diagram artifact content");await page.evaluate(()=>document.fonts.ready);replay.assert("diagram artifact fonts");const reference=await page.locator("svg").screenshot();writeFileSync(resolve(directory,"reference.png"),reference);
  const identical=await page.evaluate(async([actual,expected])=>{const pixels=async(base64:string)=>{const image=new Image();image.src=`data:image/png;base64,${base64}`;await image.decode();const canvas=document.createElement("canvas");canvas.width=image.width;canvas.height=image.height;const ctx=canvas.getContext("2d")!;ctx.drawImage(image,0,0);return ctx.getImageData(0,0,canvas.width,canvas.height).data;};const a=await pixels(actual!),b=await pixels(expected!);return a.length===b.length&&a.every((value,i)=>value===b[i]);},[readFileSync(resolve(directory,"release.png")).toString("base64"),reference.toString("base64")]);
  replay.assert("diagram artifact pixels");artifacts.find(artifact=>artifact.format==="png")!.pixelEquivalent=identical;return artifacts;
 }finally{await context.close();await browser.close();}
};
declare module "vitest/browser"{interface BrowserCommands{diagramFontStyles():Promise<string>;diagramArtifact():Promise<{format:string;bytes:number;width?:number;height?:number;fonts?:string[];pixelEquivalent?:boolean}[]>;}}
/** Chromium arguments for every diagram comparison browser. A dirty rectangle
 * smaller than a raster tile is re-rastered into the tile already painted, and
 * curved anti-aliased edges in it then differ by one channel step from a full
 * raster. An exact comparison would record each capture's paint history rather
 * than its document (#2469). Editorial captures use the same documented flag
 * (docs/decisions/approval-capture-raster.md). */
export const fullRasterChromiumArgs=["--disable-partial-raster"];
type CaptureState={suffix:string;viewport:{width:number;height:number}|null;devicePixelRatio:number;layout:{width:number;height:number};fonts:{status:string;faces:{family:string;weight:string;style:string;status:string}[]}};
const sha256=(bytes:Buffer|string)=>createHash("sha256").update(bytes).digest("hex");
const comparisonDocument=(html:string)=>`<!doctype html><html><body style="margin:0">${html}</body></html>`;
/** Load one document at its native size and capture the complete SVG. */
async function captureNativeSvg(page:Page,replay:Replay,html:string){
 await page.setContent(comparisonDocument(html));replay.assert("diagram comparison content");
 const size=await page.locator("svg").evaluate(element=>{const box=element.getBoundingClientRect();return {width:Math.ceil(box.width),height:Math.ceil(box.height),nativeWidth:Number(element.getAttribute("width")),nativeHeight:Number(element.getAttribute("height"))};});
 assert(size.width>0&&size.height>0,"NATIVE_CAPTURE_NONZERO");assert.equal(size.width,size.nativeWidth,"NATIVE_CAPTURE_FULL_WIDTH");assert.equal(size.height,size.nativeHeight,"NATIVE_CAPTURE_FULL_HEIGHT");
 await page.setViewportSize({width:size.width,height:size.height});await page.evaluate(()=>document.fonts.ready);replay.assert("diagram comparison fonts");
 const fonts=await page.evaluate(()=>({status:document.fonts.status,faces:[...document.fonts].map(face=>({family:face.family,weight:face.weight,style:face.style,status:face.status}))}));
 const capture=await page.locator("svg").screenshot(),ratio=await page.evaluate(()=>devicePixelRatio);
 assert.equal(capture.readUInt32BE(16),Math.round(size.width*ratio),"CAPTURE_PNG_FULL_WIDTH");assert.equal(capture.readUInt32BE(20),Math.round(size.height*ratio),"CAPTURE_PNG_FULL_HEIGHT");
 return {capture,state:{viewport:page.viewportSize(),devicePixelRatio:ratio,layout:{width:size.width,height:size.height},fonts}};
}
/** Decode both PNGs in the browser, as the artifact parity check does, and locate differing pixels. */
async function decodedDifference(page:Page,before:Buffer,after:Buffer){
 return page.evaluate(async([a,b])=>{
  const pixels=async(base64:string)=>{const image=new Image();image.src=`data:image/png;base64,${base64}`;await image.decode();const canvas=document.createElement("canvas");canvas.width=image.width;canvas.height=image.height;const context=canvas.getContext("2d")!;context.drawImage(image,0,0);return {width:image.width,height:image.height,data:context.getImageData(0,0,image.width,image.height).data};};
  const x=await pixels(a!),y=await pixels(b!);
  if(x.width!==y.width||x.height!==y.height)return {sameDimensions:false,differingPixels:null,bounds:null,maxChannelDelta:null};
  let differingPixels=0,maxChannelDelta=0,left=x.width,top=x.height,right=0,bottom=0;
  for(let i=0;i<x.data.length;i+=4){let delta=0;for(let k=0;k<4;k++)delta=Math.max(delta,Math.abs(x.data[i+k]!-y.data[i+k]!));if(!delta)continue;differingPixels++;maxChannelDelta=Math.max(maxChannelDelta,delta);const p=i/4,px=p%x.width,py=Math.floor(p/x.width);left=Math.min(left,px);top=Math.min(top,py);right=Math.max(right,px+1);bottom=Math.max(bottom,py+1);}
  return {sameDimensions:true,differingPixels,bounds:differingPixels?[left,top,right,bottom]:null,maxChannelDelta};
 },[before.toString("base64"),after.toString("base64")]);
}
/** Keep what an unequal comparison needs for attribution: both captures, the compared markup and capture-time state. */
async function recordParityFailure(page:Page,replay:Replay,directory:string,name:string,engine:string,version:string,documents:string[],captures:Buffer[],states:CaptureState[]){
 const decoded=await decodedDifference(page,captures[0]!,captures[1]!);replay.assert("diagram comparison decode");
 const markup=states.map((state,i)=>{const file=`${name}-${state.suffix}.html`,html=comparisonDocument(documents[i]!);writeFileSync(resolve(directory,file),html);return {suffix:state.suffix,file,sha256:sha256(html),bytes:Buffer.byteLength(html)};});
 const encoded=captures.map((capture,i)=>({suffix:states[i]!.suffix,file:`${name}-${states[i]!.suffix}.png`,sha256:sha256(capture),bytes:capture.length,width:capture.readUInt32BE(16),height:capture.readUInt32BE(20)}));
 const receipt={version:1,name,engine,browserVersion:version,configuredLaunchArguments:engine==="chromium"?fullRasterChromiumArgs:[],captureOrder:states.map(state=>state.suffix),encoded:{equal:false,captures:encoded},decoded:{equal:decoded.differingPixels===0,...decoded},captures:states,markup};
 writeFileSync(resolve(directory,`${name}-parity.json`),`${JSON.stringify(receipt,null,1)}\n`);
 console.error(`DIAGRAM_RASTER_PARITY ${engine} ${name}: encoded ${encoded.map(c=>`${c.suffix}=${c.sha256.slice(0,12)} ${c.width}x${c.height}`).join(" ")}; decoded ${decoded.sameDimensions?`${decoded.differingPixels} differing pixels, bounds ${JSON.stringify(decoded.bounds)}, max channel delta ${decoded.maxChannelDelta}`:"dimensions differ"}; fonts ${states.map(state=>`${state.suffix}=${state.fonts.status}`).join(" ")}; receipt ${name}-parity.json`);
}
type Replay=Awaited<ReturnType<typeof zeroRequestReplay>>;
/** Compare the complete native SVG, including content outside ordinary viewports. */
export const diagramRasterComparison:BrowserCommand<[string,string,string],boolean>=async(ctx,name,before,after)=>{
 if(!/^[a-z0-9-]+$/.test(name))throw Error("Invalid diagram proof name");
 const browser=ctx.context.browser()!,engine=browser.browserType().name(),directory=resolve("../../tmp/diagram-export-proof",engine);
 const page=await ctx.context.newPage();const replay=await zeroRequestReplay(page);const captures:Buffer[]=[],states:CaptureState[]=[];
 try{
  for(const [suffix,html] of [["before",before],["after",after]] as const){const {capture,state}=await captureNativeSvg(page,replay,html);mkdirSync(directory,{recursive:true});writeFileSync(resolve(directory,`${name}-${suffix}.png`),capture);replay.assert("diagram comparison capture");captures.push(capture);states.push({suffix,...state});}
  const equal=captures[0]!.equals(captures[1]!);
  for(const stale of [`${name}-parity.json`,`${name}-before.html`,`${name}-after.html`])rmSync(resolve(directory,stale),{force:true});
  if(!equal)await recordParityFailure(page,replay,directory,name,engine,browser.version(),[before,after],captures,states);
  return equal;
 }finally{await page.close();}
};
/** Repaint a strip narrower than a raster tile over an already painted SVG,
 * then capture again. The second capture must equal the first: a comparison
 * may not depend on which regions an earlier frame happened to repaint. */
export const diagramRepaintParity:BrowserCommand<[string,string],boolean>=async(ctx,name,html)=>{
 if(!/^[a-z0-9-]+$/.test(name))throw Error("Invalid diagram proof name");
 const directory=resolve("../../tmp/diagram-export-proof",ctx.context.browser()!.browserType().name());
 const page=await ctx.context.newPage();const replay=await zeroRequestReplay(page);
 const frames=()=>page.evaluate(()=>new Promise<void>(done=>requestAnimationFrame(()=>requestAnimationFrame(()=>done()))));
 try{
  const {capture:full}=await captureNativeSvg(page,replay,html);
  await page.evaluate(()=>{const box=document.querySelector("svg")!.getBoundingClientRect(),strip=document.createElement("div");strip.id="repaint-strip";strip.style.cssText=`position:absolute;left:${box.width-116}px;top:0;width:116px;height:${box.height}px;background:#f00`;document.body.append(strip);});
  await frames();await page.screenshot();await page.evaluate(()=>document.getElementById("repaint-strip")!.remove());await frames();
  const repainted=await page.locator("svg").screenshot();replay.assert("diagram repaint capture");
  mkdirSync(directory,{recursive:true});writeFileSync(resolve(directory,`${name}-full.png`),full);writeFileSync(resolve(directory,`${name}-repainted.png`),repainted);
  return full.equals(repainted);
 }finally{await page.close();}
};
declare module "vitest/browser"{interface BrowserCommands{diagramRasterComparison(name:string,before:string,after:string):Promise<boolean>;diagramRepaintParity(name:string,html:string):Promise<boolean>;}}
