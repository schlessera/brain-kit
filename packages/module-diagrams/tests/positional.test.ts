import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { checkDiagram } from "../src/check.js";
import { toStatic } from "../src/render.js";
const types = ["quadrant", "layer-stack", "pyramid", "funnel", "loop", "flywheel", "venn"];
for (const type of types) test(`${type}: typed positional grammar renders in all three themes`, async () => {
 const source = readFileSync(new URL(`../skills/diagram/references/examples/positional/${type}.diagram.yaml`, import.meta.url), "utf8");
 expect(checkDiagram(source).errors, "POSITIONAL_GRAMMAR_ACCEPTED").toEqual([]);
 for (const theme of ["light", "dark", "print"] as const) {
  const output = await toStatic(source, {theme}); expect(output).toContain(`<svg`); expect(output).toContain('data-diagram-shape=');
 }
});
import { buildDiagram } from "../src/geometry.js";
import type { DiagramShape } from "../src/shape.js";
for (const type of ["loop","flywheel"]) test(`${type}: actual ring/spoke samples clear all opaque label masks`, () => {
 const spec=JSON.parse(readFileSync(new URL(`../skills/diagram/references/examples/positional/${type}.diagram.yaml`,import.meta.url),"utf8")),tree=buildDiagram(spec),shapes=tree.elements.filter((e):e is DiagramShape=>e.kind==="shape");
 const masks=shapes.filter(e=>e.paint==="mask"),cx=tree.viewBox.width/2,cy=tree.viewBox.height/2-20;
 for(const shape of shapes){const points:Array<{x:number;y:number}>=[];
  if(shape.shape==="line")for(let i=0;i<=128;i++)points.push({x:shape.x1+(shape.x2-shape.x1)*i/128,y:shape.y1+(shape.y2-shape.y1)*i/128});
  if(shape.shape==="path"){const values=shape.d.match(/[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:e[-+]?\d+)?/gi)!.map(Number),[sx,sy,r]=values as [number,number,number],ex=values[7]!,ey=values[8]!,start=Math.atan2(sy-cy,sx-cx),end=Math.atan2(ey-cy,ex-cx),angle=(end-start+2*Math.PI)%(2*Math.PI);for(let i=0;i<=128;i++)points.push({x:cx+r*Math.cos(start+angle*i/128),y:cy+r*Math.sin(start+angle*i/128)});}
  for(const point of points)for(const node of shapes.filter(e=>e.nodeId&&e.shape==="rect"&&e.nodeId!==shape.from&&e.nodeId!==shape.to)){const distance=Math.hypot(Math.max(node.x-point.x,0,point.x-node.x-node.width),Math.max(node.y-point.y,0,point.y-node.y-node.height));expect(distance,`LOOP_NONENDPOINT_NODE_CLEARANCE ${shape.id}/${node.id}`).toBeGreaterThanOrEqual(8-.001);}
  for(const point of points)for(const mask of masks){const dx=Math.max(mask.x-point.x,0,point.x-mask.x-mask.width),dy=Math.max(mask.y-point.y,0,point.y-mask.y-mask.height);expect(Math.hypot(dx,dy),`LOOP_MASK_CLEARANCE ${shape.id}/${mask.id}`).toBeGreaterThanOrEqual(8-0.001);}
 }
});

