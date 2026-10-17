/// <reference types="@vitest/browser-playwright" />
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { BrowserCommand } from "vitest/node";
import { zeroRequestReplay } from "../../../ui-kit/tests/visual/zero-request-replay.js";
/** Capture actual mounted diagram primitives in each qualified browser. */
export const diagramCapture: BrowserCommand<[string, string]> = async (ctx,selector,name) => {
 const started=performance.now();const mark=(stage:string)=>console.log("REPRO2278_CAPTURE",JSON.stringify({name,engine:ctx.page.context().browser()!.browserType().name(),stage,wallAt:new Date().toISOString(),elapsed:performance.now()-started}));mark("start");
 if(!/^[a-z0-9-]+$/.test(name))throw Error("Invalid artifact name");
 const frame=await ctx.frame(), directory=resolve("../../tmp/diagram-renderer-proof");await mkdir(directory,{recursive:true});
 const drawing=await frame.locator(selector).evaluate(element=>({html:element.outerHTML,width:Math.ceil(element.getBoundingClientRect().width),height:Math.ceil(element.getBoundingClientRect().height),theme:element.querySelector("svg")?.getAttribute("data-theme")??"light",styles:[...document.querySelectorAll("style[data-design-fonts],style[data-diagram-capture-consumer]")].map(style=>style.textContent).join("\n")}));
 const engine=ctx.page.context().browser()!.browserType().name(), page=await ctx.context.newPage();
 mark("newPage");const replay=await zeroRequestReplay(page);mark("routes");
 try{
  await page.setViewportSize({width:drawing.width,height:drawing.height});
  await page.setContent(`<html data-theme="${drawing.theme}"><head><style>${drawing.styles}</style><style>body{margin:0}</style></head><body>${drawing.html}</body></html>`);
  mark("setContent");replay.assert("diagram content");
  await page.evaluate(()=>document.fonts.ready);
  mark("fontsReady");replay.assert("diagram fonts");
  await writeFile(resolve(directory,`${name}-${engine}.png`),await page.locator(selector).screenshot());
  mark("screenshotWritten");replay.assert("diagram capture");
 }finally{await page.close();mark("closed");}
};
export const diagramFixture: BrowserCommand<[string?]> = async (_ctx,name) => {
 if(name && !["architecture","flowchart","state-machine","tree","er","dependency","architecture-containment"].includes(name))throw Error("Unknown node-link example");
 return readFile(resolve(name?`../../packages/module-diagrams/skills/diagram/references/examples/${name}.diagram.yaml`:"../../packages/module-diagrams/tests/fixtures/adopted-homecoming-relay.diagram.yaml"),"utf8");
};
declare module "vitest/browser" { interface BrowserCommands { diagramFixture(name?:string):Promise<string>; diagramCapture(selector:string,name:string):Promise<void>; } }
