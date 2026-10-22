import {parse} from "yaml";
import { expect, test } from "bun:test";
import { toStatic } from "../src/render.js";
const source=await Bun.file(new URL("./fixtures/callouts.diagram.yaml",import.meta.url)).text();
test("accepted common annotation is preserved with its target in static output",async()=>{
 const svg=await toStatic(source,{theme:"light"});
 expect(svg).toContain('data-diagram-callout="0"');
 expect(svg).toContain('data-target="odysseus"');
 expect(svg).toContain("PREPARE PROVISIONS");
});
import { checkDiagram } from "../src/check.js";
import { diagramSvgModel, parseDiagram } from "../src/svg-model.js";
import { planCallouts, wrapCallout } from "../src/callouts.js";
import { diagramLegend } from "../src/legend.js";
import { buildDiagram } from "../src/geometry.js";
import { axisExamples } from "./fixtures/axis-examples.js";
const literal=JSON.parse(source);
const single=(side?:string)=>({...literal,groups:[],edges:[],size:"doc-inline",nodes:[{id:"odysseus",label:"Odysseus",at:[400,200],size:[160,64]}],callouts:[{target:"odysseus",text:"Prepare provisions",...(side?{side}:{})}]});
const plan=(input:unknown)=>{const spec=parseDiagram(JSON.stringify(input)),tree=buildDiagram(spec);return planCallouts(spec,tree,diagramLegend(spec,tree).footerHeight);};
test("all four authored preferences and omitted-hint default use collision-safe order",()=>{
 for(const side of ["below","above","right","left",undefined])expect(String(plan(single(side)).placements[0]!.placement)).toBe(side??"below");
 const blocked=single("below");blocked.nodes.push({id:"hermes",label:"Hermes",at:[360,280],size:[240,64]});expect(plan(blocked).placements[0]!.placement).toBe("above");
 expect(checkDiagram(JSON.stringify(single("diagonal")))).toMatchObject({valid:false,errors:[{path:"$.callouts[0].side",code:"schema"}]});
});
test("fixed named canvas reports callout_room during validation, fit preserves readable content",()=>{
 const crowded=single();crowded.nodes[0]!.at=[8,8];crowded.nodes[0]!.size=[944,584];
 expect(checkDiagram(JSON.stringify(crowded))).toMatchObject({valid:false,errors:[{path:"$.callouts[0]",code:"callout_room",message:expect.stringContaining("size: fit")}]});
 expect(checkDiagram(JSON.stringify({...crowded,size:"fit"})).valid).toBe(true);
});
test("notes wrap without truncation or shrinking and long words keep their full measure",()=>{
 const text="Odysseus prepares the provisions before the voyage to Ithaca.";const wrapped=wrapCallout(text);expect(wrapped.lines.length).toBeGreaterThan(1);expect(wrapped.lines.join(" ")).toBe(text);expect(wrapped.width).toBeLessThanOrEqual(168);
 const word="W".repeat(200);expect(wrapCallout(word)).toMatchObject({lines:[word],width:expect.any(Number)});expect(wrapCallout(word).width).toBeGreaterThan(168);
 const spec={...single(),size:"fit",callouts:[{target:"odysseus",text:word}]};expect(checkDiagram(JSON.stringify(spec)).valid).toBe(true);const model=diagramSvgModel(parseDiagram(JSON.stringify(spec)));expect(model.tree.viewBox.width).toBeGreaterThan(wrapCallout(word).width);
});
test("node, group, named edge and scope annotations retain source order and budget warning",async()=>{
 const spec=structuredClone(literal);spec.edges[1].id="record";spec.callouts=[{target:"odysseus",text:"PREPARE PROVISIONS"},{target:"record",text:"Written at landfall"},{target:"voyage",text:"Voyage records"}];
 const checked=checkDiagram(JSON.stringify(spec));expect(checked.valid).toBe(true);expect(checked.warnings).toContainEqual(expect.objectContaining({path:"$.callouts",code:"budget"}));
 const placements=plan(spec).placements;expect(placements.map(item=>item.target)).toEqual(["odysseus","record","voyage"]);expect(placements.slice(0,2).every(item=>item.placement!=="band")).toBe(true);
 const svg=await toStatic(JSON.stringify(spec),{theme:"print"});for(const note of spec.callouts)expect(svg).toContain(note.text);expect(svg).toContain('aria-label="VOYAGE, 1 note"');
 const scope=parse(await Bun.file(new URL("../skills/diagram/references/examples/architecture-containment.diagram.yaml",import.meta.url)).text());const target=scope.containment.scopes[0];scope.callouts=[{target:target.id,text:"Arrival records"}];expect(plan(scope).placements[0]!.name).toBe(target.label);
});
test("authored narrow keeps semantics, appends ordered notes band before the legend",()=>{
 const spec=structuredClone(literal);spec.edges[1].id="record";spec.callouts.push({target:"record",text:"Written at landfall"});spec.layouts={narrow:{width:320,height:368,nodes:[{id:"hermes",at:[48,24],size:[224,64]},{id:"odysseus",at:[48,152],size:[224,64]},{id:"ledger",at:[48,280],size:[224,64]}]}};
 const model=diagramSvgModel(parseDiagram(JSON.stringify(spec)),"narrow");expect(model.tree.viewBox.width).toBe(320);expect(model.tree.viewBox.height).toBeGreaterThan(368);
 const notes=allPrimitives(model.elements).filter(item=>item.attrs["data-diagram-callout"]!==undefined);expect(notes.map(item=>item.attrs["data-diagram-callout"]).sort()).toEqual([0,1]);expect(notes.some(item=>item.attrs["data-placement"]==="band")).toBe(true);
 expect(model.elements.findIndex(item=>item.attrs["data-diagram-notes-band"]!==undefined)).toBeLessThan(model.elements.findIndex(item=>item.attrs["data-diagram-legend"]!==undefined));
});
test("generated shape targets and accepted semantic-only targets preserve association",async()=>{
 for(const original of Object.values(axisExamples)){
  const spec={...structuredClone(original),size:"fit",callouts:[{target:original.nodes[0]!.id,text:"Prepare provisions"}]};const checked=checkDiagram(JSON.stringify(spec));expect(checked.valid,JSON.stringify(checked)).toBe(true);const svg=await toStatic(JSON.stringify(spec),{theme:"light"});expect(svg).toContain(`data-target="${original.nodes[0]!.id}"`);expect(svg).toContain("Prepare provisions");
 }
 const sequence={...axisExamples.sequence,size:"fit",edges:[{id:"word",from:"zeus",to:"hermes",label:"WORD"}],callouts:[{target:"word",text:"Prepare provisions"}]};expect(plan(sequence).placements[0]).toMatchObject({target:"word",name:"WORD"});
});

