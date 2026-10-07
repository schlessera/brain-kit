/** Independent geometry receipts: desktop circles have radii 61/113/165;
 * default frame is 340 x 390. Four equally spaced middle-ring targets land
 * at 12, 3, 6 and 9 o'clock. Values below are hand-computed, not derived
 * from layoutOrbit. Browser coverage checks measured labels and targets. */
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentOrbit, type OrbitAgent } from "../src/agents/AgentOrbit.js";
import { layoutOrbit } from "../src/internal/orbit-layout.js";
const agents: OrbitAgent[] = ["a","b","c","d"].map(id => ({ id, name: id, state: "running" }));
const sizes = Object.fromEntries(agents.map(a => [a.id, { width: 44, height: 44 }]));
function collide(a: {x:number;y:number;width:number;height:number},b: {x:number;y:number;width:number;height:number}) {
  return Math.abs(a.x-b.x)<(a.width+b.width)/2 && Math.abs(a.y-b.y)<(a.height+b.height)/2;
}
describe("state-ring geometry", () => {
  test("clockwise from twelve with independently computed coordinates", () => {
    const p = layoutOrbit(agents,340,284,false,sizes).placed;
    expect(p).toHaveLength(4);
    for (const [i,[x,y]] of [[170,82],[283,195],[170,308],[57,195]].entries()) {
      expect(p[i]!.x).toBeCloseTo(x!,6); expect(p[i]!.y).toBeCloseTo(y!,6);
    }
  });
  test("required state chooses the ring and optional ring overrides it", () => {
    const group: OrbitAgent[] = [{id:"wait",name:"wait",state:"waiting"},{id:"run",name:"run",state:"running"},{id:"done",name:"done",state:"done"},{id:"stop",name:"stop",state:"stopped"}];
    const p = layoutOrbit(group,340,284,false,{});
    expect(p.placed.map(x=>[x.agent?.id,x.ring])).toEqual([["wait",0],["run",1],["done",2],["stop",2]]);
    expect(p.counts).toEqual([1,1,2]);
    expect(layoutOrbit([{...group[0]!,ring:2}],340,284,false,{}).placed[0]!.ring).toBe(2);
  });
  test("twelve long running names retain all identities via overflow without target collisions", () => {
    const group = Array.from({length:12},(_,i)=>({id:String(i),name:"chart-coast-".repeat(12),state:"running" as const}));
    const p = layoutOrbit(group,340,284,false,Object.fromEntries(group.map(a=>[a.id,{width:160,height:90}]))).placed;
    expect(p.length).toBeGreaterThan(0); expect(p.some(x=>x.overflow>0)).toBe(true);
    expect(p.filter(x=>x.agent).length+p.reduce((n,x)=>n+x.overflow,0)).toBe(12);
    for(const [i,a] of p.entries())for(const b of p.slice(i+1))expect(collide(a,b)).toBe(false);
  });
  test("compact circles and all twelve marks fit a narrow frame", () => {
    const group = Array.from({length:12},(_,i)=>({id:String(i),name:"tides",state:"running" as const}));
    const p=layoutOrbit(group,200,236,true,{});
    expect(p.placed).toHaveLength(12); expect(p.radii[2]).toBe(84);
    for(const [i,a] of p.placed.entries()) {
      expect(a.x-a.width/2).toBeGreaterThanOrEqual(0);expect(a.x+a.width/2).toBeLessThanOrEqual(200);
      expect(a.y-a.height/2).toBeGreaterThanOrEqual(0);expect(a.y+a.height/2).toBeLessThanOrEqual(236);
      for(const b of p.placed.slice(i+1))expect(collide(a,b)).toBe(false);
    }
  });
  test("compact marks never create hidden interactive copies", () => {
    const html=renderToStaticMarkup(<AgentOrbit agents={agents} compact onOpen={()=>{}}/>);
    expect(html).not.toContain("<button");expect(html).not.toContain("tabindex");
    expect(html).toContain('aria-label="Agents: 0 needs you, 4 running, 0 ended"');expect(html).not.toContain("aria-live");
  });
});

test("an overflow summary cannot overlap a tall pill on the previous ring", () => {
  const group: OrbitAgent[]=[{id:"run",name:"run",state:"running"},{id:"end",name:"end",state:"done"}];
  const layout=layoutOrbit(group,340,284,false,{wait:{width:160,height:44},run:{width:160,height:90},end:{width:160,height:200}});
  expect(layout.placed).toHaveLength(2);
  for(const [i,a] of layout.placed.entries())for(const b of layout.placed.slice(i+1))expect(collide(a,b)).toBe(false);
});
