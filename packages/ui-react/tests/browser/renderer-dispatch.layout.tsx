import { afterEach, beforeAll, afterAll, expect, test } from "vitest";
import { commands, page } from "vitest/browser";
import { lazy } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import axe from "axe-core";
import { defaultContentRendererRegistry, registerContentRenderers } from "@schlessera/brain-ui-sdk/client";
import { BrainUiProvider } from "../../src/root-context.js";
import { createBrainUiRoot, type BrainUiRoot } from "../../src/root.js";
import { BrainMarkdown } from "../../src/components/chat/brain-markdown.js";
import { FileViewer } from "../../src/components/files/file-viewer.js";
import { ContentRendererDeclarations, ContentRendererSurface } from "../../src/components/content-renderer.js";

let host: HTMLDivElement, renderer: Root, root: BrainUiRoot, styles: HTMLStyleElement;
const originalTheme = document.documentElement.dataset.theme;
beforeAll(async () => { styles=document.createElement("style");styles.textContent=await commands.formConsumerStyles();document.head.append(styles); });
afterAll(()=>{styles.remove();});
afterEach(()=>{if(renderer)flushSync(()=>renderer.unmount());root?.dispose();host?.remove();defaultContentRendererRegistry.reset();document.documentElement.dataset.theme=originalTheme;});
function mount(content: string, theme: "light"|"dark"="light", file?: string) {
  document.documentElement.dataset.theme=theme;
  root=createBrainUiRoot({storage:null,request:async()=>Response.json({})});root.stores.ui.setState({theme});
  host=document.createElement("div");host.style.cssText="background:var(--bk-color-canvas);color:var(--bk-color-ink);width:640px";document.body.append(host);renderer=createRoot(host);
  if(file) root.stores.file.setState({currentPath:file,currentContent:{path:file,kind:file.endsWith(".md")?"markdown":"text",content,size:content.length,mtime:Date.parse("2026-07-12T00:00:00Z")},contentLoading:false,viewMode:"preview"});
  render(content,!!file);
}
function render(content: string, file=false) { flushSync(()=>renderer.render(<BrainUiProvider root={root}><ContentRendererDeclarations.Provider value={[{fences:["absent"],extensions:[".absent"]}]}>{file?<FileViewer/>:<BrainMarkdown content={content}/>}</ContentRendererDeclarations.Provider></BrainUiProvider>)); }
function register() {
  const Component=lazy(()=>import("./renderer-demo-chunk.js"));
  registerContentRenderers({renderers:[{languages:["demo"],extensions:[".demo",".figure.md"],needsBrowser:false,Component,toStatic:async()=>""}]});
}
test("pack chunk is requested only when its matching fence first appears", async()=>{
  await commands.startRequestLog();register();mount("Odysseus waits.");
  expect((await commands.requestLog()).filter(url=>url.includes("renderer-demo-chunk"))).toEqual([]);
  render("```demo\nThe homecoming relay\n```");
  expect(host.querySelector('[data-kit-code-block]')?.textContent).toContain("The homecoming relay");
  await expect.poll(()=>host.querySelector("figure")?.textContent).toBe("The homecoming relay");
  const chunkRequests=(await commands.requestLog()).filter(url=>url.includes("renderer-demo-chunk"));expect(chunkRequests.length).toBeGreaterThan(0);
  render("```demo\nTelemachus returns\n```\n\n```demo\nThe fleet returns\n```");
  await expect.poll(()=>host.querySelectorAll("figure").length).toBe(2);
  expect((await commands.requestLog()).filter(url=>url.includes("renderer-demo-chunk"))).toEqual(chunkRequests);
  expect(host.querySelector("figure")?.getAttribute("data-renderer-mode")).toBe("chat");
  document.documentElement.dataset.theme="dark";root.stores.ui.setState({theme:"dark"});
  await expect.poll(()=>host.querySelector("figure")?.getAttribute("data-renderer-theme")).toBe("dark");
});
for(const theme of ["light","dark"] as const) test(`${theme}: throwing block falls back locally, sibling renders and axe passes`,async()=>{
  register();mount("Before the crossing.\n\n```demo\nthrow\n```\n\n```demo\nTelemachus waits\n```\n\nAfter the crossing.",theme);
  await expect.poll(()=>host.querySelector('[role="status"]')?.textContent).toBe("Renderer failed. Showing source code.");
  expect(host.textContent).toContain("Before the crossing.");expect(host.textContent).toContain("After the crossing.");
  expect(host.querySelector('[data-kit-code-block]')?.textContent).toContain("throw");
  expect(host.querySelector("figure")?.getAttribute("data-renderer-theme")).toBe(theme);
  expect(host.querySelector("figure")?.textContent).toBe("Telemachus waits");
  expect((await axe.run(host,{rules:{region:{enabled:false}}})).violations.map(v=>v.id)).toEqual([]);
  await page.screenshot({element:host,path:`../../.vitest-attachments/renderer-dispatch/${theme}.png`});
});
test("markdown file fences and standalone extensions receive file mode and path; raw view stays source",async()=>{
  register();mount("```demo\nThe raft manifest\n```","light","notes/raft.md");
  await expect.poll(()=>host.querySelector("figure")?.getAttribute("data-renderer-mode")).toBe("file");
  expect(host.querySelector("figure")?.getAttribute("data-renderer-path")).toBe("notes/raft.md");
  root.stores.file.setState({currentPath:"notes/raft.demo",currentContent:{path:"notes/raft.demo",kind:"text",content:"Sail home",size:9,mtime:Date.parse("2026-07-12T00:00:00Z")}});
  await expect.poll(()=>host.querySelector("figure")?.textContent).toBe("Sail home");
  expect(host.querySelector("figure")?.getAttribute("data-renderer-path")).toBe("notes/raft.demo");
  root.stores.file.setState({currentPath:"notes/raft.figure.md",currentContent:{path:"notes/raft.figure.md",kind:"markdown",content:"Sail home",size:9,mtime:Date.parse("2026-07-12T00:00:00Z")}});
  await expect.poll(()=>host.querySelector("figure")?.getAttribute("data-renderer-path")).toBe("notes/raft.figure.md");
  root.stores.file.setState({viewMode:"raw"});await expect.poll(()=>host.querySelector("figure")).toBeNull();expect(host.textContent).toContain("Sail home");
});
test("declared missing fence and file pack show source with accessible unbundled note",async()=>{
  mount("```absent\nThe missing fleet\n```");
  expect(host.querySelector('[role="status"]')?.textContent).toBe("Renderer not bundled.");expect(host.textContent).toContain("The missing fleet");
  root.stores.file.setState({currentPath:"fleet.absent",currentContent:{path:"fleet.absent",kind:"text",content:"The missing fleet",size:17,mtime:Date.parse("2026-07-12T00:00:00Z")},contentLoading:false,viewMode:"preview"});render("",true);
  expect([...host.querySelectorAll('[role="status"]')].some(note=>note.textContent==="Renderer not bundled.")).toBe(true);
});
test("share surface passes print theme to a matched component",async()=>{
  register();mount("");flushSync(()=>renderer.render(<BrainUiProvider root={root}><ContentRendererSurface.Provider value={{mode:"share"}}><BrainMarkdown content={"```demo\nHomecoming\n```"}/></ContentRendererSurface.Provider></BrainUiProvider>));
  await expect.poll(()=>host.querySelector("figure")?.getAttribute("data-renderer-theme")).toBe("print");expect(host.querySelector("figure")?.getAttribute("data-renderer-mode")).toBe("share");
});
