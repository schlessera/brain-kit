import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "vitest";
import { commands, page } from "vitest/browser";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { BrainUiProvider } from "../../src/root-context.js";
import { createBrainUiRoot, type BrainUiRoot } from "../../src/root.js";
import { registerBuiltinRenderers } from "../../src/components/chat/renderers/index.js";
import { renderBlockHtml } from "../../src/components/chat/share-document.js";
import type { Block } from "@schlessera/brain-ui-sdk/client";

let renderer: Root | undefined, root: BrainUiRoot | undefined, host: HTMLDivElement | undefined, styles: HTMLStyleElement;
let viewport: { width: number; height: number }, outer: { width: number; height: number }, themeBefore: string | undefined;
beforeEach(() => { viewport = { width: innerWidth, height: innerHeight }; themeBefore = document.documentElement.dataset.theme; });
beforeAll(async () => { styles = document.createElement("style"); styles.textContent = await commands.formConsumerStyles(); document.head.append(styles); });
afterAll(() => styles.remove());
afterEach(async () => { if (renderer) flushSync(() => renderer!.unmount()); root?.dispose(); host?.remove(); renderer = undefined; root = undefined; host = undefined;
  document.documentElement.dataset.theme = themeBefore; await page.viewport(viewport.width, viewport.height);
  if (outer) await commands.formViewport(outer.width - 100, outer.height - 120);
});
const block: Block = { kind:"graph",title:"Connections at the crossing",nodes:Array.from({length:20},(_,i)=>({label:i===10?"Charybdis".repeat(9).slice(0,80):`Scylla route ${i+1}`,focus:i===10,path:i===0?"knowledge/scylla.md":i===1?"javascript:alert(1)":undefined})),edges:[...Array.from({length:20},(_,i)=>[i,(i+1)%20] as [number,number]),...Array.from({length:20},(_,i)=>[i,(i+2)%20] as [number,number])],legend:Array.from({length:7},(_,i)=>({label:`Crossing ${i+1} `+"Scylla".repeat(4),tone:"teal" as const})),meta:"20 notes"};
function checkGeometry(host:HTMLElement){
  const graph=host.querySelector<HTMLElement>('[data-graph-view]')!;
  const nodes=[...graph.querySelectorAll<HTMLElement>('[data-graph-node]')];expect(nodes).toHaveLength(20);expect(graph.querySelectorAll("line")).toHaveLength(40);
  expect(nodes[10]!.textContent).toBe("Charybdis".repeat(9).slice(0,80));
  const box=graph.getBoundingClientRect();expect(box.width).toBeGreaterThan(200);expect(box.height).toBeGreaterThan(200);
  for(let i=0;i<nodes.length;i++){
    const a=nodes[i]!.getBoundingClientRect();expect(a.width).toBeGreaterThan(0);expect(a.height).toBeGreaterThan(0);
    expect(a.left).toBeGreaterThanOrEqual(box.left);expect(a.right).toBeLessThanOrEqual(box.right);expect(a.top).toBeGreaterThanOrEqual(box.top);expect(a.bottom).toBeLessThanOrEqual(box.bottom);
    expect(nodes[i]!.scrollWidth,"full node label fits").toBeLessThanOrEqual(nodes[i]!.clientWidth+1);
    for(let j=i+1;j<nodes.length;j++){const b=nodes[j]!.getBoundingClientRect();expect(a.left<b.right&&a.right>b.left&&a.top<b.bottom&&a.bottom>b.top,`node labels ${i}/${j} overlap`).toBe(false);}
  }
  expect(host.scrollWidth).toBeLessThanOrEqual(host.clientWidth+1);
}
for(const width of [320,1280]) for(const theme of ["dark","light"]){
  for(const [backend,name] of [["pi","show_block"],["claude","mcp__brain-ui__show_block"]] as const){
    test(`${theme} ${width} ${backend}: maximum supplied graph has distinct visible labels and exactly 40 edges`,async()=>{
      outer=await commands.formViewport(width,800);await page.viewport(width,800);document.documentElement.dataset.theme=theme;
      const requested:string[]=[];root=createBrainUiRoot({storage:null,request:async url=>{requested.push(String(url));throw new Error("graph must not look up data");}});registerBuiltinRenderers(root.renderers);
      host=document.createElement("div");host.style.cssText=`width:${Math.min(width,720)}px;overflow-wrap:normal;background:var(--bk-color-canvas);color:var(--bk-color-ink)`;document.body.append(host);renderer=createRoot(host);
      const tool={id:"graph",name,input:{block},output:JSON.stringify({block})};const Output=root.renderers.resolve(tool,backend)!.Output!;
      flushSync(()=>renderer!.render(<BrainUiProvider root={root}><Output tool={tool}/></BrainUiProvider>));
      checkGeometry(host);expect(host.querySelectorAll('[data-graph-node-list] li')).toHaveLength(20);expect(host.querySelectorAll('[data-graph-edge-list] li')).toHaveLength(40);
      expect([...host.querySelectorAll("a")].map(a=>a.getAttribute("href"))).toEqual(["#/files/knowledge/scylla.md"]);expect(requested).toEqual([]);expect(host.querySelector("a")!.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
      if(backend==="pi"){await page.viewport(width,Math.ceil(host.scrollHeight)+32);await page.screenshot({element:host,path:`../../.vitest-attachments/inline-graph/${theme}-${width}.png`});}
    });
  }
  test(`${theme} ${width}: actual static graph export retains its complete supplied topology`,async()=>{
    outer=await commands.formViewport(width,800);await page.viewport(width,800);document.documentElement.dataset.theme=theme;
    host=document.createElement("div");host.style.cssText=`width:${Math.min(width,720)}px;overflow-wrap:normal;background:var(--bk-color-canvas);color:var(--bk-color-ink)`;document.body.append(host);host.innerHTML=await renderBlockHtml(block);
    checkGeometry(host);expect(host.querySelectorAll('[data-graph-node-list] li')).toHaveLength(20);expect(host.querySelectorAll('[data-graph-edge-list] li')).toHaveLength(40);expect(host.querySelectorAll("a,button,[role=button]")).toHaveLength(0);
  });
}
