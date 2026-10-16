import { afterAll, afterEach, beforeAll, expect, test } from "vitest";
import { commands, userEvent } from "vitest/browser";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import axe from "axe-core";
import { diagramsContentPack, DiagramContent } from "../../../module-diagrams/src/ui.js";
import { toStatic } from "../../../module-diagrams/src/render.js";
import { rendererSpec } from "../../../module-diagrams/tests/fixtures/renderer-fixture.js";
import { contentRendererConformance } from "@schlessera/brain-ui-sdk/testing";
import { defaultContentRendererRegistry } from "@schlessera/brain-ui-sdk/client";
import { BrainUiProvider, createBrainUiRoot, type BrainUiRoot, BrainMarkdown } from "@schlessera/brain-ui-react";
let host:HTMLDivElement,render:Root,root:BrainUiRoot,styles:HTMLStyleElement;
const source=JSON.stringify(rendererSpec), originalTheme=document.documentElement.dataset.theme;
beforeAll(async()=>{styles=document.createElement("style");styles.textContent=await commands.formConsumerStyles();document.head.append(styles);});
afterAll(()=>styles?.remove());
afterEach(async()=>{await commands.mermaidMedia("screen");if(render)flushSync(()=>render.unmount());root?.dispose();host?.remove();defaultContentRendererRegistry.reset();document.documentElement.dataset.theme=originalTheme;});
function setup(width=1000){root=createBrainUiRoot({storage:null,request:async()=>Response.json({renderers:[],enabled:[]})});root.stores.file.setState({wikilinkMap:{"raft-build":"notes/raft-build.md"},wikilinkLoaded:true});host=document.createElement("div");host.style.width=`${width}px`;document.body.append(host);render=createRoot(host);}
function mount(element:React.ReactNode){flushSync(()=>render.render(<BrainUiProvider root={root}>{element}</BrainUiProvider>));}
function screenSvg(){return host.querySelector<SVGSVGElement>('figure > svg.bk-diagram');}
async function ready(){await expect.poll(()=>screenSvg()).not.toBeNull();await document.fonts.ready;}
function fontFloor(svg:SVGSVGElement){for(const text of svg.querySelectorAll("text")){const matrix=text.getScreenCTM()!;const scale=Math.min(Math.hypot(matrix.a,matrix.b),Math.hypot(matrix.c,matrix.d));expect(parseFloat(getComputedStyle(text).fontSize)*scale,"ACTUAL_DISPLAYED_TEXT_FLOOR").toBeGreaterThanOrEqual(9);}}
test("registered chat fence renders and follows live light/dark and actual print media",async()=>{
 setup();defaultContentRendererRegistry.register(diagramsContentPack);document.documentElement.dataset.theme="light";root.stores.ui.setState({theme:"light"});
 mount(<BrainMarkdown content={'```diagram\n'+source+'\n```'}/>);await ready();
 const svg=screenSvg()!;expect(svg.querySelectorAll("[data-diagram-node]").length).toBe(2);expect(getComputedStyle(svg).backgroundColor).toBe("rgb(248, 245, 239)");fontFloor(svg);
 flushSync(()=>{document.documentElement.dataset.theme="dark";root.stores.ui.setState({theme:"dark"});});await expect.poll(()=>getComputedStyle(screenSvg()!).backgroundColor).toBe("rgb(20, 22, 25)");
 const production=await toStatic(source,{theme:"dark"});const parsed=new DOMParser().parseFromString(production,"image/svg+xml");
 const geometry=(element:ParentNode)=>[...element.querySelectorAll("[data-diagram-node] rect:not(.bk-diagram-node-focus),[data-diagram-edge] path")].map(item=>[item.localName,...["x","y","width","height","d"].map(name=>item.getAttribute(name))]);
 expect(geometry(screenSvg()!),"CLIENT_STATIC_IDENTICAL_GEOMETRY").toEqual(geometry(parsed));
 await commands.mermaidMedia("print");const paper=host.querySelector<SVGSVGElement>(".bk-diagram-print svg")!;expect(getComputedStyle(paper).backgroundColor,"ACTUAL_PRINT_WHITE").toBe("rgb(255, 255, 255)");expect(getComputedStyle(paper.querySelector("text")!).fill).toBe("rgb(35, 31, 26)");
});
test("actual constrained containers select authored layout or semantic fallback, never shrink below9",async()=>{
 setup(720);mount(<DiagramContent source={source} mode="chat" theme="light"/>);await ready();expect(screenSvg()!.dataset.diagramLayout).toBe("narrow");fontFloor(screenSvg()!);
 for(const width of [320,480,900]){host.style.width=`${width}px`;await expect.poll(()=>screenSvg()?.getBoundingClientRect().width).toBe(320);fontFloor(screenSvg()!);expect(host.scrollWidth).toBeLessThanOrEqual(width);}
 const absent=structuredClone(rendererSpec);delete (absent as {layouts?:unknown}).layouts;host.style.width="320px";mount(<DiagramContent source={JSON.stringify(absent)} mode="chat" theme="dark"/>);await expect.poll(()=>screenSvg()).toBeNull();expect(host.querySelector("[data-diagram-summary]")?.textContent).toBe(rendererSpec.desc);
 const opener=[...host.querySelectorAll<HTMLElement>("[role=button],button")].find(item=>item.textContent==="Open diagram")!;expect(opener.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);await userEvent.click(opener);
 await expect.poll(()=>document.querySelector('[aria-label="Diagram viewer"] svg')).not.toBeNull();const drawing=document.querySelector<SVGSVGElement>('[aria-label="Diagram viewer"] svg')!;fontFloor(drawing);await userEvent.keyboard("{Escape}");
});
test("keyboard nodes navigate like wiki links and incident edges and focus ring remain visible",async()=>{
 setup();const paths:string[]=[];root.stores.file.setState({openFile:async(path)=>{paths.push(path);}});mount(<DiagramContent source={source} theme="light" mode="chat"/>);await ready();
 for(const node of screenSvg()!.querySelectorAll<SVGGElement>('[data-diagram-node][role="link"]')){node.focus();await expect.poll(()=>document.activeElement).toBe(node);expect(getComputedStyle(node.querySelector('.bk-diagram-node-focus')!).visibility,"VISIBLE_NODE_FOCUS_RING").toBe("visible");expect(screenSvg()!.querySelector("[data-highlighted]"),"INCIDENT_EDGE_FOCUS").not.toBeNull();await userEvent.keyboard("{Enter}");}
 expect(paths,"REAL_WIKI_RESOLUTION_AND_PATH_NAVIGATION").toEqual(["notes/raft-build.md","notes/ithaca.md"]);
 for(const theme of ["light","dark"] as const){mount(<DiagramContent source={source} theme={theme} mode="chat"/>);await ready();expect((await axe.run(host,{rules:{region:{enabled:false}}})).violations,"DIAGRAM_AXE").toEqual([]);}
});
test("real pack satisfies contentRendererConformance through client/static modes and themes",async()=>{
 setup();await contentRendererConformance(diagramsContentPack,{cases:[{renderer:0,source}],async mount(entry,props){mount(<entry.Component {...props}/>);await ready();return {element:screenSvg()!,dispose(){flushSync(()=>render.render(null));}};}});
});

