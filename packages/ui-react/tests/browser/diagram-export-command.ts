import {diagramFontCss} from "../../../module-diagrams/src/fonts.ts";
/// <reference types="@vitest/browser-playwright" />
import {readFileSync,writeFileSync} from "node:fs";
import {spawn} from "node:child_process";
import {resolve} from "node:path";
import {chromium} from "playwright";
import type {BrowserCommand} from "vitest/node";
/** Actual optional-renderer CLI in the pinned offline browser environment. */
export const diagramFontStyles:BrowserCommand<[],string>=async()=>diagramFontCss();
export const diagramArtifact:BrowserCommand<[],unknown>=async(ctx)=>{
 const repo=resolve("../.."),directory=resolve(repo,"tmp/diagram-export-proof",ctx.context.browser()!.browserType().name()),child=spawn(process.env.BUN_BIN??"bun",["--preload",resolve(repo,"scripts/test-network-child-preload.ts"),resolve(repo,"packages/module-diagrams/tests/fixtures/export-artifact-probe.ts"),directory],{cwd:repo,env:{...process.env,PUPPETEER_EXECUTABLE_PATH:chromium.executablePath()},stdio:["ignore","pipe","pipe"]});
 let out="",err="";child.stdout.on("data",b=>{out+=String(b);});child.stderr.on("data",b=>{err+=String(b);});const artifacts=await new Promise<{format:string;bytes:number;pixelEquivalent?:boolean}[]>((res,reject)=>{child.once("error",reject);child.once("exit",(code,signal)=>{if(code!==0||signal)reject(Error(`Diagram native CLI failed ${code}/${signal}: ${err}\n${out}`));else res(JSON.parse(out));});});
 const svg=readFileSync(resolve(directory,"release.svg"),"utf8"),width=Number(/width="([0-9.]+)"/.exec(svg)![1]),height=Number(/height="([0-9.]+)"/.exec(svg)![1]);
 const browser=await chromium.launch({headless:true,executablePath:chromium.executablePath(),args:["--disable-gpu"]});const context=await browser.newContext({viewport:{width,height},deviceScaleFactor:2});const page=await context.newPage();await page.route("**/*",route=>route.abort());
 try{
  await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0}svg{display:block}</style></head><body>${svg}</body></html>`);await page.evaluate(()=>document.fonts.ready);const reference=await page.locator("svg").screenshot();writeFileSync(resolve(directory,"reference.png"),reference);
  const identical=await page.evaluate(async([actual,expected])=>{const pixels=async(base64:string)=>{const image=new Image();image.src=`data:image/png;base64,${base64}`;await image.decode();const canvas=document.createElement("canvas");canvas.width=image.width;canvas.height=image.height;const ctx=canvas.getContext("2d")!;ctx.drawImage(image,0,0);return ctx.getImageData(0,0,canvas.width,canvas.height).data;};const a=await pixels(actual!),b=await pixels(expected!);return a.length===b.length&&a.every((value,i)=>value===b[i]);},[readFileSync(resolve(directory,"release.png")).toString("base64"),reference.toString("base64")]);
  artifacts.find(artifact=>artifact.format==="png")!.pixelEquivalent=identical;return artifacts;
 }finally{await context.close();await browser.close();}
};
declare module "vitest/browser"{interface BrowserCommands{diagramFontStyles():Promise<string>;diagramArtifact():Promise<{format:string;bytes:number;width?:number;height?:number;fonts?:string[];pixelEquivalent?:boolean}[]>;}}
