import {afterAll,afterEach,beforeAll,expect,test} from "vitest";
import {commands} from "vitest/browser";
import {flushSync} from "react-dom";
import {createRoot,type Root} from "react-dom/client";
import {BrainUiProvider,createBrainUiRoot,type BrainUiRoot} from "@schlessera/brain-ui-react";
import {DiagramContent} from "../../../module-diagrams/src/ui.js";
import {toStatic} from "../../../module-diagrams/src/render.js";
import {calloutsSpec,narrowCallouts} from "../../../module-diagrams/tests/fixtures/callouts.js";
let host:HTMLDivElement,render:Root,root:BrainUiRoot,styles:HTMLStyleElement;
const originalTheme=document.documentElement.dataset.theme;
beforeAll(async()=>{styles=document.createElement("style");styles.dataset.diagramCaptureConsumer="";styles.textContent=await commands.formConsumerStyles();document.head.append(styles);});
afterAll(()=>styles.remove());
afterEach(()=>{if(render)flushSync(()=>render.unmount());root?.dispose();host?.remove();document.documentElement.dataset.theme=originalTheme;});
function mount(source:string,width:number,theme:"light"|"dark"|"print"){
 if(!host?.isConnected){host=document.createElement("div");document.body.append(host);render=createRoot(host);root=createBrainUiRoot({storage:null,request:async()=>Response.json({renderers:[],enabled:[]})});}
 document.documentElement.dataset.theme=theme;host.style.width=`${width}px`;flushSync(()=>render.render(<BrainUiProvider root={root}><DiagramContent source={source} theme={theme} mode="chat"/></BrainUiProvider>));
}
async function svgReady(){await expect.poll(()=>host.querySelector('figure > svg.bk-diagram')).not.toBeNull();await document.fonts.ready;return host.querySelector<SVGSVGElement>('figure > svg.bk-diagram')!;}
const canonical=(item:Element):unknown=>({tag:item.localName,attrs:Object.fromEntries([...item.attributes].filter(attr=>attr.name!=="xmlns").map(attr=>[attr.name,attr.value])),text:item.childElementCount?undefined:item.textContent,children:[...item.children].map(canonical)});
const annotation=(svg:ParentNode)=>[...svg.querySelectorAll('[data-diagram-callout],[data-diagram-callout-note]')].map(canonical);
function assertNotes(svg:SVGSVGElement,count:number){
 const notes=svg.querySelectorAll<SVGGElement>('[data-diagram-callout]');expect(notes.length,"NONEMPTY_ANNOTATION_PROOF").toBe(count);
 for(const text of svg.querySelectorAll<SVGTextElement>('text')){const m=text.getScreenCTM()!,scale=Math.min(Math.hypot(m.a,m.b),Math.hypot(m.c,m.d));expect(parseFloat(getComputedStyle(text).fontSize)*scale,"DISPLAYED_FONT_FLOOR").toBeGreaterThanOrEqual(9);}
 for(const note of notes){const marker=note.dataset.placement==="marker";for(const text of note.querySelectorAll<SVGTextElement>('text'))if(!marker){expect(getComputedStyle(text).fontSize).toBe("11px");expect(getComputedStyle(text).fontWeight).toBe("500");expect(getComputedStyle(text).fontFamily).toContain("Plus Jakarta Sans");}
  if(marker)continue;const dot=note.querySelector<SVGCircleElement>('circle')!,leader=note.querySelector<SVGLineElement>('line')!,target=svg.querySelector<SVGGElement>(`[data-diagram-node="${note.dataset.target}"]`);
  if(target){const b=target.querySelector<SVGGraphicsElement>('rect,path,circle,polygon')!.getBBox(),x=dot.cx.baseVal.value,y=dot.cy.baseVal.value;expect(Math.min(Math.abs(x-b.x),Math.abs(x-b.x-b.width),Math.abs(y-b.y),Math.abs(y-b.y-b.height)),"DOT_ON_TARGET_BORDER").toBeLessThanOrEqual(.5);}
  const texts=[...note.querySelectorAll<SVGTextElement>('text')];expect(texts.length).toBeGreaterThan(0);
  for(const label of texts){const box=label.getBBox();expect(box.x).toBeGreaterThanOrEqual(8);expect(box.x+box.width).toBeLessThanOrEqual(svg.viewBox.baseVal.width-8);for(const other of svg.querySelectorAll<SVGGraphicsElement>('[data-diagram-node] > rect:not(.bk-diagram-node-focus),[data-edge-mask],[data-group-heading-mask]')){const obstacle=other.getBBox();expect(box.x+box.width+4<=obstacle.x||box.x-4>=obstacle.x+obstacle.width||box.y+box.height+4<=obstacle.y||box.y-4>=obstacle.y+obstacle.height,"ACTUAL_NOTE_CLEARS_BOX_AND_MASK").toBe(true);}}
  const textBoxes=texts.map(item=>item.getBBox()),distance=(x:number,y:number,box:DOMRect)=>Math.hypot(Math.max(box.x-x,0,x-box.x-box.width),Math.max(box.y-y,0,y-box.y-box.height));
  for(const path of svg.querySelectorAll<SVGGeometryElement>('[data-diagram-edge] path,[data-diagram-edge] line')){
   const length=path.getTotalLength(),stroke=parseFloat(getComputedStyle(path).strokeWidth)/2;
   for(let at=0;at<=length;at+=.5){const p=path.getPointAtLength(at);for(const box of textBoxes)expect(distance(p.x,p.y,box),"ACTUAL_NOTE_CLEARS_CONNECTOR_AND_ARROWHEAD").toBeGreaterThanOrEqual(4+stroke);}
  }
  const legend=svg.querySelector<SVGGElement>('[data-diagram-legend]');if(legend){const box=legend.getBBox();for(const noteBox of textBoxes)expect(noteBox.y+noteBox.height+4).toBeLessThanOrEqual(box.y);}
  const leaderLength=leader.getTotalLength();for(let at=3;at<=leaderLength;at+=.5){const p=leader.getPointAtLength(at);for(const obstacle of svg.querySelectorAll<SVGGraphicsElement>('[data-diagram-node] > rect:not(.bk-diagram-node-focus),[data-edge-mask],[data-group-heading-mask]'))expect(distance(p.x,p.y,obstacle.getBBox()),"LEADER_CLEARS_NODE_AND_MASK").toBeGreaterThanOrEqual(.5);}
  expect(Math.hypot(leader.x2.baseVal.value-leader.x1.baseVal.value,leader.y2.baseVal.value-leader.y1.baseVal.value)).toBeLessThanOrEqual(24);
 }
}
for(const theme of ["light","dark","print"] as const)test(`literal accepted callout client/static ${theme}`,async()=>{
 const source=JSON.stringify(calloutsSpec);mount(source,800,theme);const svg=await svgReady();assertNotes(svg,1);expect(svg.querySelector('[data-diagram-callout="0"]')!.textContent).toBe("PREPARE PROVISIONS");expect(svg.querySelector('[data-diagram-node="odysseus"]')!.getAttribute('aria-label')).toContain('note: PREPARE PROVISIONS');
 const xml=new DOMParser().parseFromString(await toStatic(source,{theme}),"image/svg+xml");expect(annotation(svg),"SHARED_CLIENT_STATIC_ANNOTATION_GEOMETRY").toEqual(annotation(xml));
 await commands.diagramCapture('[data-content-renderer="diagram"]',`callouts-literal-${theme}`);
});
for(const theme of ["light","dark","print"] as const)test(`two notes and authored narrow ${theme}`,async()=>{
 const spec=narrowCallouts(),source=JSON.stringify(spec);mount(source,800,theme);let svg=await svgReady();assertNotes(svg,2);expect([...svg.querySelectorAll('[data-diagram-callout]')].every(item=>item.getAttribute('data-placement')!=="marker")).toBe(true);await commands.diagramCapture('[data-content-renderer="diagram"]',`callouts-two-${theme}`);
 host.style.width="320px";await expect.poll(()=>host.querySelector('figure > svg')?.getAttribute('width')).toBe("320");svg=await svgReady();assertNotes(svg,2);expect(svg.querySelector('[data-diagram-notes-band]')).not.toBeNull();expect(svg.querySelector('[data-diagram-callout-note="0"]')!.textContent).toContain("PREPARE PROVISIONS");expect(host.scrollWidth).toBeLessThanOrEqual(320);await commands.diagramCapture('[data-content-renderer="diagram"]',`callouts-narrow-${theme}`);
});
for(const theme of ["light","dark"] as const)test(`summary preserves every target and note ${theme}`,async()=>{
 const spec=narrowCallouts();delete spec.layouts;mount(JSON.stringify(spec),300,theme);await expect.poll(()=>host.querySelector('[data-diagram-notes]')).not.toBeNull();const notes=[...host.querySelectorAll('[data-diagram-notes] li')];expect(notes.length).toBe(2);expect(notes.map(item=>item.querySelector('span:last-child')!.textContent)).toEqual(spec.callouts.map(note=>note.text));expect(notes.map(item=>item.querySelector('span')!.textContent)).toEqual(["Odysseus","RECORD"]);expect([...host.querySelectorAll('button,[role="button"]')].some(item=>item.textContent==="Open diagram")).toBe(true);await commands.diagramCapture('[data-content-renderer="diagram"]',`callouts-fallback-${theme}`);
});
