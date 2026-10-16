/// <reference types="vite/client" />
import { afterAll,afterEach,beforeAll,expect,test } from "vitest";
import { commands,page,userEvent } from "vitest/browser";
import { flushSync } from "react-dom";
import { createRoot,type Root } from "react-dom/client";
import { DiagramContent } from "../../../module-diagrams/src/ui.js";
import { toStatic } from "../../../module-diagrams/src/render.js";
import { BrainUiProvider,createBrainUiRoot,type BrainUiRoot } from "@schlessera/brain-ui-react";
import quadrant from "../../../module-diagrams/skills/diagram/references/examples/positional/quadrant.diagram.yaml?raw";
import layers from "../../../module-diagrams/skills/diagram/references/examples/positional/layer-stack.diagram.yaml?raw";
import pyramid from "../../../module-diagrams/skills/diagram/references/examples/positional/pyramid.diagram.yaml?raw";
import funnel from "../../../module-diagrams/skills/diagram/references/examples/positional/funnel.diagram.yaml?raw";
import loop from "../../../module-diagrams/skills/diagram/references/examples/positional/loop.diagram.yaml?raw";
import flywheel from "../../../module-diagrams/skills/diagram/references/examples/positional/flywheel.diagram.yaml?raw";
import venn from "../../../module-diagrams/skills/diagram/references/examples/positional/venn.diagram.yaml?raw";
const examples={quadrant,"layer-stack":layers,pyramid,funnel,loop,flywheel,venn};
let host:HTMLDivElement,renderer:Root,root:BrainUiRoot,styles:HTMLStyleElement;
beforeAll(async()=>{styles=document.createElement("style");styles.dataset.diagramCaptureConsumer="";styles.textContent=await commands.formConsumerStyles();document.head.append(styles);});
afterAll(()=>styles?.remove());
afterEach(()=>{if(renderer)flushSync(()=>renderer.unmount());host?.remove();root?.dispose();host=undefined!;renderer=undefined!;root=undefined!;});
function mount(source:string,theme:"light"|"dark"|"print",width=1000){if(!host){host=document.createElement("div");document.body.append(host);renderer=createRoot(host);root=createBrainUiRoot({storage:null,request:async()=>Response.json({renderers:[],enabled:[]})});root.stores.file.setState({wikilinkMap:{"raft-build":"notes/raft-build.md"},wikilinkLoaded:true});}host.style.width=`${width}px`;document.documentElement.dataset.theme=theme;flushSync(()=>renderer.render(<BrainUiProvider root={root}><DiagramContent source={source} theme={theme} mode="chat"/></BrainUiProvider>));}
async function drawing(){await expect.poll(()=>host.querySelector('figure > svg')).not.toBeNull();await document.fonts.ready;return host.querySelector<SVGSVGElement>('figure > svg')!;}
for(const [type,source]of Object.entries(examples))test(`${type}: approved skin and actual font bounds in light dark print`,async()=>{
 for(const theme of["light","dark","print"]as const){mount(source,theme);const svg=await drawing();
  for(const text of svg.querySelectorAll("text")){const m=text.getScreenCTM()!,box=text.getBBox();expect(parseFloat(getComputedStyle(text).fontSize)*Math.hypot(m.a,m.b),"DISPLAYED_TYPE_FLOOR").toBeGreaterThanOrEqual(9);expect(box.x).toBeGreaterThanOrEqual(-.01);expect(box.y).toBeGreaterThanOrEqual(-.01);expect(box.x+box.width).toBeLessThanOrEqual(svg.viewBox.baseVal.width+.01);expect(box.y+box.height).toBeLessThanOrEqual(svg.viewBox.baseVal.height+.01);}
  if(type==="pyramid"||type==="funnel")for(const polygon of svg.querySelectorAll<SVGPolygonElement>("polygon[data-diagram-shape]")){const points=[...polygon.points],top=points[1]!.x-points[0]!.x,bottom=points[2]!.x-points[3]!.x,height=points[2]!.y-points[0]!.y,cx=(points[0]!.x+points[1]!.x)/2;for(const text of polygon.parentElement!.querySelectorAll("text")){const box=text.getBBox();for(const y of[box.y,box.y+box.height]){const w=top+(bottom-top)*(y-points[0]!.y)/height;expect(box.x,"ACTUAL_POLYGON_TEXT_LEFT").toBeGreaterThanOrEqual(cx-w/2+3);expect(box.x+box.width,"ACTUAL_POLYGON_TEXT_RIGHT").toBeLessThanOrEqual(cx+w/2-3);}}}
  if(theme==="print")expect(getComputedStyle(svg).backgroundColor,"WHITE_PRINT_GROUND").toBe("rgb(255, 255, 255)");
  const parsed=new DOMParser().parseFromString(await toStatic(source,{theme}),"image/svg+xml");
  const geometry=(node:ParentNode)=>[...node.querySelectorAll('[data-diagram-shape]')].map(item=>[item.localName,...["x","y","width","height","cx","cy","r","d","points"].map(name=>item.getAttribute(name))]);
  expect(geometry(svg),"CLIENT_STATIC_SHAPE_PARITY").toEqual(geometry(parsed));
  await commands.diagramCapture('[data-content-renderer="diagram"]',`positional-${type}-${theme}`);
  await expect(page.elementLocator(host.querySelector("figure")!)).toMatchScreenshot(`positional-${type}-${theme}`);
 }
},60000);
test("linked positional node stays operable inline and in a readable 320px fallback viewer",async()=>{
 const spec=JSON.parse(quadrant);spec.nodes[0].link="[[raft-build]]";const source=JSON.stringify(spec);mount(source,"light");root.stores.file.setState({wikilinkMap:{"raft-build":"notes/raft-build.md"},wikilinkLoaded:true});const paths:string[]=[];root.stores.file.setState({openFile:async(path)=>{paths.push(path);}});let svg=await drawing();
 let node=svg.querySelector<SVGGElement>('[data-diagram-node="sail"]')!;node.focus();await expect.poll(()=>document.activeElement).toBe(node);expect(getComputedStyle(node.querySelector('.bk-diagram-node-focus')!).visibility).toBe("visible");await userEvent.keyboard("{Enter}");expect(paths).toEqual(["notes/raft-build.md"]);const nameBox=svg.querySelector('[data-diagram-shape="sail-label"]')!.getBoundingClientRect(),point={x:nameBox.x+nameBox.width/2,y:nameBox.y+nameBox.height/2};expect(node.contains(document.elementFromPoint(point.x,point.y)),"POSITIONAL_NAME_HIT_TARGET").toBe(true);await commands.overlayMouse(point);expect(paths,"POSITIONAL_NAME_CLICK_NAVIGATES").toEqual(["notes/raft-build.md","notes/raft-build.md"]);
 host.style.width="320px";await expect.poll(()=>host.querySelector('[data-diagram-summary]')).not.toBeNull();expect(host.querySelector('figure > svg')).toBeNull();await userEvent.click([...host.querySelectorAll('button,[role="button"]')].find(button=>button.textContent==="Open diagram")!);
 await expect.poll(()=>document.querySelector('[aria-label="Diagram viewer"] svg.bk-diagram')).not.toBeNull();svg=document.querySelector<SVGSVGElement>('[aria-label="Diagram viewer"] svg.bk-diagram')!;expect(svg.querySelectorAll("text").length).toBeGreaterThan(0);for(const text of svg.querySelectorAll("text")){const matrix=text.getScreenCTM()!;expect(parseFloat(getComputedStyle(text).fontSize)*Math.hypot(matrix.a,matrix.b)).toBeGreaterThanOrEqual(9);}node=svg.querySelector<SVGGElement>('[data-diagram-node="sail"]')!;node.focus();await expect.poll(()=>document.activeElement).toBe(node);await userEvent.keyboard("{Enter}");expect(paths).toEqual(["notes/raft-build.md","notes/raft-build.md","notes/raft-build.md"]);await userEvent.keyboard("{Escape}");
});
