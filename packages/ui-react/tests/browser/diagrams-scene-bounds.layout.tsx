import { afterAll, afterEach, beforeAll, expect, test } from "vitest";
import { commands } from "vitest/browser";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { BrainUiProvider, createBrainUiRoot, type BrainUiRoot } from "@schlessera/brain-ui-react";
import { DiagramContent } from "../../../module-diagrams/src/ui.js";
import { toStatic } from "../../../module-diagrams/src/render.js";
import { toFlatSvg } from "../../../module-diagrams/src/flatten.js";
import { originGroup } from "../../../module-diagrams/tests/fixtures/origin-group.js";
let host:HTMLDivElement,render:Root,root:BrainUiRoot,styles:HTMLStyleElement;
beforeAll(async()=>{styles=document.createElement("style");styles.dataset.diagramCaptureConsumer="";styles.textContent=await commands.formConsumerStyles();document.head.append(styles);});
afterAll(()=>styles.remove());
afterEach(()=>{if(render)flushSync(()=>render.unmount());root?.dispose();host?.remove();});
function bounds(svg:SVGSVGElement) {
 const frame=svg.viewBox.baseVal;
 expect(frame.x,"NONZERO_SCENE_ORIGIN").toBeLessThan(0);expect(frame.y).toBeLessThan(0);
 const targets=svg.querySelectorAll<SVGGraphicsElement>('[data-diagram-group], [data-diagram-node] > :not(.bk-diagram-node-focus), [data-diagram-legend], [data-diagram-notes-band]');
 expect(targets.length,"NONVACUOUS_SCENE_BOUNDS").toBeGreaterThanOrEqual(4);
 for(const item of targets){const box=item.getBBox();expect(box.x,"BROWSER_SCENE_LEFT").toBeGreaterThanOrEqual(frame.x);expect(box.y,"BROWSER_HEADING_TOP").toBeGreaterThanOrEqual(frame.y);expect(box.x+box.width,"BROWSER_SCENE_RIGHT").toBeLessThanOrEqual(frame.x+frame.width);expect(box.y+box.height,"BROWSER_SCENE_BOTTOM").toBeLessThanOrEqual(frame.y+frame.height);}
 for(const text of svg.querySelectorAll("text")){const matrix=text.getScreenCTM()!;expect(parseFloat(getComputedStyle(text).fontSize)*Math.min(Math.hypot(matrix.a,matrix.b),Math.hypot(matrix.c,matrix.d)),"SCENE_NATIVE_TEXT_FLOOR").toBeGreaterThanOrEqual(9);}
 const group=svg.querySelector('[data-diagram-group="crew"] > rect')!;expect(group.getAttribute("x")).toBe("-16");expect(group.getAttribute("y")).toBe("-16");
 const node=svg.querySelector('[data-diagram-node="raft"] rect')!;expect(node.getAttribute("x")).toBe("0");expect(node.getAttribute("y")).toBe("0");
}
for(const annotated of [false,true])test(`origin group client/static/flat bounds with loaded fonts, annotations=${annotated}`,async()=>{
 root=createBrainUiRoot({storage:null,request:async()=>Response.json({renderers:[],enabled:[]})});host=document.createElement("div");host.style.width="1000px";document.body.append(host);render=createRoot(host);
 const source=JSON.stringify({...originGroup,...(annotated?{focal:["raft"],callouts:[{target:"crew",text:"Prepare the raft."},{target:"crew",text:"Keep the crew together."}]}:{})});
 flushSync(()=>render.render(<BrainUiProvider root={root}><DiagramContent source={source} theme="light" mode="chat"/></BrainUiProvider>));
 await expect.poll(()=>host.querySelector('figure > svg.bk-diagram')).not.toBeNull();await document.fonts.ready;
 expect(document.fonts.check('600 9.5px "JetBrains Mono"'),"LOADED_GROUP_LABEL_FONT").toBe(true);
 const client=host.querySelector<SVGSVGElement>('figure > svg.bk-diagram')!;bounds(client);
 await commands.diagramCapture('[data-content-renderer="diagram"]',`scene-origin-${annotated?"notes":"plain"}`);
 for(const markup of [await toStatic(source,{theme:"light"}),toFlatSvg(source,"light")]){const staticHost=document.createElement("div");host.append(staticHost);staticHost.innerHTML=markup;const svg=staticHost.querySelector("svg")!;expect(svg.getAttribute("viewBox"),"CLIENT_STATIC_VIEWBOX").toBe(client.getAttribute("viewBox"));bounds(svg);staticHost.remove();}
});
