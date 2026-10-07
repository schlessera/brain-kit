import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";
import { commands, page } from "vitest/browser";
import "../../src/styles.css";
import { MapView, mapViewBounds, mercY, type MapViewProps } from "../../src/blocks/MapView.js";
import { gozoMap, voyageMap } from "../../fixtures/places.js";
let root: Root | undefined, host: HTMLDivElement | undefined, fonts: HTMLStyleElement;
beforeAll(async () => {
 await page.viewport(1440,1000); fonts=document.createElement("style"); fonts.textContent=await commands.rankFooterFonts();document.head.append(fonts);
 for(const face of ['500 10px "JetBrains Mono"','500 9px "JetBrains Mono"']) {await document.fonts.load(face);expect(document.fonts.check(face)).toBe(true);} await document.fonts.ready;
});
afterEach(()=>{if(root)flushSync(()=>root!.unmount());host?.remove();root=undefined;host=undefined;});afterAll(()=>fonts.remove());
async function mount(width:number, theme:string, props:MapViewProps) {
 host=document.createElement("div");host.style.width=`${width}px`;host.dataset.theme=theme;document.body.append(host);root=createRoot(host);
 flushSync(()=>root!.render(<MapView {...props} maxWidth={width} />));
 const viewport=host.firstElementChild!.firstElementChild as HTMLElement;
 await expect.poll(()=>viewport.querySelector("svg")!.viewBox.baseVal.width).toBe(width-2);
 // ResizeObserver supplies actual label dimensions after the same width settles.
 await new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve())));
 return viewport;
}
function labels(viewport:HTMLElement) {return [...viewport.querySelectorAll<HTMLElement>('span')].filter(el=>getComputedStyle(el).borderRadius==='7px');}
function intersects(a:DOMRect,b:DOMRect) {return Math.min(a.right,b.right)>Math.max(a.left,b.left)+0.5 && Math.min(a.bottom,b.bottom)>Math.max(a.top,b.top)+0.5;}
function fullTextFits(el:HTMLElement, box:DOMRect) {
 const walker=document.createTreeWalker(el,NodeFilter.SHOW_TEXT);let count=0;
 while(walker.nextNode()) {if(!walker.currentNode.textContent?.trim())continue; const r=document.createRange();r.selectNodeContents(walker.currentNode);for(const b of r.getClientRects()){if(!b.width)continue;count++;expect(b.left).toBeGreaterThanOrEqual(box.left-0.5);expect(b.right).toBeLessThanOrEqual(box.right+0.5);expect(b.top).toBeGreaterThanOrEqual(box.top-0.5);expect(b.bottom).toBeLessThanOrEqual(box.bottom+0.5);}}
 expect(count).toBeGreaterThan(0);
}
for(const theme of ['dark','light']) for(const width of [238,320,390,720]) {
 test(`cave names remain inside viewport ${theme} ${width}`,async()=>{
  const view=await mount(width,theme,gozoMap);const names=labels(view);expect(names.length).toBeGreaterThan(0);expect(view.textContent).toContain('Ramla Bay');
  for(const label of names)fullTextFits(label,view.getBoundingClientRect());
 });
 test(`voyage callouts avoid labels and coordinate annotations ${theme} ${width}`,async()=>{
  const view=await mount(width,theme,voyageMap);const names=labels(view);expect(names.length).toBeGreaterThan(1);
  const annotations=[...view.children].filter(el=> getComputedStyle(el).visibility !== 'hidden' && (el.tagName==='SPAN' || (el instanceof HTMLElement && el.style.top==='8px')));
  for(const [i,label]of names.entries()){
   fullTextFits(label,view.getBoundingClientRect());
   for(const other of names.slice(i+1))expect(intersects(label.getBoundingClientRect(),other.getBoundingClientRect()),`${label.textContent} / ${other.textContent}`).toBe(false);
   for(const other of annotations)expect(intersects(label.getBoundingClientRect(),other.getBoundingClientRect()),`${label.textContent} / ${other.textContent}`).toBe(false);
  }
 });
 test(`one long full name wraps within map ${theme} ${width}`,async()=>{
  const name='Ithaca'.repeat(18);const view=await mount(width,theme,{lat:38.3647,lon:20.7202,pinLabel:name});const named=labels(view);expect(named).toHaveLength(1);expect(named[0]!.textContent).toBe(name);fullTextFits(named[0]!,view.getBoundingClientRect());
 });
 test(`label movement leaves marker coordinates and cluster reports intact ${theme} ${width}`,async()=>{
  const pins=[{lat:38.25,lon:15.72,label:'Scylla',n:1},{lat:38.26,lon:15.65,label:'Charybdis',n:2}];const onClusters=vi.fn();const view=await mount(width,theme,{pins,spanKm:9,onClusters});
  const dots=[...view.querySelectorAll<HTMLElement>('span')].filter(el=>el.style.width==='10px');expect(dots).toHaveLength(2);
  const bounds=mapViewBounds(pins,{width:width-2,height:170,spanKm:9});const box=view.getBoundingClientRect();
  for(const [i,pin]of pins.entries()) {const b=dots[i]!.getBoundingClientRect();expect(b.left+b.width/2-box.left).toBeCloseTo((pin.lon-bounds.mw)/(bounds.me-bounds.mw)*box.width,1);expect(b.top+b.height/2-box.top).toBeCloseTo((bounds.yTop-mercY(pin.lat))/(bounds.yTop-bounds.yBot)*170,1);}
  await expect.poll(()=>onClusters.mock.calls.at(-1)?.[0]).toEqual([]);
  flushSync(()=>root!.render(<MapView pins={pins} spanKm={400} maxWidth={width} pinMode="number" onClusters={onClusters} letterFrom={2} />));
  await expect.poll(()=>onClusters.mock.calls.at(-1)?.[0]).toEqual([{letter:'C',members:[1,2]}]);expect(view.querySelectorAll('[data-pin="cluster"]')).toHaveLength(1);expect(view.textContent).toContain('C·2');
 });
}

