import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";
import { commands, page } from "vitest/browser";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { BrainUiProvider } from "../../src/root-context.js";
import { createBrainUiRoot, type BrainUiRoot } from "../../src/root.js";
import { RunDetail } from "../../src/components/activity/activity-run-detail.js";
import { timedSpans, laneStart } from "../lane-fixtures.js";
class FixtureSocket {readyState=0;onopen=null;onmessage=null;onclose=null;onerror=null;send(){}close(){this.readyState=3;}}
let root:BrainUiRoot|undefined,renderer:Root|undefined,host:HTMLDivElement|undefined;
let styles:HTMLStyleElement,viewport:{width:number;height:number},outer:{width:number;height:number};
beforeAll(async()=>{viewport={width:innerWidth,height:innerHeight};styles=document.createElement('style');styles.textContent=await commands.formConsumerStyles();document.head.append(styles);});
afterAll(()=>styles.remove());
afterEach(async()=>{if(renderer)flushSync(()=>renderer!.unmount());root?.dispose();host?.remove();root=undefined;renderer=undefined;host=undefined;vi.restoreAllMocks();vi.unstubAllGlobals();document.documentElement.dataset.theme='dark';await page.viewport(viewport.width,viewport.height);if(outer)await commands.formViewport(outer.width-100,outer.height-120);});
for(const width of [320,1280])for(const theme of ['dark','light'])test(`${theme} ${width}: actual recorded run uses a shared axis and readable timing`,async()=>{
  vi.stubGlobal('WebSocket',FixtureSocket);let now=laneStart+90000;vi.spyOn(Date,'now').mockImplementation(()=>now);
  outer=await commands.formViewport(width,1100);await page.viewport(width,1100);document.documentElement.dataset.theme=theme;
  const spans=timedSpans();spans[1]!.subagent={type:'researcher-'+ 'crossing-directions-'.repeat(5)};
  root=createBrainUiRoot({storage:null,request:async()=>Response.json({runId:'crossing-lanes',detailPruned:false,spans,events:[],highWaterSeq:0})});root.stores.activity.setState({supported:true});root.stores.ui.getState().setTheme(theme as 'dark'|'light');
  host=document.createElement('div');host.style.cssText=`width:${width}px;height:1100px;display:flex;flex-direction:column;background:var(--bk-color-canvas)`;document.body.append(host);renderer=createRoot(host);
  flushSync(()=>renderer!.render(<BrainUiProvider root={root!}><RunDetail runId='crossing-lanes' onBack={()=>{}}/></BrainUiProvider>));
  await document.fonts.ready;await expect.poll(()=>host!.querySelectorAll('[data-kit-lane-chart]').length).toBe(1);
  const chart=host!.querySelector<HTMLElement>('[data-kit-lane-chart]')!;
  const ledger=chart.querySelector<HTMLElement>('[data-lane-name="ledger"]')!,segment=ledger.querySelector<HTMLElement>('[data-lane-segment]')!;
  const track=segment.parentElement!.getBoundingClientRect(),rect=segment.getBoundingClientRect();
  expect(track.width).toBeGreaterThan(100);expect(Math.abs(rect.left-track.left-track.width*.25)).toBeLessThanOrEqual(.5);expect(Math.abs(rect.width-track.width*.5)).toBeLessThanOrEqual(.5);
  expect([...chart.firstElementChild!.children].map(e=>e.textContent)).toEqual(['0.0s','20.0s','40.0s','1m 0s']);
  expect(chart.querySelectorAll('[data-lane-hatch="true"]')).toHaveLength(1);expect(chart.querySelectorAll('[data-lane-fade="true"]')).toHaveLength(0);
  const section=host!.querySelector<HTMLElement>('[data-run-lanes]')!;
  expect(section.textContent).toContain(spans[1]!.subagent!.type!);expect(section.textContent).toContain('timeout');expect(section.textContent).toContain('cancelled');expect(section.textContent).toContain('denied');
  for(const row of chart.querySelectorAll<HTMLElement>('[data-lane-name]'))expect(row.scrollWidth).toBeLessThanOrEqual(row.clientWidth+1);
  expect(section.scrollWidth).toBeLessThanOrEqual(section.clientWidth+1);expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
  expect(section.querySelectorAll('button,[tabindex],[aria-live]')).toHaveLength(0);
  await page.screenshot({element:host!,path:`../../.vitest-attachments/run-lanes/${theme}-${width}.png`});
  // Genuine live frames replace dispositions; a known approval boundary
  // remains the only hatch while an active interval gets the sole open tail.
  flushSync(()=>{
    root!.connection.handleServerMessage({type:'activity_delta',runId:'crossing-lanes',seq:1,span:{...spans[0]!,endedAt:undefined,outcome:undefined}});
    root!.connection.handleServerMessage({type:'activity_delta',runId:'crossing-lanes',seq:2,span:{...spans[2]!,endedAt:undefined,outcome:undefined}});
  });
  await expect.poll(()=>chart.querySelectorAll('[data-lane-fade="true"]').length).toBe(1);
  now=laneStart+120000;await expect.poll(()=>chart.firstElementChild!.lastElementChild!.textContent,{timeout:2200}).toBe('2m 0s');
  flushSync(()=>root!.connection.handleServerMessage({type:'activity_delta',runId:'crossing-lanes',seq:3,span:{...spans[2]!,endedAt:laneStart+100000,outcome:'denied'}}));
  await expect.poll(()=>chart.querySelectorAll('[data-lane-fade="true"]').length).toBe(0);expect(section.querySelector('[data-lane-record="ledger"]')!.textContent).toContain('denied');
});