import type { SvgPrimitive } from "../src/svg-model.js";
function allPrimitives(items: SvgPrimitive[]): SvgPrimitive[] { return items.flatMap(item=>[item,...allPrimitives(item.children??[])]); }
function planned(input: unknown, width?: number) {
 const spec=parseDiagram(JSON.stringify(input)), tree=buildDiagram(spec);
 if(width!==undefined) tree.viewBox.width=width;
 return {spec,tree,plan:planCallouts(spec,tree,diagramLegend(spec,tree).footerHeight)};
}
test("R1 groups every repeated target by identity and retains interleaved source indices",()=>{
 const spec={...single(),size:"fit",nodes:[{id:"odysseus",label:"Voyage",at:[80,80],size:[160,64]},{id:"hermes",label:"Voyage",at:[400,80],size:[160,64]},{id:"ledger",label:"Ledger",at:[720,80],size:[160,64]}],callouts:[{target:"odysseus",text:"First provisions",side:"below"},{target:"hermes",text:"First message"},{target:"odysseus",text:"Second provisions",side:"above"},{target:"ledger",text:"Single record"},{target:"hermes",text:"Second message"}]};
 const result=planned(spec).plan;
 expect(result.groups.map(group=>[group.target,group.indices])).toEqual([["odysseus",[0,2]],["hermes",[1,4]]]);
 expect(result.placements.filter(note=>note.target!=="ledger").every(note=>note.placement==="band"),"R1_ALL_REPEATED_NOTES_BAND").toBe(true);
 expect(result.placements[3]!.placement).toBe("below");
 expect(result.groups.map(group=>group.key)).toEqual([1,2]);
});
test("1024 repeated notes keep one cue, full source text and four-digit indices",async()=>{
 const spec={...literal,callouts:Array.from({length:1024},(_,index)=>({target:"odysseus",text:`Prepare provisions ${index+1}`}))};
 const result=planned(spec).plan;
 expect(result.placements).toHaveLength(1024);expect(result.groups).toHaveLength(1);expect(result.groups[0]!.key).toBe(1);
 expect(result.placements.map(note=>note.index)).toEqual(Array.from({length:1024},(_,i)=>i));
 for(const note of result.placements)expect(note.lines.join(" ")).toBe(spec.callouts[note.index]!.text);
 const svg=await toStatic(JSON.stringify(spec),{theme:"light"});
 expect(svg.match(/data-diagram-callout-key=/g)).toHaveLength(1);expect(svg.match(/data-diagram-callout="/g)).toHaveLength(1024);expect(svg).toContain('data-diagram-callout="1023"');expect(svg).toContain("Prepare provisions 1024");
});
test("R2 flows full grouped rows down two columns exactly at 640",()=>{
 const spec={...single(),size:"fit",nodes:[{id:"odysseus",label:"Odysseus",at:[48,48],size:[160,64]}],callouts:Array.from({length:9},(_,i)=>({target:"odysseus",text:i%2?"Prepare provisions before the long voyage to Ithaca and record the result.":`Voyage ${i+1}`}))};
 for(const width of [320,639,640]){
  const result=planned(spec,width).plan;
  expect(result.columns,"R2_COLUMN_THRESHOLD").toBe(width>=640?2:1);
  expect(result.placements.map(note=>note.column)).toEqual(width>=640?[0,0,0,0,0,1,1,1,1]:Array(9).fill(0));
  const group=result.groups[0]!;for(const header of group.headers)expect(header.width).toBeGreaterThanOrEqual(width>=640?280:width-32);
  for(const column of [0,1]){const rows=result.placements.filter(note=>note.column===column);for(let i=1;i<rows.length;i++)expect(rows[i]!.box.y).toBeGreaterThanOrEqual(rows[i-1]!.box.y+rows[i-1]!.box.height+4);}
 }
});
test("fixed named canvas preserves all-inline only when revised band cannot fit",()=>{
 const input={...single(),nodes:[{id:"odysseus",label:"Odysseus",at:[400,460],size:[160,64]}],callouts:[{target:"odysseus",text:"Prepare provisions"},{target:"odysseus",text:"Read the ledger"}]};
 expect(checkDiagram(JSON.stringify(input)).valid,"FIXED_CANVAS_INLINE_COMPATIBILITY_VALID").toBe(true);
 const fixed=planned(input);
 expect(fixed.tree.viewBox).toMatchObject({width:960,height:600});
 expect(fixed.plan.errors).toEqual([]);expect(fixed.plan.groups).toHaveLength(0);
 expect(fixed.plan.placements.map(note=>note.placement),"FIXED_CANVAS_INLINE_COMPATIBILITY").toEqual(["below","above"]);
 const spacious=structuredClone(input);spacious.nodes[0]!.at[1]=440;expect(planned(spacious).plan.placements.every(note=>note.placement==="band")).toBe(true);
 const crowded=structuredClone(input);crowded.nodes[0]!.at=[8,8];crowded.nodes[0]!.size=[944,584];
 expect(checkDiagram(JSON.stringify(crowded)).errors.map(error=>error.code)).toEqual(["callout_room","callout_room"]);
 expect(checkDiagram(JSON.stringify({...crowded,size:"fit"})).valid).toBe(true);
});
test("semantic-only targets have exact named explanation, no invented cue or connector",async()=>{
 const input={...literal,type:"quadrant",groups:[],nodes:[{id:"odysseus",label:"Odysseus"}],edges:[{id:"record",from:"odysseus",to:"odysseus",label:"RECORD"}],callouts:[{target:"record",text:"Prepare provisions"}]};
 const result=planned(input).plan;expect(result.groups[0]).toMatchObject({target:"record",name:"RECORD",drawn:"false",key:undefined});
 const svg=await toStatic(JSON.stringify(input),{theme:"light"});expect(svg).toContain('data-target-drawn="false"');expect(svg).toContain("Not drawn: quadrant diagrams don’t draw connectors.");expect(svg).not.toContain("data-diagram-callout-key");
});

test("fixed compatibility retry stops once the remaining repeated group band fits",()=>{
 const input={...single(),nodes:[{id:"odysseus",label:"Odysseus",at:[160,440],size:[160,64]},{id:"hermes",label:"Hermes",at:[600,440],size:[160,64]}],callouts:[{target:"odysseus",text:"Provisions",side:"above"},{target:"odysseus",text:"Ledger",side:"left"},{target:"hermes",text:"First message"},{target:"hermes",text:"Second message"}]};
 const result=planned(input).plan;
 expect(result.groups.map(group=>group.target),"MINIMAL_FIXED_COMPATIBILITY_EXCEPTION").toEqual(["hermes"]);
 expect(result.placements.slice(0,2).every(note=>note.placement!=="band")).toBe(true);expect(result.placements.slice(2).every(note=>note.placement==="band")).toBe(true);
});
test("fixed width-only band failure tries all-inline and fit columns never invade neighbors",()=>{
 const input={...single(),callouts:[{target:"odysseus",text:"W".repeat(48)},{target:"odysseus",text:"W".repeat(48)}]};
 const result=planned(input).plan;expect(result.errors).toEqual([]);expect(result.placements.every(note=>note.placement!=="band"),"WIDTH_ONLY_INLINE_COMPATIBILITY").toBe(true);
 const fit=planned({...input,size:"fit"});expect(fit.plan.columns).toBe(2);for(const note of fit.plan.placements){const header=fit.plan.groups[0]!.headers[note.column!]!;expect(note.box.x+note.box.width).toBeLessThanOrEqual(header.x+header.width);}
});
test("axis message IDs with different endpoints never impersonate the declared common edge",()=>{
 const input={...axisExamples.sequence,size:"fit",edges:[{id:"record",from:"zeus",to:"hermes",label:"RECORD"}],axis:{kind:"sequence",messages:[{id:"record",from:"hermes",to:"zeus",label:"RETURN"}]},callouts:[{target:"record",text:"Prepare provisions"}]};
 const result=planned(input).plan;expect(result.groups[0]).toMatchObject({target:"record",drawn:"false",key:undefined});expect(result.placements[0]!.placement).toBe("band");
});
