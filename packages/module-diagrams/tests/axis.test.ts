import { describe, expect, test } from "bun:test";
import { toStatic } from "../src/render.js";
const legacy = {schema_version:1,type:"sequence",title:"Release from Ogygia",desc:"The release order reaches Odysseus.",size:"doc-inline",nodes:[{id:"zeus",label:"Zeus"},{id:"hermes",label:"Hermes"}],edges:[{from:"zeus",to:"hermes",label:"RELEASE ORDER"}]};
describe("axis family",()=>{test("existing v1 sequence renders readable lifelines",async()=>{const svg=await toStatic(JSON.stringify(legacy),{theme:"light"}); expect(svg).toContain('data-axis="lifeline"');expect(svg).toContain("RELEASE ORDER");});});

import { checkDiagram } from "../src/check.js";
import { buildDiagram } from "../src/geometry.js";
import { buildAxisDiagram } from "../src/axis-layout.js";
import { diagramSvgModel } from "../src/svg-model.js";
import { axisExamples } from "./fixtures/axis-examples.js";
const check=(spec:unknown)=>checkDiagram(JSON.stringify(spec));
for(const [kind,spec] of Object.entries(axisExamples))test(`${kind} canonical example and every theme render`,async()=>{
 expect(JSON.parse(await Bun.file(new URL(`./fixtures/${kind}.diagram.yaml`,import.meta.url)).text())).toEqual(spec);
 expect(JSON.parse(await Bun.file(new URL(`../skills/diagram/references/examples/${kind}.diagram.yaml`,import.meta.url)).text())).toEqual(spec);
 expect(check(spec).errors).toEqual([]);
 for(const theme of ["light","dark","print"] as const){const svg=await toStatic(JSON.stringify(spec),{theme});expect(svg).toContain(`data-theme="${theme}"`);expect(svg).not.toContain("NaN");expect(svg).not.toContain("Infinity");expect(svg).not.toMatch(/<script|foreignObject|onload=/);}
 const tree=buildDiagram(spec);expect(tree.elements.length).toBeGreaterThan(0);
 for(const shape of tree.elements){if(shape.kind!=="shape")continue;expect([shape.x,shape.y,shape.width,shape.height].every(Number.isFinite)).toBe(true);expect(shape.x).toBeGreaterThanOrEqual(0);expect(shape.y).toBeGreaterThanOrEqual(0);expect(shape.x+shape.width).toBeLessThanOrEqual(tree.viewBox.width);expect(shape.y+shape.height).toBeLessThanOrEqual(tree.viewBox.height);}
});
test("approved four participant sequence reflows at normal type and wide sequences refuse inline",()=>{
 const model=diagramSvgModel(axisExamples.sequence,"narrow");expect(model.tree.viewBox.width).toBe(320);expect(model.minimumFont).toBe(9.5);
 const spec=structuredClone(axisExamples.sequence);spec.nodes.push({id:"penelope",label:"Penelope"},{id:"athena",label:"Athena"});expect(()=>buildAxisDiagram(spec,320)).toThrow("64px");
 const named=structuredClone(axisExamples.sequence);named.nodes[0]!.label="Zeus with an exceptionally long participant name";expect(()=>buildAxisDiagram(named,320)).toThrow("without shrinking");
 const tagged=structuredClone(axisExamples.sequence);Object.assign(tagged.nodes[0]!,{tag:"GOD"});const tree=buildAxisDiagram(tagged,320);expect(tree.elements.some(s=>s.kind==="shape"&&s.shape==="rect"&&s.name==="participant"&&s.height===52)).toBe(true);
 const noTags=buildAxisDiagram(axisExamples.sequence);expect(noTags.elements.filter(s=>s.kind==="shape"&&s.shape==="text"&&s.text==="AGENT")).toEqual([]);
});
test("sequence kinds retain semantic dash and focal shape distinctions",async()=>{
 const svg=await toStatic(JSON.stringify(axisExamples.sequence),{theme:"print"});expect(svg).toContain('stroke-dasharray="1.5 3.5"');expect(svg).toContain('stroke-linecap="round"');expect(svg).toContain('stroke-dasharray="6 4"');expect(svg).toContain('data-axis="self-message"');expect(svg).toContain("Scheria by July 29");expect(svg).toContain("var(--bk-amber-ink)");
});
test("one over every family editorial budget warns without invalidating the data",()=>{
 const sequence=structuredClone(axisExamples.sequence);sequence.nodes.push({id:"penelope",label:"Penelope"},{id:"athena",label:"Athena"});expect(check(sequence).warnings.some(w=>w.path==="$.nodes"&&w.message.includes("5"))).toBe(true);
 const messages=structuredClone(axisExamples.sequence);messages.axis.messages=Array.from({length:13},(_,i)=>({id:`call-${i}`,from:"zeus",to:"hermes",label:"CALL"}));const result=check(messages);expect(result.valid).toBe(true);expect(result.warnings.some(w=>w.path==="$.axis.messages"&&w.message.includes("12"))).toBe(true);
 const lanes=structuredClone(axisExamples.swimlane);lanes.axis.lanes=Array.from({length:6},(_,i)=>({id:`lane-${i}`,label:`LANE ${i}`}));lanes.axis.steps.forEach((s,i)=>s.lane=`lane-${i}`);expect(check(lanes).warnings.some(w=>w.path==="$.axis.lanes")).toBe(true);
 const timeline=structuredClone(axisExamples.timeline);timeline.nodes=Array.from({length:10},(_,i)=>({id:`event-${i}`,label:`Event ${i}`}));timeline.axis.events=timeline.nodes.map((n,i)=>({node:n.id,date:`2026-07-${String(12+i).padStart(2,"0")}`}));expect(check(timeline).warnings.some(w=>w.path==="$.nodes")).toBe(true);
 const gantt=structuredClone(axisExamples.gantt);gantt.nodes=Array.from({length:13},(_,i)=>({id:`task-${i}`,label:`Task ${i}`}));gantt.axis.tasks=gantt.nodes.map(n=>({node:n.id,start:"2026-07-08",end:"2026-07-12",phase:"preparation"}));const over=check(gantt);expect(over.valid).toBe(true);expect(over.warnings.some(w=>w.path==="$.axis.tasks"&&w.message.includes("12"))).toBe(true);expect(over.warnings.some(w=>w.message.includes("parallel"))).toBe(true);
});
test("dates, references, one owner and bounded fragment semantics refuse invalid data",()=>{
 const timeline=structuredClone(axisExamples.timeline);timeline.axis.events[0]!.date="2026-02-30";expect(check(timeline).valid).toBe(false);timeline.axis.events[0]!.date="2026-08-01";expect(check(timeline).errors.some(e=>e.message.includes("ordered"))).toBe(true);
 const gantt=structuredClone(axisExamples.gantt);gantt.axis.tasks[0]!.end="2026-07-07";expect(check(gantt).errors.some(e=>e.message.includes("precedes"))).toBe(true);
 const lanes=structuredClone(axisExamples.swimlane);lanes.axis.steps[0]!.lane="missing";expect(check(lanes).errors.some(e=>e.message.includes("Unknown lane"))).toBe(true);
 const sequence=structuredClone(axisExamples.sequence);sequence.axis.messages[0]!.to="missing";expect(check(sequence).errors.some(e=>e.message.includes("Unknown node"))).toBe(true);
 const fragments={...axisExamples.sequence,axis:{...axisExamples.sequence.axis,fragments:[{kind:"alt",from:0,to:2,guard:"READY",elseAt:1,elseGuard:"WAIT"}]}};expect(check(fragments).valid).toBe(true);expect(buildDiagram(fragments as typeof axisExamples.sequence).elements.some(s=>s.kind==="shape"&&s.name==="fragment-divider")).toBe(true);
 fragments.axis.fragments[0]!.elseAt=4;expect(check(fragments).errors.some(e=>e.message.includes("two nonempty"))).toBe(true);
 const focal=structuredClone(axisExamples.sequence);focal.axis.messages.slice(0,3).forEach(m=>m.focal=true);expect(check(focal).errors.some(e=>e.message.includes("two focal"))).toBe(true);
});
test("dated geometry uses real intervals and duration instead of evenly spacing dates",()=>{
 const timeline=buildDiagram(axisExamples.timeline);const events=timeline.elements.filter(s=>s.kind==="shape"&&s.shape==="circle");expect(events.length).toBe(3);if(events[0]!.kind!=="shape"||events[1]!.kind!=="shape"||events[2]!.kind!=="shape")throw Error("missing events");expect((events[1]!.x-events[0]!.x)/(events[2]!.x-events[0]!.x)).toBeCloseTo(17/20,2);
 const gantt=buildDiagram(axisExamples.gantt);const tasks=gantt.elements.filter(s=>s.kind==="shape"&&s.name==="task");expect((tasks[1] as {width:number}).width/(tasks[0] as {width:number}).width).toBeCloseTo(3);
});

