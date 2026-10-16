/// <reference types="@vitest/browser-playwright" />
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { BrowserCommand } from "vitest/node";
/** Capture actual mounted diagram primitives in each qualified browser. */
export const diagramCapture: BrowserCommand<[string, string]> = async (ctx,selector,name) => {
 if(!/^[a-z0-9-]+$/.test(name))throw Error("Invalid artifact name");
 const frame=await ctx.frame(), directory=resolve("../../tmp/diagram-renderer-proof");await mkdir(directory,{recursive:true});
 const drawing=await frame.locator(selector).evaluate(element=>({html:element.outerHTML,width:Math.ceil(element.getBoundingClientRect().width),height:Math.ceil(element.getBoundingClientRect().height),theme:element.querySelector("svg")?.getAttribute("data-theme")??"light",styles:[...document.querySelectorAll("style[data-design-fonts],style[data-diagram-capture-consumer]")].map(style=>style.textContent).join("\n")}));
 const engine=ctx.page.context().browser()!.browserType().name(), page=await ctx.context.newPage();
 await page.route("**/*",route=>route.abort());
 try{
  await page.setViewportSize({width:drawing.width,height:drawing.height});
  await page.setContent(`<html data-theme="${drawing.theme}"><head><style>${drawing.styles}</style><style>body{margin:0}</style></head><body>${drawing.html}</body></html>`);
  await page.evaluate(()=>document.fonts.ready);
  await writeFile(resolve(directory,`${name}-${engine}.png`),await page.locator(selector).screenshot());
 }finally{await page.close();}
};
export const diagramFixture: BrowserCommand<[string?]> = async (_ctx,name) => {
 if(name && !["architecture","flowchart","state-machine","tree","er","dependency","architecture-containment"].includes(name))throw Error("Unknown node-link example");
 return readFile(resolve(name?`../../packages/module-diagrams/skills/diagram/references/examples/${name}.diagram.yaml`:"../../packages/module-diagrams/tests/fixtures/adopted-homecoming-relay.diagram.yaml"),"utf8");
};
declare module "vitest/browser" { interface BrowserCommands { diagramFixture(name?:string):Promise<string>; diagramCapture(selector:string,name:string):Promise<void>; } }
