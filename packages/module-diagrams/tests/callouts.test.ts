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
 for(const side of ["below","above","right","left",undefined])expect(plan(single(side)).placements[0]!.placement).toBe(side??"below");
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
 const placements=plan(spec).placements;expect(placements.map(item=>item.target)).toEqual(["odysseus","record","voyage"]);expect(placements.slice(0,2).every(item=>item.placement!=="marker")).toBe(true);
 const svg=await toStatic(JSON.stringify(spec),{theme:"print"});for(const note of spec.callouts)expect(svg).toContain(note.text);expect(svg).toContain('aria-label="VOYAGE, note: Voyage records"');
 const scope=parse(await Bun.file(new URL("../skills/diagram/references/examples/architecture-containment.diagram.yaml",import.meta.url)).text());const target=scope.containment.scopes[0];scope.callouts=[{target:target.id,text:"Arrival records"}];expect(plan(scope).placements[0]!.name).toBe(target.label);
});
test("authored narrow keeps semantics, appends ordered notes band before the legend",()=>{
 const spec=structuredClone(literal);spec.edges[1].id="record";spec.callouts.push({target:"record",text:"Written at landfall"});spec.layouts={narrow:{width:320,height:368,nodes:[{id:"hermes",at:[48,24],size:[224,64]},{id:"odysseus",at:[48,152],size:[224,64]},{id:"ledger",at:[48,280],size:[224,64]}]}};
 const model=diagramSvgModel(parseDiagram(JSON.stringify(spec)),"narrow");expect(model.tree.viewBox.width).toBe(320);expect(model.tree.viewBox.height).toBeGreaterThan(368);
 const notes=model.elements.filter(item=>item.attrs["data-diagram-callout"]!==undefined);expect(notes[0]!.attrs["data-placement"]).toBe("marker");expect(notes.length).toBe(2);
 expect(model.elements.findIndex(item=>item.attrs["data-diagram-notes-band"]!==undefined)).toBeLessThan(model.elements.findIndex(item=>item.attrs["data-diagram-legend"]!==undefined));
});
test("generated shape targets and accepted semantic-only targets preserve association",async()=>{
 for(const original of Object.values(axisExamples)){
  const spec={...structuredClone(original),size:"fit",callouts:[{target:original.nodes[0]!.id,text:"Prepare provisions"}]};const checked=checkDiagram(JSON.stringify(spec));expect(checked.valid,JSON.stringify(checked)).toBe(true);const svg=await toStatic(JSON.stringify(spec),{theme:"light"});expect(svg).toContain(`data-target="${original.nodes[0]!.id}"`);expect(svg).toContain("Prepare provisions");
 }
 const sequence={...axisExamples.sequence,size:"fit",edges:[{id:"word",from:"zeus",to:"hermes",label:"WORD"}],callouts:[{target:"word",text:"Prepare provisions"}]};expect(plan(sequence).placements[0]).toMatchObject({target:"word",name:"WORD"});
});