test("generated dated intervals retain proportional geometry across calendar boundaries",()=>{
 for(let seed=1;seed<=48;seed++){
  const start=Date.UTC(2026,5,20),a=seed%7+1,b=a+(seed*7)%19+1,date=(offset:number)=>new Date(start+offset*86400000).toISOString().slice(0,10);
  const spec={...axisExamples.timeline,axis:{kind:"timeline" as const,events:[{node:"departure",date:date(0)},{node:"scheria",date:date(a)},{node:"ithaca",date:date(b)}]}};
  const tree=buildDiagram(spec),circles=tree.elements.filter(e=>e.kind==="shape"&&e.shape==="circle");
  const cx=(index:number)=>{const e=circles[index]!;if(e.kind!=="shape"||e.shape!=="circle")throw Error("missing dated event");return e.cx;};
  expect((cx(1)-cx(0))/(cx(2)-cx(0)),"DATE_INTERVAL_PROPORTION").toBeCloseTo(a/b,8);
  expect(JSON.stringify(buildDiagram(spec)),"DETERMINISTIC_AXIS_TREE").toBe(JSON.stringify(tree));
 }
});

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTempBrain,runCli,cleanup } from "../../core/tests/cli-harness.js";
test("axis examples flow through the real CLI with unchanged pinned check envelopes",async()=>{
 const root=makeTempBrain({empty:true});try{
  writeFileSync(join(root,"brain.config.ts"),'import {defineConfig} from "@schlessera/brain"; export default defineConfig({modules:{"@schlessera/brain-module-diagrams":{}}});\n');
  for(const [type,spec] of Object.entries(axisExamples)){
   writeFileSync(join(root,"figure.diagram.yaml"),JSON.stringify(spec));const result=await runCli(root,["diagram","check","figure.diagram.yaml","--json"]);expect(result.code,result.stderr).toBe(0);expect(JSON.parse(result.stdout)).toEqual({schema_version:1,valid:true,type,errors:[],warnings:[]});
  }
 }finally{cleanup(root);}
});
