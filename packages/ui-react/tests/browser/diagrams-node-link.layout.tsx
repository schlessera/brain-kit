import { afterAll, afterEach, beforeAll, expect, test } from "vitest";
import { commands, page } from "vitest/browser";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import axe from "axe-core";
import { BrainUiProvider, createBrainUiRoot, type BrainUiRoot } from "@schlessera/brain-ui-react";
import { DiagramContent } from "../../../module-diagrams/src/ui.js";
import { toStatic } from "../../../module-diagrams/src/render.js";
let host:HTMLDivElement,render:Root,root:BrainUiRoot,styles:HTMLStyleElement,viewport:{width:number;height:number};
const originalTheme=document.documentElement.dataset.theme;
beforeAll(async()=>{viewport=await commands.formViewport(1280,1200);await page.viewport(1200,1000);styles=document.createElement("style");styles.dataset.diagramCaptureConsumer="";styles.textContent=await commands.formConsumerStyles();document.head.append(styles);});
afterEach(()=>{if(render)flushSync(()=>render.unmount());root?.dispose();host?.remove();document.documentElement.dataset.theme=originalTheme;});
afterAll(async()=>{styles.remove();await commands.formViewport(viewport.width,viewport.height);});
const examples=["architecture","flowchart","state-machine","tree","er","dependency","architecture-containment"] as const;
for(const name of examples)for(const theme of ["light","dark","print"] as const)test(`${name} ${theme} preserves its native type grammar`,async()=>{
 const source=await commands.diagramFixture(name);root=createBrainUiRoot({storage:null,request:async()=>Response.json({renderers:[],enabled:[]})});host=document.createElement("div");host.style.width="1200px";document.body.append(host);render=createRoot(host);document.documentElement.dataset.theme=theme;
 flushSync(()=>render.render(<BrainUiProvider root={root}><DiagramContent source={source} theme={theme} mode="chat"/></BrainUiProvider>));
 await expect.poll(()=>host.querySelector("figure > svg")).not.toBeNull();await document.fonts.ready;
 const svg=host.querySelector<SVGSVGElement>("figure > svg")!;host.style.width=`${svg.width.baseVal.value}px`;
 for(const label of svg.querySelectorAll("text")){const matrix=label.getScreenCTM()!,scale=Math.min(Math.hypot(matrix.a,matrix.b),Math.hypot(matrix.c,matrix.d));expect(parseFloat(getComputedStyle(label).fontSize)*scale,"NODE_LINK_ACTUAL_DISPLAYED_TEXT_FLOOR").toBeGreaterThanOrEqual(9);}
 const authored=JSON.parse(source);
 for(const node of svg.querySelectorAll<SVGGElement>("[data-diagram-node]")){const box=authored.nodes.find((item:{id:string})=>item.id===node.dataset.diagramNode);for(const label of node.querySelectorAll("text")){const bounds=label.getBBox();expect(bounds.x,"ACTUAL_NODE_LINK_TEXT_LEFT").toBeGreaterThanOrEqual(box.at[0]);expect(bounds.x+bounds.width,"ACTUAL_NODE_LINK_TEXT_RIGHT").toBeLessThanOrEqual(box.at[0]+box.size[0]);expect(bounds.y,"ACTUAL_NODE_LINK_TEXT_TOP").toBeGreaterThanOrEqual(box.at[1]);expect(bounds.y+bounds.height,"ACTUAL_NODE_LINK_TEXT_BOTTOM").toBeLessThanOrEqual(box.at[1]+box.size[1]);}}
 for(const group of svg.querySelectorAll("[data-cardinality]")){const mask=group.querySelector<SVGRectElement>("rect")!.getBBox(),label=group.querySelector<SVGTextElement>("text")!.getBBox();expect(label.x,"ACTUAL_CARDINALITY_LEFT").toBeGreaterThanOrEqual(mask.x);expect(label.x+label.width,"ACTUAL_CARDINALITY_RIGHT").toBeLessThanOrEqual(mask.x+mask.width);expect(label.y,"ACTUAL_CARDINALITY_TOP").toBeGreaterThanOrEqual(mask.y);expect(label.y+label.height,"ACTUAL_CARDINALITY_BOTTOM").toBeLessThanOrEqual(mask.y+mask.height);}
 expect(svg.querySelectorAll("[data-diagram-node]").length).toBe(JSON.parse(source).nodes.length);
 if(name==="flowchart"){expect(svg.querySelector('[data-node-shape="decision"]')?.getAttribute("d")).toContain(" Z");expect(svg.querySelector('[data-node-shape="start"]')?.getAttribute("rx")).toBe("24");expect(svg.querySelector('[data-node-shape="merge"]')?.localName).toBe("circle");}
 if(name==="state-machine"){expect(svg.querySelector('[data-node-shape="initial"]')?.getAttribute("r")).toBe("6");expect(svg.querySelector('[data-node-shape="final"]')?.getAttribute("r")).toBe("8");}
 if(name==="er"){expect([...svg.querySelectorAll("[data-cardinality] text")].map(node=>node.textContent)).toEqual(["1","1..*"]);expect([...svg.querySelectorAll("[data-diagram-edge]")].every(group=>group.querySelectorAll("path").length===1),"ER_RELATIONSHIPS_HAVE_NO_DIRECTION_HEAD").toBe(true);}
 if(name==="tree")expect([...svg.querySelectorAll("[data-diagram-edge]")].every(group=>group.querySelectorAll("path").length===1),"TREE_BRANCHES_HAVE_NO_DIRECTION_HEAD").toBe(true);
 if(name==="dependency"){
 expect(svg.querySelectorAll("[data-fan-in]").length,"EVERY_DEPENDENCY_NODE_HAS_COMPUTED_FAN_IN").toBe(authored.nodes.length);
 for(const path of svg.querySelectorAll<SVGPathElement>("[data-diagram-edge] path")){const bounds=path.getBBox(),stroke=parseFloat(getComputedStyle(path).strokeWidth)/2;expect(bounds.x-stroke,"CYCLE_STROKE_INSIDE_LEFT").toBeGreaterThan(0);expect(bounds.y-stroke,"CYCLE_STROKE_INSIDE_TOP").toBeGreaterThan(0);expect(bounds.x+bounds.width+stroke,"CYCLE_STROKE_INSIDE_RIGHT").toBeLessThan(svg.viewBox.baseVal.width);expect(bounds.y+bounds.height+stroke,"CYCLE_STROKE_INSIDE_BOTTOM").toBeLessThan(svg.viewBox.baseVal.height);}
 expect(svg.querySelector('[data-fan-in="2"]')).not.toBeNull();expect(svg.querySelector('[data-diagram-edge="0"] path')?.getAttribute("stroke-dasharray")).toBe("6 4");}
 if(name==="architecture-containment"){expect(svg.dataset.grammar).toBe("architecture-containment");expect(svg.querySelectorAll('rect[data-role="bounds"]').length).toBe(7);expect(svg.querySelector('[data-kind="endpoint"]')?.getAttribute("data-target")).toBe("ledger");expect(svg.querySelector('[data-peering]')).not.toBeNull();}
 const staticSvg=new DOMParser().parseFromString(await toStatic(source,{theme}),"image/svg+xml").querySelector("svg")!;
 const geometry=(drawing:ParentNode)=>[...drawing.querySelectorAll("[data-diagram-node],[data-diagram-edge],[data-cardinality],[data-diagram-group]")].map(item=>[...item.querySelectorAll("*")].map(child=>({tag:child.localName,attrs:[...child.attributes].filter(attr=>attr.name!=="xmlns").map(attr=>[attr.name,attr.value]).sort((a,b)=>a[0]!.localeCompare(b[0]!)),text:child.localName==="text"?child.textContent:null})));
 expect(geometry(svg),"NODE_LINK_CLIENT_STATIC_IDENTICAL_PRIMITIVES").toEqual(geometry(staticSvg));
 expect((await axe.run(host,{rules:{region:{enabled:false}}})).violations).toEqual([]);
 await expect(page.elementLocator(host)).toMatchScreenshot(`node-link-${name}-${theme}`);
 await commands.diagramCapture('[data-content-renderer="diagram"]',`node-link-${name}-${theme}`);
});

test("ER fields and cardinalities retain authored 320px placement",async()=>{
 const source=await commands.diagramFixture("er");root=createBrainUiRoot({storage:null,request:async()=>Response.json({renderers:[],enabled:[]})});host=document.createElement("div");host.style.width="320px";document.body.append(host);render=createRoot(host);flushSync(()=>render.render(<BrainUiProvider root={root}><DiagramContent source={source} theme="dark" mode="chat"/></BrainUiProvider>));await expect.poll(()=>host.querySelector('svg[data-diagram-layout="narrow"]')).not.toBeNull();const svg=host.querySelector<SVGSVGElement>('figure > svg')!;expect(svg.getBoundingClientRect().width).toBe(320);expect(svg.querySelectorAll("[data-cardinality]").length).toBe(2);expect(host.scrollWidth).toBe(320);for(const label of svg.querySelectorAll("text")){const matrix=label.getScreenCTM()!;expect(parseFloat(getComputedStyle(label).fontSize)*Math.min(Math.hypot(matrix.a,matrix.b),Math.hypot(matrix.c,matrix.d))).toBeGreaterThanOrEqual(9);}await commands.diagramCapture('[data-content-renderer="diagram"]',"node-link-er-320-dark");
});