for (const theme of ["dark", "light"]) {
 test(`unlabelled marker does not misaddress following callout ${theme}`,async()=>{
  const view=await mount(390,theme,{pins:[{lat:38.25,lon:15.72},{lat:38.26,lon:15.65,label:"Charybdis"}],spanKm:9});
  const named=labels(view);expect(named).toHaveLength(1);expect(named[0]!.textContent).toBe("Charybdis");fullTextFits(named[0]!,view.getBoundingClientRect());
  const tether=view.querySelector<SVGLineElement>('[data-map-tether]')!;expect(tether).not.toBeNull();
  const dot=[...view.querySelectorAll<HTMLElement>('[data-map-dot]')][1]!;const b=dot.getBoundingClientRect();const box=view.getBoundingClientRect();
  expect(Number(tether.getAttribute('x1'))).toBeCloseTo(b.left+b.width/2-box.left,1);
 });
 test(`resize and changed content recompute full callouts ${theme}`,async()=>{
  const view=await mount(390,theme,gozoMap);
  host!.style.width="240px";
  await expect.poll(()=>view.querySelector('svg')!.viewBox.baseVal.width).toBe(238);
  await expect.poll(()=>labels(view).every(label=>label.getBoundingClientRect().right<=view.getBoundingClientRect().right)).toBe(true);
  flushSync(()=>root!.render(<MapView pinLabel="The harbour of Ithaca" lat={38.3647} lon={20.7202} maxWidth={390} />));
  await expect.poll(()=>labels(view)[0]?.textContent).toBe("The harbour of Ithaca");fullTextFits(labels(view)[0]!,view.getBoundingClientRect());
 });
}

for (const theme of ["dark", "light"]) test(`adding the coordinate chip replans labels ${theme}`,async()=>{
 const view=await mount(320,theme,{...voyageMap,coordChip:false});
 flushSync(()=>root!.render(<MapView {...voyageMap} maxWidth={320} coordChip />));
 const chip=view.querySelector<HTMLElement>('[data-map-annotation][style*="top: 8px"]')!;expect(chip).not.toBeNull();
 await expect.poll(()=>labels(view).some(label=>intersects(label.getBoundingClientRect(),chip.getBoundingClientRect()))).toBe(false);
});
