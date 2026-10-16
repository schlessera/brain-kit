/// <reference types="@vitest/browser-playwright" />
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { BrowserCommand } from "vitest/node";
import { zeroRequestReplay } from "../../../ui-kit/tests/visual/zero-request-replay.js";
/** Capture actual mounted diagram primitives in each qualified browser. */
export const diagramCapture: BrowserCommand<[string, string]> = async (ctx,selector,name) => {
 if(!/^[a-z0-9-]+$/.test(name))throw Error("Invalid artifact name");
 const frame=await ctx.frame(), directory=resolve("../../tmp/diagram-renderer-proof");await mkdir(directory,{recursive:true});
 const drawing=await frame.locator(selector).evaluate(element=>({html:element.outerHTML,width:Math.ceil(element.getBoundingClientRect().width),height:Math.ceil(element.getBoundingClientRect().height),theme:element.querySelector("svg")?.getAttribute("data-theme")??"light",styles:[...document.querySelectorAll("style[data-design-fonts],style[data-diagram-capture-consumer]")].map(style=>style.textContent).join("\n")}));
 const engine=ctx.page.context().browser()!.browserType().name(), page=await ctx.context.newPage();
 const replay=await zeroRequestReplay(page);
 try{
  await page.setViewportSize({width:drawing.width,height:drawing.height});
  await page.setContent(`<html data-theme="${drawing.theme}"><head><style>${drawing.styles}</style><style>body{margin:0}</style></head><body>${drawing.html}</body></html>`);
  replay.assert("diagram content");
  await page.evaluate(()=>document.fonts.ready);
  replay.assert("diagram fonts");
  await writeFile(resolve(directory,`${name}-${engine}.png`),await page.locator(selector).screenshot());
  replay.assert("diagram capture");
 }finally{await page.close();}
};
export const diagramFixture: BrowserCommand<[]> = async () => readFile(resolve("../../packages/module-diagrams/tests/fixtures/adopted-homecoming-relay.diagram.yaml"),"utf8");
declare module "vitest/browser" { interface BrowserCommands { diagramFixture():Promise<string>; diagramCapture(selector:string,name:string):Promise<void>; } }
