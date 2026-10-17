import { diagramLegend } from "./legend.js";
import { calloutKeyWidth, planCallouts } from "./callouts.js";
import { shapeSvg } from "./shape-svg.js";
import { nodeLinkSvg } from "./node-link-svg.js";
import { parseDocument } from "yaml";
import { checkDiagram, diagramSource } from "./check.js";
import { diagramSpecSchema, type DiagramSpec } from "./spec.js";
import { buildDiagramLayout } from "./layout.js";
import { DIAGRAM_TYPE, diagramNodeLines, diagramNodePaint, diagramEdgePaint, fitDiagramText, typeWidthBudget, type DiagramTypeRole } from "./skin.js";
import type { DiagramTree } from "./geometry.js";

/** Concrete internal SVG primitives shared by the two first-party entries. */
export interface SvgPrimitive { tag: "g" | "rect" | "path" | "text" | "line" | "circle" | "polygon"; attrs: Record<string, string | number>; text?: string; children?: SvgPrimitive[] }
export interface DiagramSvgModel { tree: DiagramTree; elements: SvgPrimitive[]; minimumFont: number }
const ink = (name: string) => `var(--bk-${name})`;
const primitive = (tag: SvgPrimitive["tag"], attrs: SvgPrimitive["attrs"], text?: string, children?: SvgPrimitive[]): SvgPrimitive => ({tag,attrs,text,children});
export function parseDiagram(source: string): DiagramSpec {
 const checked = checkDiagram(source);
 if (!checked.valid) throw Error(checked.errors.map(item => `${item.path}: ${item.message}`).join("; "));
 return diagramSpecSchema.parse(parseDocument(diagramSource(source), { version: "1.2", schema: "core" }).toJS({maxAliasCount:0}));
}
function text(value: string, role: DiagramTypeRole, x: number, y: number, width: number, fill: string, extra: SvgPrimitive["attrs"] = {}): SvgPrimitive {
 const style = DIAGRAM_TYPE[role];
 return primitive("text", {x,y,fill,"font-family":style.family,"font-size":fitDiagramText(value,role,width),"font-weight":style.weight,"letter-spacing":`${style.tracking}em`,...extra}, style.uppercase ? value.toUpperCase() : value);
}
function arrow(points: {x:number;y:number}[], head: "open" | "filled" | "hollow", stroke: string, width: number): SvgPrimitive {
 const tip = points.at(-1)!, before = points.at(-2)!, length = Math.hypot(tip.x-before.x,tip.y-before.y), dx=(tip.x-before.x)/length, dy=(tip.y-before.y)/length;
 const a={x:tip.x-dx*7-dy*4,y:tip.y-dy*7+dx*4}, b={x:tip.x-dx*7+dy*4,y:tip.y-dy*7-dx*4};
 return primitive("path", {d:`M ${a.x} ${a.y} L ${tip.x} ${tip.y} L ${b.x} ${b.y}${head === "open" ? "" : " Z"}`,fill:head === "filled" ? stroke : head === "hollow" ? ink("diagram-bg") : "none",stroke,"stroke-width":width,"stroke-linejoin":"round"});
}
/** All geometry is supplied by the builder. This maps it to paints and safe elements only. */
export function diagramSvgModel(spec: DiagramSpec, layout: "default" | "narrow" = "default"): DiagramSvgModel {
 const tree=buildDiagramLayout(spec,layout);
 const {kinds,columns,footerHeight}=diagramLegend(spec,tree);
 const contentBottom=Math.max(0,...tree.elements.map(element=>element.kind==="connector"?Math.max(...element.points.map(point=>point.y)):element.y+element.height));
 if(footerHeight && contentBottom+footerHeight+8>tree.viewBox.height){
  if(layout==="default" && spec.size==="fit" || layout==="narrow" && spec.callouts?.length) tree.viewBox={...tree.viewBox,height:Math.ceil((contentBottom+footerHeight+8)/4)*4};
  else throw Error("The selected canvas has no room for its readable legend footer; reserve footer space or use size: fit");
 }
 const callouts=planCallouts(spec,tree,footerHeight,layout==="narrow"||spec.size==="fit");
 if(callouts.errors.length)throw Error(callouts.errors.map(item=>item.message).join("; "));
 const ground=(box:{x:number;y:number;width:number;height:number})=>{
  const group=tree.elements.flatMap(item=>item.kind==="group"&&box.x>=item.x&&box.y>=item.y&&box.x+box.width<=item.x+item.width&&box.y+box.height<=item.y+item.height?[item]:[]).sort((a,b)=>a.width*a.height-b.width*b.height)[0];
  if(group?.kind==="group")return ink(group.scopeKind==="admin"?"diagram-bg":"diagram-cluster");
  return ink(tree.elements.some(item=>item.kind==="shape"&&item.paint==="zone"&&box.x<item.x+item.width&&box.x+box.width>item.x&&box.y<item.y+item.height&&box.y+box.height>item.y)?"diagram-cluster":"diagram-bg");
 };
 const elements:SvgPrimitive[]=[primitive("rect",{class:"bk-diagram-screen-frame",x:0.5,y:0.5,width:tree.viewBox.width-1,height:tree.viewBox.height-1,rx:8,fill:"none",stroke:ink("color-line"),"stroke-width":1})];
 const nodePartsById=new Map<string,Extract<(typeof tree.elements)[number],{kind:"shape"}>[]>(),drawnNodes=new Set<string>();
 for(const item of tree.elements)if(item.kind==="shape"&&item.nodeId){const parts=nodePartsById.get(item.nodeId)??[];parts.push(item);nodePartsById.set(item.nodeId,parts);}
 for (const element of tree.elements) {
  switch(element.kind) {
   case "shape": {
    const node=element.nodeId?spec.nodes.find(node=>node.id===element.nodeId):undefined;
    const drawing=shapeSvg(element);
    if(node){if(drawnNodes.has(node.id))break;drawnNodes.add(node.id);const parts=nodePartsById.get(node.id)!,anchor=parts.find(part=>part.shape!=="text")??element;
     elements.push(primitive("g",{"data-diagram-node":node.id,"aria-label":[node.label,node.sub].filter(Boolean).join(", "),...(node.link?{"data-wiki-link":node.link}:{})},undefined,[...parts.map(shapeSvg),primitive("rect",{class:"bk-diagram-node-focus",x:anchor.x-4,y:anchor.y-4,width:anchor.width+8,height:anchor.height+8,rx:9,fill:"none",stroke:ink("focus-ring"),"stroke-width":2})]));}
    else if(element.from || element.to) {
     const edge=spec.edges.findIndex(edge=>edge.id===element.edgeId&&edge.from===element.from&&edge.to===element.to);
     elements.push(primitive("g",{"data-from":element.from??"","data-to":element.to??"",...(edge>=0?{"data-diagram-edge":edge}:{})},undefined,[drawing]));
    }
    else elements.push(drawing); break;
   }

   case "group": {
    const scope=element.scopeKind,heading=text(element.label,"label",element.x+8,element.y+(scope==="admin"?16:3),element.width-16,ink("color-ink-mute")),headingWidth=typeWidthBudget(element.label,"label",Number(heading.attrs["font-size"]));
    elements.push(primitive("g",{"data-diagram-group":element.id},undefined,[primitive("rect",{x:element.x,y:element.y,width:element.width,height:element.height,rx:scope==="admin"?4:8,fill:ink(scope==="admin"?"diagram-bg":"diagram-cluster"),stroke:ink("diagram-cluster-border"),"stroke-width":1,"stroke-dasharray":scope==="admin"?"4 3":"",...(scope?{"data-role":"bounds","data-scope-id":element.id,"data-scope-kind":scope,...(element.parent?{"data-parent":element.parent}:{})}:{})}),
    ...(scope==="admin"?[primitive("rect",{x:element.x,y:element.y,width:element.width,height:24,rx:4,fill:ink("diagram-cluster"),"data-role":"header"}),primitive("line",{x1:element.x,y1:element.y+24,x2:element.x+element.width,y2:element.y+24,stroke:ink("diagram-cluster-border"),"stroke-width":1})]:[primitive("rect",{"data-group-heading-mask":"",x:element.x+4,y:element.y-7,width:headingWidth+8,height:14,fill:ink("diagram-cluster")})]),heading]));break;
   }
   case "connector": {
    const sourceEdge=spec.edges[element.edge]!;
    const cycle="cycle" in sourceEdge && sourceEdge.cycle;
    const basePaint=diagramEdgePaint(sourceEdge.kind,element.transit.length>0),paint=cycle?{...basePaint,stroke:ink("amber-ink"),dash:"6 4"}:basePaint;
    elements.push(primitive("g",{"data-diagram-edge":element.edge,"data-from":element.from.node,"data-to":element.to.node},undefined,[primitive("path",{d:element.path,...("peering" in sourceEdge&&sourceEdge.peering?{"data-peering":sourceEdge.id??`peering-${element.edge}`,"data-from":element.from.node,"data-to":element.to.node}:{}),fill:"none",stroke:paint.stroke,"stroke-width":paint.width,"stroke-dasharray":paint.dash,"stroke-linecap":paint.linecap,"stroke-linejoin":"round"}),...(spec.type==="er" || spec.type==="tree" ? [] : [arrow(element.points,paint.head,paint.stroke,paint.width)])]));break;
   }
   case "label-mask": elements.push(primitive("rect",{x:element.x,y:element.y,width:element.width,height:element.height,"data-edge-mask":element.edge,fill:ground(element)}));break;
   case "edge-label": {const edge=spec.edges[element.edge]!;elements.push(text(element.text,"label",element.x+4,element.y+element.height/2+3,element.width-8,"cycle" in edge&&edge.cycle?ink("amber-ink"):diagramEdgePaint(edge.kind).stroke,{"data-edge-label":element.edge}));break;}
   case "cardinality": elements.push(primitive("g",{"data-cardinality":`${element.edge}:${element.end}`},undefined,[primitive("rect",{x:element.x,y:element.y,width:element.width,height:element.height,fill:ground(element)}),text(element.text,"label",element.x+4,element.y+11,element.width-8,ink("diagram-text"))]));break;
   case "node": elements.push(primitive("g",{"data-diagram-node":element.id,...(element.nodeKind?{"data-node-id":element.id,"data-kind":element.nodeKind,...(element.parent?{"data-parent":element.parent}:{}),...(element.target?{"data-target":element.target}:{})}:{}),"aria-label":diagramNodeLines(element,spec.type).map(line=>line.value).join(", "),...(element.link ? {"data-wiki-link":element.link} : {})},undefined,nodeLinkSvg(element,spec)));break;
   default: { const exhaustive:never=element; throw Error(`Unknown diagram element: ${String(exhaustive)}`); }
  }
 }
 const pill=(number:number,box:{x:number;y:number;width:number;height:number}):SvgPrimitive[]=>[
  primitive("rect",{...box,rx:8,fill:ink("diagram-node"),stroke:ink("diagram-line"),"stroke-width":1}),
  text(String(number),"label",box.x+box.width/2,box.y+11,box.width-10,ink("diagram-text"),{"text-anchor":"middle"}),
 ];
 const noteText=(lines:string[],x:number,y:number,fill=ink("diagram-text"))=>lines.map((line,index)=>primitive("text",{x,y:y+11+index*14,fill,"font-family":DIAGRAM_TYPE.note.family,"font-size":11,"font-weight":500},line));
 for(const note of callouts.placements.filter(note=>note.placement!=="band")){
  elements.push(primitive("g",{"data-diagram-callout":note.index,"data-target":note.target,"data-placement":note.placement,"aria-label":`Note on ${note.name}: ${note.text}`},undefined,[
   primitive("line",{x1:note.anchor!.x,y1:note.anchor!.y,x2:note.end!.x,y2:note.end!.y,stroke:ink("diagram-line"),"stroke-width":1,"data-callout-leader":""}),
   primitive("circle",{cx:note.anchor!.x,cy:note.anchor!.y,r:2.5,fill:ink("diagram-text")}),...noteText(note.lines,note.box.x,note.box.y),
  ]));
 }
 for(const group of callouts.groups)if(group.cue&&group.key){
  elements.push(primitive("g",{"data-diagram-callout-key":group.key,"data-target":group.target,"aria-label":`${group.name}: ${group.indices.length} ${group.indices.length===1?"note":"notes"}, listed below the diagram as group ${group.key}`},undefined,pill(group.key,group.cue)));
 }
 if(callouts.bandHeight){
  const rows:SvgPrimitive[]=[primitive("line",{x1:16,y1:callouts.bandTop,x2:tree.viewBox.width-16,y2:callouts.bandTop,stroke:ink("color-line"),"stroke-width":1})];
  for(const group of callouts.groups){
   const children:SvgPrimitive[]=[];
   for(const header of group.headers){
    const keyWidth=group.key?calloutKeyWidth(group.key):0;
    if(group.key)children.push(primitive("g",{"data-callout-header-key":group.key},undefined,pill(group.key,{x:header.x,y:header.y,width:keyWidth,height:16})));
    children.push(primitive("g",{"data-callout-group-heading":"","data-column-width":header.width,"data-heading-offset":header.offset},undefined,header.lines.map((line,index)=>text(line,"label",header.x+header.offset,header.y+11+index*14,header.width-header.offset,ink("diagram-text")))));
    children.push(...noteText(header.explanation,header.x,header.y+header.lines.length*14+8,ink("color-ink-mute")));
   }
   for(const note of callouts.placements.filter(note=>note.placement==="band"&&note.target===group.target))children.push(primitive("g",{"data-diagram-callout":note.index,"data-diagram-callout-note":note.index,"data-target":note.target,"data-placement":"band","data-column":note.column!,"aria-label":`Note on ${note.name}: ${note.text}`},undefined,[
    text(String(note.index+1),"label",note.indexX!,note.box.y+11,Math.max(24,typeWidthBudget(String(spec.callouts?.length??0),"label")),ink("color-ink-mute"),{"text-anchor":"end","data-callout-index":""}),
    ...noteText(note.lines,note.box.x,note.box.y),
   ]));
   rows.push(primitive("g",{"data-diagram-callout-group":group.target,"data-key":group.key??"none","data-target-drawn":group.drawn},undefined,children));
  }
  elements.push(primitive("g",{"data-diagram-notes-band":"","data-columns":callouts.columns},undefined,rows));
 }
 for(const element of elements){
  const target=element.attrs["data-diagram-node"]??element.attrs["data-diagram-group"]??(element.attrs["data-diagram-edge"]!==undefined?spec.edges[Number(element.attrs["data-diagram-edge"])]?.id:undefined);
  const notes=callouts.placements.filter(note=>note.target===target);
  if(notes.length)element.attrs["aria-label"]=`${element.attrs["aria-label"]??notes[0]!.name}, ${notes.length} ${notes.length===1?"note":"notes"}`;
 }
 if(kinds.length){
  const footerTop=tree.viewBox.height-footerHeight, cell=(tree.viewBox.width-16)/columns;
  const legend:SvgPrimitive[]=[primitive("line",{x1:8,y1:footerTop+2,x2:tree.viewBox.width-8,y2:footerTop+2,stroke:ink("color-line"),"stroke-width":1})];
  kinds.forEach((kind,index)=>{const base=diagramEdgePaint(kind),paint=kind==="cycle"?{...base,stroke:ink("amber-ink"),dash:"6 4"}:base,x=8+(index%columns)*cell,y=footerTop+16+Math.floor(index/columns)*20;
   if(kind==="focal"||kind==="store"){const nodePaint=diagramNodePaint(kind==="focal"?"focal":"store");legend.push(primitive("rect",{x:x+3,y:y-5,width:14,height:10,rx:3,fill:nodePaint.fill,stroke:nodePaint.stroke,"stroke-width":nodePaint.strokeWidth}));if(kind==="store")legend.push(primitive("line",{x1:x+3,y1:y-2,x2:x+17,y2:y-2,stroke:nodePaint.stroke,"stroke-width":1}));}
   else legend.push(primitive("path",{d:`M ${x} ${y} L ${x+20} ${y}`,fill:"none",stroke:paint.stroke,"stroke-width":paint.width,"stroke-dasharray":paint.dash,"stroke-linecap":paint.linecap}),...(spec.type==="er"||spec.type==="tree"?[]:[arrow([{x,y},{x:x+20,y}],paint.head,paint.stroke,paint.width)]));
   const legendLabel=(spec.type==="loop"||spec.type==="flywheel")?(kind==="default"?"FLOW":kind==="return"?"WRITE-BACK":kind):kind;legend.push(text(legendLabel,"label",x+28,y+3,cell-28,ink("color-ink-mute"),{"data-legend-key":kind}));});
  elements.push(primitive("g",{"data-diagram-legend":"","data-footer-top":footerTop,"data-content-bottom":contentBottom},undefined,legend));
 }
 const fonts:number[]=[]; const collect=(items:SvgPrimitive[])=>items.forEach(item=>{if(item.tag==="text")fonts.push(Number(item.attrs["font-size"]));if(item.children)collect(item.children);});collect(elements);
 return {tree,elements,minimumFont:Math.min(...fonts,9.5)};
}
export function escapeSvg(value: string | number): string { return String(value).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&apos;"); }
export function serializePrimitive(element: SvgPrimitive): string { return `<${element.tag}${Object.entries(element.attrs).map(([key,value])=>` ${key}="${escapeSvg(value)}"`).join("")}>${element.text === undefined ? "" : escapeSvg(element.text)}${element.children?.map(serializePrimitive).join("") ?? ""}</${element.tag}>`; }
