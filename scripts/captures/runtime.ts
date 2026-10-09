import { APPROVAL_CONTENT } from "./fixture-data.ts";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { Browser } from "playwright";
import { awaitFonts, capturePage, inspectPng, visibleText } from "./browser.ts";
import type { Catalogue, Viewport } from "./catalogue.ts";
import { sha256,variantFile } from "./provenance.ts";
import { refreshRuntimeLinkPaint } from "./runtime-paint.ts";

type Harness = Catalogue["harness_requirements"][number];

export async function captureRuntime(browser: Browser, root: string, cache: string, catalogue: Catalogue,
  recipe: Harness, output: string, theme = recipe.theme, viewportOverride?: Viewport,
): Promise<{ files: Array<{ file: string; bytes: number; sha256: string }>; evidence: Record<string, unknown> }> {
  const viewport=viewportOverride ?? recipe.viewport;
  const scratch = await mkdtemp(resolve(tmpdir(), "odysseus-capture-"));
  const child = spawn("/capture-bun", ["--preload", resolve(root,"scripts/captures/clock.ts"), resolve(root,"scripts/captures/runtime-server.ts"),scratch,recipe.id], {
    cwd:root,env:{ PATH:process.env.PATH, TZ:catalogue.environment.timezone },stdio:["ignore","pipe","pipe"],
  });
  let stderr = ""; child.stderr.on("data",(bytes)=>{stderr+=String(bytes);});
  const lines = createInterface({ input:child.stdout });
  const exits = new Promise<void>((done)=>child.once("exit",()=>done()));
  let runtimeBuildHash = "";
  const files: Array<{ file: string; bytes: number; sha256: string }> = [];
  const filename=(name:string)=>variantFile(name,recipe.theme,theme,viewportOverride);
  try {
    const origin = await new Promise<string>((done,reject)=>{
      const timeout = setTimeout(()=>reject(new Error(`Fixture server did not become ready: ${stderr}`)),30_000);
      child.once("error",(error)=>{clearTimeout(timeout);reject(error);});
      child.once("exit",(code)=>{clearTimeout(timeout);reject(new Error(`Fixture server exited ${code}: ${stderr}`));});
      lines.on("line",(line)=>{try{const value=JSON.parse(line);if(value.origin){runtimeBuildHash=value.runtime_build_sha256;clearTimeout(timeout);done(value.origin);}}catch{/* startup logs are not readiness */}});
    });
    const observed: Record<string,unknown> = {};
    for (const decision of recipe.id === "approval-roundtrip" ? ["allow","deny"] : ["search"]) {
      const { context,page,faults,consoleErrors } = await capturePage(browser,root,cache,catalogue,[origin],viewport,theme);
      let phase = "load";
      try {
        await page.goto(origin,{waitUntil:"load"});
        await page.evaluate((theme)=>{document.documentElement.dataset.theme=theme;document.documentElement.classList.toggle("dark",theme==="dark");},theme);
        const fonts=await awaitFonts(page,catalogue);
        const save = async (name:string,required:string[],fullPage=false) => {
          await refreshRuntimeLinkPaint(page);
          const clip = await page.evaluate((full)=>({ x:0,y:0,width:innerWidth,height:full?Math.max(document.documentElement.scrollHeight,innerHeight):innerHeight }),fullPage);
          const missing = await visibleText(page,"body",required,clip,true);
          if(missing.length)throw new Error(`Runtime text is missing or clipped: ${missing.join(", ")}`);
          // A result can be visible before connection/style painting settles.
          // Require consecutive identical actual paints, rather than a delay
          // or a pixel tolerance that could conceal a changing product state.
          let bytes:Buffer=Buffer.alloc(0), identical=0;
          const deadline=Date.now()+5000;
          while(identical<2 && Date.now()<deadline) {
            await page.evaluate(()=>new Promise<void>((done)=>requestAnimationFrame(()=>requestAnimationFrame(()=>done()))));
            const next=await page.screenshot({fullPage,animations:"disabled"});
            identical=bytes.equals(next)?identical+1:0;bytes=next;
          }
          if(identical<2)throw new Error("Runtime paint did not settle to three identical frames");
          const pixels=inspectPng(bytes);
          if(pixels.width!==viewport.width || (!fullPage && pixels.height!==viewport.height))throw new Error("Runtime PNG dimensions differ");
          if(faults.length)throw new Error(faults.join("; "));
          const file=filename(name);await writeFile(resolve(output,file),bytes);files.push({file,bytes:bytes.length,sha256:pixels.sha256});
        };
        if (decision === "search") {
          const evidence=await (await fetch(`${origin}/capture-evidence`)).json() as {transcript:Record<string,unknown>};
          if(!evidence.transcript?.markdown || !evidence.transcript.search)throw new Error("Actual capture/search fixture evidence is empty");
          await save(recipe.outputs[0],["Odysseus’s notebook","Raft supplies","fts","Written Markdown"],true);
          observed.search=evidence.transcript;
          observed.fonts=fonts;
        } else {
          await page.waitForFunction(()=> (window as unknown as {__captureFixture?:{connected():boolean}}).__captureFixture?.connected());
          const composer=page.locator("textarea");
          await composer.fill("Write a raft-supplies note for Odysseus.");await composer.press("Enter");
          const card=page.locator("[data-approval-card]");await card.waitFor({timeout:15_000});
          await card.scrollIntoViewIfNeeded();
          await page.waitForFunction(() => {
            let element: Element | null = document.querySelector("[data-approval-card]");
            if (!element) return false;
            while (element) { if (Number(getComputedStyle(element).opacity) < 0.999) return false; element = element.parentElement; }
            return true;
          });
          const sequence=decision==="allow"?1:2;
          const path=`notes/raft-supplies-${sequence}.md`;
          phase = "before-decision capture";
          await save(`approval-${decision}-before-dark.png`,[path,APPROVAL_CONTENT,"Allow","Deny"]);
          phase = "decision and executor effect";
          await card.getByRole("button",{name:decision==="allow"?"Allow":"Deny",exact:true}).click();
          const message=decision==="allow"?`Written ${path}: ${APPROVAL_CONTENT}`:`Refused ${path}; no file written.`;
          await page.getByText(message,{exact:true}).first().waitFor({timeout:15_000});
          const evidence=await (await fetch(`${origin}/capture-evidence`)).json() as {events:Array<{span_id:string;payload:string}>;files:Array<{path:string;content:string|null}>;history:Record<string,unknown[]>};
          const event=evidence.events.find((event)=>event.span_id===`raft-write-${sequence}`);
          const payload=event?JSON.parse(event.payload).v:undefined;
          if(!payload?.principalId || payload.decision!==decision || payload.channel!=="card")throw new Error(`Recorded ${decision} decision/principal/channel is missing`);
          const file=evidence.files.find((file)=>file.path===path);
          if(!file || (decision==="allow"?file.content!==APPROVAL_CONTENT:file.content!==null))throw new Error(`Executor ${decision} effect differs from the actual decision`);
          if(!evidence.history[`odysseus-approval-${sequence}`]?.length)throw new Error("Persisted backend transcript is empty");
          phase = "after-decision capture";
          await save(`approval-${decision}-after-dark.png`,[message]);
          phase = "reload";
          await page.reload({waitUntil:"load"});
          await page.evaluate((theme)=>{document.documentElement.dataset.theme=theme;document.documentElement.classList.toggle("dark",theme==="dark");},theme);
          await awaitFonts(page,catalogue);
          await page.waitForFunction(()=> (window as unknown as {__captureFixture?:{connected():boolean}}).__captureFixture?.connected());
          await page.getByText(message,{exact:true}).first().waitFor({timeout:15_000});
          phase = "reload capture";
          await save(`approval-${decision}-reload-dark.png`,[message]);
          observed[decision]={tool_use_id:`raft-write-${sequence}`,path,fonts,decision:payload,effect:file,history:evidence.history[`odysseus-approval-${sequence}`]};
        }
      } catch (error) {
        const browserState = await page.evaluate(() => ({
          errors: (window as unknown as { __captureBrowserErrors?: unknown[] }).__captureBrowserErrors ?? [],
          text: document.body?.innerText,
          approvals: [...document.querySelectorAll("[data-approval-card]")].map(card => card.outerHTML),
        })).catch(error => ({ unavailable: String(error) }));
        const hostEvidence = await fetch(`${origin}/capture-evidence`).then(response => response.json())
          .catch(error => ({ unavailable: String(error) }));
        await writeFile(resolve(output, `${recipe.id}-failure.json`), JSON.stringify({
          decision, detected_at: phase, message: (error as Error).message, stack: (error as Error).stack,
          faults, browserState, hostEvidence, consoleErrors: await Promise.all(consoleErrors),
        }, null, 2) + "\n");
        await page.screenshot({path:resolve(output,`${recipe.id}-failure.png`),fullPage:true,animations:"disabled"});
        throw new Error(`${(error as Error).message}; browser faults: ${faults.join("; ")}`);
      } finally { await context.close(); }
    }
    const evidenceFile=filename(recipe.outputs.at(-1)!);
    const bytes=Buffer.from(JSON.stringify(observed,null,2)+"\n");await writeFile(resolve(output,evidenceFile),bytes);
    files.push({file:evidenceFile,bytes:bytes.length,sha256:sha256(bytes)});
    return {files,evidence:{...observed,runtime_build_sha256:runtimeBuildHash}};
  } catch(error){throw new Error(`${recipe.id}: ${(error as Error).message}`);}
  finally {
    lines.close();child.kill("SIGTERM");
    let timeout:ReturnType<typeof setTimeout>|undefined;
    await Promise.race([exits,new Promise<void>((done)=>{timeout=setTimeout(()=>{child.kill("SIGKILL");done();},5000);})]);
    clearTimeout(timeout);await exits;await rm(scratch,{recursive:true,force:true});
  }
}