test("multiple static and client figures keep independent accessible names without duplicate IDs",async()=>{
 setup(1000);const second=structuredClone(rendererSpec);second.title="Ithaca arrival";second.desc="Penelope receives the voyage note.";const alternate=JSON.stringify(second);
 mount(<><DiagramContent source={source} theme="light" mode="chat"/><DiagramContent source={alternate} theme="light" mode="chat"/></>);await ready();
 const staticHost=document.createElement("div");host.append(staticHost);staticHost.innerHTML=(await toStatic(source,{theme:"print"}))+(await toStatic(alternate,{theme:"print"}))+(await toStatic(source,{theme:"print"}));
 const ids=[...host.querySelectorAll("[id]")].map(node=>node.id);expect(new Set(ids).size,"NO_DUPLICATE_FIGURE_IDS").toBe(ids.length);
 expect([...staticHost.querySelectorAll("svg")].map(svg=>svg.getAttribute("aria-label"))).toEqual([rendererSpec.title,second.title,rendererSpec.title]);expect([...staticHost.querySelectorAll("svg")].map(svg=>svg.getAttribute("aria-description"))).toEqual([rendererSpec.desc,second.desc,rendererSpec.desc]);
 const clients=[...host.querySelectorAll('figure > svg')];expect(clients.map(svg=>svg.querySelector("title")!.textContent)).toEqual([rendererSpec.title,second.title]);
});

test("per-figure SVG PNG and PDF actions use the existing print share path",async()=>{
 setup();const requests:{format:string;content:string}[]=[],files:File[]=[];
 const share=Object.getOwnPropertyDescriptor(navigator,"share"),canShare=Object.getOwnPropertyDescriptor(navigator,"canShare");
 Object.defineProperty(navigator,"canShare",{configurable:true,value:()=>true});Object.defineProperty(navigator,"share",{configurable:true,value:async(data:ShareData)=>{files.push(...data.files??[]);}});
 root.request=async(_url,init)=>{const body=JSON.parse(String(init?.body));requests.push(body);return new Response(new Uint8Array([1,2,3]),{headers:{"content-type":body.format==="png"?"image/png":"application/pdf"}});};
 try{
 mount(<DiagramContent source={source} theme="dark" mode="chat"/>);await ready();
 for(const label of ["Image (PNG)","PDF","Vector (SVG)"]){await userEvent.click(host.querySelector('[aria-label="Share diagram"]')!);await userEvent.click([...host.querySelectorAll('[role="menuitem"]')].find(item=>item.textContent?.includes(label))!);await expect.poll(()=>files.length).toBe(["Image (PNG)","PDF","Vector (SVG)"].indexOf(label)+1);}
 expect(requests.map(item=>item.format),"SHARE_USES_EXISTING_RENDER_ROUTE").toEqual(["png","pdf"]);expect(requests.every(item=>item.content.includes('data-theme="print"'))).toBe(true);expect(files.map(file=>file.type)).toEqual(["image/png","application/pdf","image/svg+xml"]);expect(await files[2]!.text()).toContain('data-theme="print"');
 }finally{if(share)Object.defineProperty(navigator,"share",share);else delete (navigator as {share?:unknown}).share;if(canShare)Object.defineProperty(navigator,"canShare",canShare);else delete (navigator as {canShare?:unknown}).canShare;}
});