const example=(type:string)=>JSON.parse(readFileSync(new URL(`../skills/diagram/references/examples/positional/${type}.diagram.yaml`,import.meta.url),"utf8"));
const shapes=(spec:any)=>buildDiagram(spec).elements.filter((e):e is DiagramShape=>e.kind==="shape");
test("Venn unequal areas retain genuine overlap, grid geometry and complete intersection containment or a leader",()=>{
 for(const weights of[[1,2,4],[1,16,64],[1,1,1]]){
  const spec=example("venn");spec.size="social-square";spec.positional.venn.sets.forEach((set:any,i:number)=>set.weight=weights[i]);
  expect(checkDiagram(JSON.stringify(spec)).errors,"HONEST_VENN_ACCEPTANCE").toEqual([]);
  const scene=shapes(spec),circles=scene.filter((s):s is Extract<DiagramShape,{shape:"circle"}>=>s.shape==="circle"&&Boolean(s.nodeId));
  const maximum=Math.max(...weights),largest=Math.max(...circles.map(c=>c.radius));
  circles.forEach((c,i)=>{for(const n of[c.cx,c.cy,c.radius])expect(n%4).toBe(0);expect(Math.abs((c.radius/largest)**2/(weights[i]!/maximum)-1),"HONEST_VENN_AREA").toBeLessThanOrEqual(.05);expect(Math.hypot(c.cx-540,c.cy-500),"GENUINE_VENN_OVERLAP").toBeLessThan(c.radius);});
  for(const region of scene.filter(s=>/^intersection-\d+$/.test(s.id))){const leader=scene.find(s=>s.id===region.id.replace("intersection-","intersection-leader-"));
   if(leader){expect(leader.shape).toBe("line");expect(scene.some(s=>s.id===region.id.replace("intersection-","intersection-anchor-"))).toBe(true);}
   else for(const c of circles)for(const x of[region.x,region.x+region.width])for(const y of[region.y,region.y+region.height])expect(Math.hypot(x-c.cx,y-c.cy),"FULL_VENN_LABEL_CONTAINMENT").toBeLessThanOrEqual(c.radius-4+.001);
  }
 }
 const extreme=example("venn");extreme.positional.venn.sets.forEach((s:any,i:number)=>s.weight=i?1:1000000);expect(checkDiagram(JSON.stringify(extreme)).errors.some(e=>e.message.includes("honest areas"))).toBe(true);
});
test("Pyramid apex, quantitative widths and both text lines stay in actual trapezoid",()=>{
 for(const type of["pyramid","funnel"]){const spec=example(type);spec.nodes.forEach((n:any)=>n.sub="CREW");spec.positional.pyramid.layers.forEach((l:any,i:number)=>l.value=type==="pyramid"?(i+1)*20:(4-i)*20);
  expect(checkDiagram(JSON.stringify(spec)).errors).toEqual([]);const scene=shapes(spec),polygons=scene.filter((s):s is Extract<DiagramShape,{shape:"polygon"}>=>s.shape==="polygon");
  polygons.forEach((p,i)=>{const top=p.points[1]!.x-p.points[0]!.x,bottom=p.points[2]!.x-p.points[3]!.x,expected=(spec.positional.pyramid.layers[i].value/80)*640;expect(type==="pyramid"?bottom:top,"QUANTITATIVE_LAYER_WIDTH").toBeCloseTo(expected,6);if(type==="pyramid"&&i===0)expect(top,"TRUE_PYRAMID_APEX").toBe(0);
   for(const text of scene.filter(s=>s.shape==="text"&&(s.id===`${p.id}-name`||s.id===`${p.id}-sub`))){for(const y of[text.y,text.y+text.height]){const available=top+(bottom-top)*(y-p.y)/p.height;expect(text.x,"POLYGON_TEXT_LEFT").toBeGreaterThanOrEqual(480-available/2+7.99);expect(text.x+text.width,"POLYGON_TEXT_RIGHT").toBeLessThanOrEqual(480+available/2-7.99);}}
  });expect(scene.filter(s=>s.shape==="text"&&s.id.endsWith("-sub")).length).toBe(4);
 }
});
test("Explicit positional references reject structural ambiguity and old v1 forms stay accepted",()=>{
 for(const type of types){const spec=example(type);delete spec.positional;expect(checkDiagram(JSON.stringify(spec)).errors,`LEGACY_${type}`).toEqual([]);}
 const loop=example("loop");loop.positional.loop.stations[0]=loop.positional.loop.hub;expect(checkDiagram(JSON.stringify(loop)).errors.some(e=>e.code==="positional")).toBe(true);
 const quadrant=example("quadrant");quadrant.positional.quadrant.points[0].x=0;expect(checkDiagram(JSON.stringify(quadrant)).errors.some(e=>e.message.includes("axis"))).toBe(true);
 const venn=example("venn");venn.positional.venn.intersections[0].members=["crew","crew"];expect(checkDiagram(JSON.stringify(venn)).errors.some(e=>e.message.includes("distinct"))).toBe(true);
});
test("Each positional family reports editorial one-over-budget warnings",()=>{
 for(const type of types){const spec=example(type),count=type==="quadrant"?13:type==="venn"?4:type==="loop"||type==="flywheel"?10:7;spec.nodes=Array.from({length:count},(_,i)=>({id:`n${i}`,label:`N${i}`}));delete spec.positional;const result=checkDiagram(JSON.stringify(spec));expect(result.errors,`BUDGET_NOT_FATAL_${type}`).toEqual([]);const noun=type==="quadrant"?"quadrant items":type==="loop"||type==="flywheel"?"loop stations":type==="venn"?"Venn sets":type==="layer-stack"?"layers":`${type} layers`;expect(result.warnings.some(e=>e.code==="budget"&&e.message.includes(noun)),`FAMILY_BUDGET_WARNING_${type}`).toBe(true);}
});

