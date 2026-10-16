/// <reference types="@vitest/browser-playwright" />
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { BrowserCommand } from "vitest/node";
/** Capture actual mounted diagram primitives in each qualified browser. */
export const diagramCapture: BrowserCommand<[string, string]> = async (ctx,selector,name) => {
 if(!/^[a-z0-9-]+$/.test(name))throw Error("Invalid artifact name");
 const frame=await ctx.frame(), directory=resolve("../../tmp/diagram-renderer-proof");await mkdir(directory,{recursive:true});
 const engine=ctx.page.context().browser()!.browserType().name();
 await writeFile(resolve(directory,`${name}-${engine}.png`),await frame.locator(selector).screenshot());
};
export const diagramFixture: BrowserCommand<[]> = async () => readFile(resolve("../../packages/module-diagrams/tests/fixtures/homecoming-relay.diagram.yaml"),"utf8");
declare module "vitest/browser" { interface BrowserCommands { diagramFixture():Promise<string>; diagramCapture(selector:string,name:string):Promise<void>; } }
