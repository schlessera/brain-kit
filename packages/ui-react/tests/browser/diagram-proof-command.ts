/// <reference types="@vitest/browser-playwright" />
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { BrowserCommand } from "vitest/node";
import { zeroRequestReplay } from "../../../ui-kit/tests/visual/zero-request-replay.js";

type CapturePhase = "source" | "create-page" | "replay-guard" | "viewport" | "content" | "fonts" | "screenshot" | "close";
/** A test deadline does not identify which awaited browser operation is active.
 * Keep bounded progress evidence without changing that deadline or cancelling work.
 * Never log the drawing, selectors, paths or browser error messages. */
function captureTrace(engine: string, artifact: string) {
 const started = performance.now();
 const marker = (stage: string, extra: Record<string,unknown> = {}) => console.log("CALLOUT_COMMAND_STAGE", JSON.stringify({artifact, engine, stage, epochMs:Date.now(), monotonicMs:performance.now(), ...extra}));
 const phases: { phase: CapturePhase; elapsedMs: number }[] = [];
 let current: CapturePhase = "source", failedPhase: CapturePhase | undefined;
 const report = (event: "start" | "pending" | "complete" | "failed") => console.log("DIAGRAM_CAPTURE_STAGE", JSON.stringify({
  engine, artifact: artifact.slice(0, 96), event, phase: event === "failed" ? failedPhase ?? current : current,
  elapsedMs: Math.round(performance.now() - started), phases,
 }));
 report("start");
 return {
  async step<T>(phase: CapturePhase, operation: () => Promise<T>) {
   current = phase; marker(phase+"-start");
   const began = performance.now();
   // One observation per phase, at most eight per invocation. This timer only
   // reports; it neither races nor aborts the browser operation.
   const observation = setTimeout(() => report("pending"), 5000);
   observation.unref();
   try { return await operation(); }
   catch (error) { failedPhase ??= phase; throw error; }
   finally {
    marker(phase+"-end"); clearTimeout(observation);
    phases.push({ phase, elapsedMs: Math.round(performance.now() - began) });
   }
  },
  marker,
  finish(succeeded: boolean) { report(succeeded ? "complete" : "failed"); },
 };
}

/** Capture actual mounted diagram primitives in each qualified browser. */
export const diagramCapture: BrowserCommand<[string, string]> = async (ctx,selector,name) => {
 if(!/^[a-z0-9-]+$/.test(name))throw Error("Invalid artifact name");
 const engine=ctx.page.context().browser()!.browserType().name(), trace=captureTrace(engine,name);
 let succeeded=false;
 try {
  const directory=resolve("../../tmp/diagram-renderer-proof");
  const drawing=await trace.step("source",async()=>{
   const frame=await ctx.frame();await mkdir(directory,{recursive:true});
   return frame.locator(selector).evaluate(element=>({hiddenPrintBytes:new TextEncoder().encode(element.querySelector(".bk-diagram-print")?.outerHTML??"").length,html:element.outerHTML,width:Math.ceil(element.getBoundingClientRect().width),height:Math.ceil(element.getBoundingClientRect().height),theme:element.querySelector("svg")?.getAttribute("data-theme")??"light",styles:[...document.querySelectorAll("style[data-design-fonts],style[data-diagram-capture-consumer]")].map(style=>style.textContent).join("\n")}));
  });
  trace.marker("source-bytes", {markupBytes:Buffer.byteLength(drawing.html), stylesBytes:Buffer.byteLength(drawing.styles), hiddenPrintBytes:drawing.hiddenPrintBytes, width:drawing.width, height:drawing.height});
  const page=await trace.step("create-page",()=>ctx.context.newPage());
  try {
   const replay=await trace.step("replay-guard",()=>zeroRequestReplay(page));
   await trace.step("viewport",()=>page.setViewportSize({width:drawing.width,height:drawing.height}));
   await trace.step("content",async()=>{await page.setContent(`<html data-theme="${drawing.theme}"><head><style>${drawing.styles}</style><style>body{margin:0}</style></head><body>${drawing.html}</body></html>`);replay.assert("diagram content");});
   await trace.step("fonts",async()=>{await page.evaluate(()=>document.fonts.ready);replay.assert("diagram fonts");});
   await trace.step("screenshot",async()=>{trace.marker("image-capture-start"); const png=await page.locator(selector).screenshot(); trace.marker("image-capture-return", {pngBytes:png.length, pngWidth:png.readUInt32BE(16), pngHeight:png.readUInt32BE(20)}); trace.marker("png-write-start"); await writeFile(resolve(directory,`${name}-${engine}.png`),png); trace.marker("png-write-return"); trace.marker("capture-guard-start"); replay.assert("diagram capture"); trace.marker("capture-guard-return");});
  }finally{await trace.step("close",()=>page.close());}
  succeeded=true;
 }finally{trace.finish(succeeded);}
};
export const diagramFixture: BrowserCommand<[string?]> = async (_ctx,name) => {
 if(name && !["architecture","flowchart","state-machine","tree","er","dependency","architecture-containment"].includes(name))throw Error("Unknown node-link example");
 return readFile(resolve(name?`../../packages/module-diagrams/skills/diagram/references/examples/${name}.diagram.yaml`:"../../packages/module-diagrams/tests/fixtures/adopted-homecoming-relay.diagram.yaml"),"utf8");
};
declare module "vitest/browser" { interface BrowserCommands { diagramFixture(name?:string):Promise<string>; diagramCapture(selector:string,name:string):Promise<void>; } }
