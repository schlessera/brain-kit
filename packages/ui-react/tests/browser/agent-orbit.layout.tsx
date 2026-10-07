import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";
import { commands, page, userEvent } from "vitest/browser";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { BrainUiProvider, useRootStore } from "../../src/root-context.js";
import { createBrainUiRoot, type BrainUiRoot } from "../../src/root.js";
import { RunDetail } from "../../src/components/activity/activity-run-detail.js";
import { ChatPage } from "../../src/components/chat/chat-page.js";
import { parallelSpans, orbitStart } from "../orbit-fixtures.js";
import type { ActivitySpan } from "@schlessera/brain-ui-sdk/protocol";
class FixtureSocket { readyState=0; onopen=null;onmessage=null;onclose=null;onerror=null;send(){}close(){this.readyState=3;} }
let root: BrainUiRoot | undefined, renderer: Root | undefined, host: HTMLDivElement | undefined;
let styles: HTMLStyleElement, viewport:{width:number;height:number},outer:{width:number;height:number};
function Surface() {
  const view=useRootStore("ui",s=>s.activeView);
  return view==="chat"?<ChatPage/>:<RunDetail runId="crossing-run" onBack={()=>{}}/>;
}
const settle=()=>new Promise<void>(resolve=>requestAnimationFrame(()=>resolve()));
beforeAll(async()=>{viewport={width:innerWidth,height:innerHeight};styles=document.createElement('style');styles.textContent=await commands.formConsumerStyles();document.head.append(styles);});
afterAll(()=>styles.remove());
afterEach(async()=>{
  if(renderer)flushSync(()=>renderer!.unmount());root?.dispose();host?.remove();root=undefined;renderer=undefined;host=undefined;
  vi.restoreAllMocks();vi.unstubAllGlobals();document.documentElement.dataset.theme="dark";
  await page.viewport(viewport.width,viewport.height);if(outer)await commands.formViewport(outer.width-100,outer.height-120);
});
async function mount(width:number,theme:string,dense=false) {
  vi.stubGlobal("WebSocket",FixtureSocket);vi.spyOn(Date,"now").mockReturnValue(orbitStart+65000);
  outer=await commands.formViewport(width,1100);await page.viewport(width,1100);document.documentElement.dataset.theme=theme;
  const original=parallelSpans();
  const spans:ActivitySpan[]=dense?[original[0]!,...Array.from({length:12},(_,i)=>({...original[2]!,spanId:`coast-${i}`,startedAt:orbitStart+i,subagent:{type:`chart-coast-${i}-`+"crossing-directions-".repeat(5)}}))]:original;
  root=createBrainUiRoot({storage:null,request:async url=>{
    if(String(url).includes('/activity/runs/'))return Response.json({runId:"crossing-run",detailPruned:false,spans,events:[],highWaterSeq:0});
    if(String(url).endsWith('/sessions'))return Response.json({sessions:[]});return new Response('{}',{status:404});
  }});
  root.stores.activity.setState({supported:true});root.stores.ui.getState().setTheme(theme as "dark"|"light");root.stores.ui.getState().setActiveView("activity");
  const chat=root.stores.chat.getState();chat.setActiveSession("crossing-chat");chat.startAssistantMessage("crossing-chat");
  chat.requestToolApproval("crossing-chat","approval-write","Write",{file_path:"voyage/crossing.md"});chat.setActiveSession("other-chat");
  host=document.createElement('div');host.style.cssText=`width:${width}px;height:1100px;display:flex;flex-direction:column;background:var(--bk-color-canvas)`;document.body.append(host);
  renderer=createRoot(host);flushSync(()=>renderer!.render(<BrainUiProvider root={root!}><Surface/></BrainUiProvider>));
  await document.fonts.ready;await expect.poll(()=>host!.querySelectorAll('[data-kit-agent-orbit]').length).toBe(1);await settle();await settle();
  return spans;
}
function noIntersections(elements: HTMLElement[]) {
  expect(elements.length).toBeGreaterThan(0);
  for(const [i,a] of elements.entries())for(const b of elements.slice(i+1)) {
    const x=a.getBoundingClientRect(),y=b.getBoundingClientRect();
    expect(x.right<=y.left+.5||y.right<=x.left+.5||x.bottom<=y.top+.5||y.bottom<=x.top+.5).toBe(true);
  }
}
for(const width of [320,390,1280])for(const theme of ["dark","light"]) {
  test(`${theme} ${width}: recorded states, full list targets and actual drill-in`,async()=>{
    await mount(width,theme);const orbit=host!.querySelector<HTMLElement>('[data-kit-agent-orbit]')!;
    expect(orbit.getAttribute('aria-label')).toBe("Agents: 1 needs you, 2 running, 3 ended");
    expect(orbit.textContent).not.toContain('%');expect(orbit.textContent).not.toContain('4,812');expect(orbit.querySelector('[aria-live]')).toBeNull();
    const compact=width<480;expect(orbit.dataset.orbitCompact).toBe(String(compact));
    const marks=[...orbit.querySelectorAll<HTMLElement>('[data-orbit-agent],[data-orbit-overflow]')];noIntersections(marks);
    const frame=orbit.querySelector<HTMLElement>('[data-orbit-frame]')!.getBoundingClientRect();
    for(const mark of marks){const r=mark.getBoundingClientRect();expect(r.left).toBeGreaterThanOrEqual(frame.left-.5);expect(r.right).toBeLessThanOrEqual(frame.right+.5);}
    if(compact){expect(orbit.querySelectorAll('button,[tabindex]')).toHaveLength(0);for(const mark of marks)expect(mark.getBoundingClientRect().width).toBe(12);}
    else {const buttons=[...orbit.querySelectorAll<HTMLElement>('button')];expect(buttons.length).toBeGreaterThan(0);for(const b of buttons){expect(b.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);expect(b.getBoundingClientRect().width).toBeGreaterThanOrEqual(44);}}
    const rows=[...host!.querySelectorAll<HTMLElement>('[data-agent-list-row]')];expect(rows).toHaveLength(6);noIntersections(rows);
    for(const row of rows){expect(row.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);expect(row.scrollWidth).toBeLessThanOrEqual(row.clientWidth+1);}
    expect(matchMedia('(prefers-reduced-motion: reduce)').matches).toBe(true);
    for(const element of orbit.querySelectorAll<HTMLElement>('*')) {
      for(const animation of element.getAnimations()) {
        const keyframes=(animation.effect as KeyframeEffect).getKeyframes();
        expect(keyframes.length).toBeGreaterThan(0);
        expect(new Set(keyframes.map(frame=>frame.opacity)).size).toBe(1);
        expect(new Set(keyframes.map(frame=>frame.boxShadow)).size).toBe(1);
      }
    }
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
    await page.screenshot({element:host!,path:`../../.vitest-attachments/agent-orbit/${theme}-${width}.png`});
    const researcher=compact ? host!.querySelector<HTMLElement>('[data-agent-list-row="research"]')! : orbit.querySelector<HTMLElement>('[data-orbit-agent="research"]')!;
    researcher.focus();await userEvent.keyboard('{Enter}');
    await expect.poll(()=>host!.textContent?.includes('Compare Circe’s directions.')).toBe(true);
    expect(root!.stores.ui.getState().subagentStack).toEqual(['research']);expect(root!.stores.chat.getState().activeSessionId).toBe('crossing-chat');
    expect(host!.textContent).toContain('Write');expect(host!.textContent).toContain("Activity only — this subagent's transcript was not captured.");
  });
}
for(const theme of ["dark","light"])test(`${theme} desktop: twelve long agents keep collision-free targets and truthful overflow`,async()=>{
  const spans=await mount(1280,theme,true);const orbit=host!.querySelector<HTMLElement>('[data-kit-agent-orbit]')!;
  expect(orbit.getAttribute('aria-label')).toBe('Agents: 0 needs you, 12 running, 0 ended');
  await expect.poll(()=>orbit.querySelector('[data-orbit-overflow]')).toBeTruthy();await settle();
  const targets=[...orbit.querySelectorAll<HTMLElement>('button')];noIntersections(targets);
  const summary=orbit.querySelector<HTMLElement>('[data-orbit-overflow]')!;
  const visible=orbit.querySelectorAll('[data-orbit-agent]').length;expect(visible+Number(summary.dataset.orbitOverflow)).toBe(12);
  const rows=host!.querySelectorAll<HTMLElement>('[data-agent-list-row]');expect(rows).toHaveLength(12);
  for(const [i,row] of [...rows].entries()){expect(row.textContent).toContain(spans[i+1]!.subagent!.type!);expect(row.scrollWidth).toBeLessThanOrEqual(row.clientWidth+1);}
  await userEvent.click(summary);expect(document.activeElement).toBe(host!.querySelector('[data-run-span-list]'));
  await page.screenshot({element:host!,path:`../../.vitest-attachments/agent-orbit/${theme}-dense.png`});
});