test("320px viewer brings an offscreen linked keyboard target into view before navigation",async()=>{
 const previous=await commands.formViewport(320,720);
 try{
 setup(320);const paths:string[]=[];root.stores.file.setState({openFile:async(path)=>{paths.push(path);}});const absent=structuredClone(rendererSpec);delete (absent as {layouts?:unknown}).layouts;
 mount(<DiagramContent source={JSON.stringify(absent)} theme="dark" mode="chat"/>);await expect.poll(()=>host.querySelector("[data-diagram-summary]")).not.toBeNull();await userEvent.click(host.querySelector('[role="button"]')!);
 await expect.poll(()=>document.querySelector('[aria-label="Diagram viewer"] [data-diagram-node="raft"]')).not.toBeNull();
 const node=document.querySelector<SVGGElement>('[aria-label="Diagram viewer"] [data-diagram-node="raft"]')!;
 const stage=node.closest("svg")!.parentElement!.parentElement!;const before=node.getBoundingClientRect(),bounds=stage.getBoundingClientRect();expect(before.left<bounds.left||before.right>bounds.right,"CONTROL_NODE_STARTS_OFFSCREEN").toBe(true);
 node.focus();await expect.poll(()=>{const target=node.getBoundingClientRect(),frame=stage.getBoundingClientRect();return target.left>=frame.left&&target.right<=frame.right&&target.top>=frame.top&&target.bottom<=frame.bottom;},"KEYBOARD_TARGET_REVEALED_IN_VIEWER").toBe(true);
 fontFloor(node.closest("svg")!);expect(getComputedStyle(node.querySelector('.bk-diagram-node-focus')!).visibility).toBe("visible");await userEvent.keyboard("{Enter}");expect(paths).toEqual(["notes/raft-build.md"]);await userEvent.keyboard("{Escape}");
 }finally{await commands.formViewport(previous.width,previous.height);}
});

test("the exact adopted eight-node relay fits both authored layouts with real font bounds",async()=>{
 setup(720);const adopted=await commands.diagramFixture();
 for(const width of [720,320])for(const theme of ["light","dark","print"] as const){
 host.style.width=`${width}px`;mount(<DiagramContent source={adopted} theme={theme} mode="chat"/>);await ready();const svg=screenSvg()!;
 expect(svg.querySelectorAll("[data-diagram-node]").length,"ADOPTED_EIGHT_DISTINCT_NODES").toBe(8);expect(svg.querySelectorAll("[data-diagram-edge]").length).toBe(7);fontFloor(svg);
 for(const group of svg.querySelectorAll("[data-diagram-node]")){const box=group.querySelector<SVGRectElement>("rect")!.getBBox();for(const label of group.querySelectorAll("text")){const bounds=label.getBBox();expect(bounds.x,"NODE_TEXT_LEFT_FIT").toBeGreaterThanOrEqual(box.x);expect(bounds.x+bounds.width,"NODE_TEXT_RIGHT_FIT").toBeLessThanOrEqual(box.x+box.width);expect(bounds.y,"NODE_TEXT_TOP_FIT").toBeGreaterThanOrEqual(box.y);expect(bounds.y+bounds.height,"NODE_TEXT_BOTTOM_FIT").toBeLessThanOrEqual(box.y+box.height);}}
 for(const label of svg.querySelectorAll<SVGTextElement>("[data-edge-label]")){const mask=svg.querySelector<SVGRectElement>(`[data-edge-mask="${label.dataset.edgeLabel}"]`)!.getBBox(),bounds=label.getBBox();expect(bounds.x).toBeGreaterThanOrEqual(mask.x);expect(bounds.x+bounds.width,"ACTUAL_LABEL_FITS_OPAQUE_MASK").toBeLessThanOrEqual(mask.x+mask.width);expect(bounds.y).toBeGreaterThanOrEqual(mask.y);expect(bounds.y+bounds.height).toBeLessThanOrEqual(mask.y+mask.height);}
 expect(host.scrollWidth).toBeLessThanOrEqual(width);await commands.diagramCapture('[data-content-renderer="diagram"]',`relay-${width}-${theme}`);
 }
});