test("Generated scenes contain finite full strokes, arrowheads, circles, masks and circular extrema",()=>{
 for(const type of types){const spec=example(type),tree=buildDiagram(spec),scene=shapes(spec),inside=(x:number,y:number,padding=1)=>{expect(Number.isFinite(x)&&Number.isFinite(y),"FINITE_SCENE_COORDINATES").toBe(true);expect(x-padding,"SCENE_LEFT_STROKE").toBeGreaterThanOrEqual(0);expect(y-padding,"SCENE_TOP_STROKE").toBeGreaterThanOrEqual(0);expect(x+padding,"SCENE_RIGHT_STROKE").toBeLessThanOrEqual(tree.viewBox.width);expect(y+padding,"SCENE_BOTTOM_STROKE").toBeLessThanOrEqual(tree.viewBox.height-32);};
  for(const shape of scene){for(const x of[shape.x,shape.x+shape.width])for(const y of[shape.y,shape.y+shape.height])inside(x,y);if(shape.shape==="circle")for(const [dx,dy]of[[1,0],[-1,0],[0,1],[0,-1]])inside(shape.cx+shape.radius*dx!,shape.cy+shape.radius*dy!);if(shape.shape==="polygon")for(const p of shape.points)inside(p.x,p.y);if(shape.arrow){const a=shape.arrow;inside(a.x,a.y);for(const side of[-1,1])inside(a.x-a.dx*7+a.dy*4*side,a.y-a.dy*7-a.dx*4*side);}
   if(shape.shape==="path"&&shape.id.startsWith("ring-")){const values=shape.d.match(/[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:e[-+]?\d+)?/gi)!.map(Number);expect(values[2],"COMMON_RING_RADIUS").toBe(216);expect(values[3]).toBe(216);expect(values[6],"CLOCKWISE_RING_SWEEP").toBe(1);const source=scene.find(e=>e.nodeId===shape.from&&e.shape==="rect")!,target=scene.find(e=>e.nodeId===shape.to&&e.shape==="rect")!;
    for(const [x,y,box]of[[values[0]!,values[1]!,source],[values[7]!,values[8]!,target]]as const){const distance=Math.min(Math.abs(x-box.x),Math.abs(x-box.x-box.width),Math.abs(y-box.y),Math.abs(y-box.y-box.height));expect(distance,"RING_END_ON_STATION_EDGE").toBeLessThan(.001);expect(Math.hypot(x-tree.viewBox.width/2,y-(tree.viewBox.height/2-20)),"TRUE_CIRCULAR_RING").toBeCloseTo(216,6);}
   }
  }
 }
});

test("Venn common focal set warning is actionable and the legend follows actual region paint",async()=>{
 const spec=example("venn");delete spec.positional.venn.intersections;spec.nodes[0].role="focal";const source=JSON.stringify(spec),result=checkDiagram(source);expect(result.valid).toBe(true);expect(result.warnings.some(w=>w.code==="positional"&&w.message.includes("intersections[].focal"))).toBe(true);expect(await toStatic(source,{theme:"light"})).not.toContain('data-legend-key="focal"');
 spec.positional.venn.intersections=[{members:spec.nodes.map((n:any)=>n.id),label:"READY",focal:true}];expect(await toStatic(JSON.stringify(spec),{theme:"light"})).toContain('data-legend-key="focal"');
});

test("Quadrant labels cannot cross an axis at a near-zero authored coordinate",()=>{const spec=example("quadrant");spec.positional.quadrant.points[0].y=.01;expect(checkDiagram(JSON.stringify(spec)).errors.some(e=>e.message.includes("clear of both axes"))).toBe(true);});

test("Legacy quadrant does not invent scored coordinates or named dimensions",async()=>{const spec=example("quadrant");delete spec.positional;const result=checkDiagram(JSON.stringify(spec));expect(result.valid).toBe(true);expect(result.warnings.some(w=>w.code==="positional"&&w.message.includes("Positions and axes were not provided"))).toBe(true);const svg=await toStatic(JSON.stringify(spec),{theme:"light"});expect(svg).toContain("POSITIONS AND AXES NOT PROVIDED");expect(svg).not.toContain('data-diagram-shape="x-axis"');expect(svg).not.toContain('data-diagram-shape="sail"');expect(svg).toContain("Repair sail");});
