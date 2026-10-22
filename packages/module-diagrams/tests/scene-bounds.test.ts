import { assertSixRules } from "./geometry-assertions.js";
import { expect, test } from "bun:test";
import { buildDiagram } from "../src/geometry.js";
import { checkDiagram } from "../src/check.js";
import { diagramSpecSchema } from "../src/spec.js";
import { buildDiagramLayout } from "../src/layout.js";
import { diagramSvgModel } from "../src/svg-model.js";
import { toStatic } from "../src/render.js";

import { originGroup } from "./fixtures/origin-group.js";
import { toFlatSvg } from "../src/flatten.js";
function assertScene(input: unknown) {
 const spec=diagramSpecSchema.parse(input), tree=buildDiagram(spec), frame=tree.viewBox;
 for(const element of tree.elements) if(element.kind!=="connector") {
  const border=element.kind==="group"?.5:0;
  const top=element.y-(element.kind==="group"&&element.scopeKind!=="admin"?7:border);
  expect(element.x-border,"ALL_SCENE_LEFT").toBeGreaterThanOrEqual(frame.x);
  expect(top,"ALL_SCENE_HEADING_TOP").toBeGreaterThanOrEqual(frame.y);
  expect(element.x+element.width+border,"ALL_SCENE_RIGHT").toBeLessThanOrEqual(frame.x+frame.width);
  expect(element.y+element.height+border,"ALL_SCENE_BOTTOM").toBeLessThanOrEqual(frame.y+frame.height);
 }
 expect(tree.elements.find(e=>e.kind==="node"&&e.id==="raft")).toMatchObject({x:0,y:0,width:148,height:64});
 expect(tree.elements.filter(e=>e.kind==="group")).toHaveLength(spec.groups!.length);
 expect(buildDiagram(spec)).toEqual(tree);
}
test("exact accepted origin group and heading fit without moving nodes",()=>{expect(checkDiagram(JSON.stringify(originGroup)).valid).toBe(true);assertScene(originGroup);});
test("fit encloses groups at opposite scene extents",()=>assertScene({...originGroup,nodes:[...originGroup.nodes,{id:"ithaca",label:"Ithaca",at:[600,400],size:[148,64]}],groups:[...originGroup.groups,{id:"home",label:"HOME",members:["ithaca"]}]}));
test("fixed frame rejects clipped group and clipped heading with named bounds finding",()=>{
 for(const at of [[0,0],[20,20],[812,536]]) {
  const result=checkDiagram(JSON.stringify({...originGroup,size:"doc-inline",nodes:[{...originGroup.nodes[0],at}]}));
  expect(result.errors,"FIXED_GROUP_BOUNDS").toContainEqual(expect.objectContaining({path:"$.groups[0]",code:"scene_bounds"}));
 }
 expect(checkDiagram(JSON.stringify({...originGroup,size:"doc-inline",nodes:[{...originGroup.nodes[0],at:[24,24]}]})).valid).toBe(true);
});
test("narrow frame rejects heading above origin and accepts complete group",()=>{
 for(const y of [16,24]) {
  const input={...originGroup,nodes:[{...originGroup.nodes[0],at:[24,24]}],layouts:{narrow:{width:320,height:200,nodes:[{id:"raft",at:[24,y],size:[148,64]}]}}};
  const result=checkDiagram(JSON.stringify(input));
  if(y===16)expect(result.errors,"NARROW_HEADING_BOUNDS").toContainEqual(expect.objectContaining({path:"$.layouts.narrow",code:"layout"}));
  else expect(buildDiagramLayout(diagramSpecSchema.parse(input),"narrow").viewBox).toEqual({x:0,y:0,width:320,height:200});
 }
});
test("static consumes nonzero origin; frame, footer and callouts remain inside",async()=>{
 const spec=diagramSpecSchema.parse({...originGroup,focal:["raft"],callouts:[{target:"crew",text:"Keep the crew together."},{target:"crew",text:"Prepare the raft."}]}),model=diagramSvgModel(spec),frame=model.tree.viewBox;
 const svg=await toStatic(JSON.stringify(spec),{theme:"light"});
 expect(svg).toContain(`viewBox="${frame.x} ${frame.y} ${frame.width} ${frame.height}"`);
 expect(toFlatSvg(JSON.stringify(spec),"light")).toContain(`viewBox="${frame.x} ${frame.y} ${frame.width} ${frame.height}"`);
 const screen=model.elements.find(e=>e.attrs.class==="bk-diagram-screen-frame")!;expect(screen.attrs.x).toBe(frame.x+.5);expect(screen.attrs.y).toBe(frame.y+.5);
 const footer=model.elements.find(e=>e.attrs["data-diagram-legend"]!==undefined)!;expect(Number(footer.attrs["data-footer-top"])).toBeLessThan(frame.y+frame.height);
});

test("connector rules retain real canvas coordinates with a negative origin",()=>{
 const spec=diagramSpecSchema.parse({...originGroup,nodes:[...originGroup.nodes,{id:"ithaca",label:"Ithaca",at:[400,80],size:[148,64]}],edges:[{from:"crew",to:"ithaca",label:"WORD"}]});
 const tree=buildDiagram(spec);expect(tree.viewBox.x).toBeLessThan(0);assertSixRules(spec,tree);
});

test("authored scope borders participate in fit and fixed frame checks",async()=>{
 const input=JSON.parse(await Bun.file(new URL("../skills/diagram/references/examples/architecture-containment.diagram.yaml",import.meta.url)).text());
 input.edges=[];input.containment.scopes[0].at=[0,0];input.containment.scopes[0].size=[824,424];
 const spec=diagramSpecSchema.parse(input),tree=buildDiagram(spec);
 expect(checkDiagram(JSON.stringify(input)).valid).toBe(true);
 expect(tree.viewBox.x,"SCOPE_BORDER_LEFT").toBeLessThanOrEqual(-.5);
 expect(tree.viewBox.y,"SCOPE_BORDER_TOP").toBeLessThanOrEqual(-.5);
 expect(checkDiagram(JSON.stringify({...input,size:"doc-inline"})).errors).toContainEqual(expect.objectContaining({path:"$.containment.scopes[0]",code:"scene_bounds"}));
});
