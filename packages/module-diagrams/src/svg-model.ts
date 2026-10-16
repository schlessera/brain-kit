import { shapeSvg } from "./shape-svg.js";
import { parseDocument } from "yaml";
import { checkDiagram, diagramSource } from "./check.js";
import { diagramSpecSchema, type DiagramSpec } from "./spec.js";
import { buildDiagramLayout } from "./layout.js";
import { DIAGRAM_TYPE, diagramNodePaint, diagramEdgePaint, fitDiagramText, typeWidthBudget, type DiagramTypeRole } from "./skin.js";
import type { DiagramTree, DiagramNode } from "./geometry.js";

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
function nodeParts(node: DiagramNode, spec: DiagramSpec): SvgPrimitive[] {
 const inGroup=spec.groups?.some(group=>group.members.includes(node.id)) ?? false;
 const paint=diagramNodePaint(node.role,node.focal,inGroup), lines=[{value:node.tag ?? paint.tag,role:"label" as const,fill:node.focal ? ink("amber-ink") : ink("color-ink-mute")}, {value:node.label,role:"name" as const,fill:paint.text}, ...(node.sub ? [{value:node.sub,role:"sub" as const,fill:paint.sub}] : [])];
 const lineHeight=16, start=node.y+(node.height-lines.length*lineHeight)/2+12;
 return [primitive("rect",{x:node.x,y:node.y,width:node.width,height:node.height,rx:paint.radius,fill:paint.fill,stroke:paint.stroke,"stroke-width":paint.strokeWidth,"stroke-dasharray":paint.dash}),
 ...(node.role === "store" ? [primitive("line",{x1:node.x,y1:node.y+6,x2:node.x+node.width,y2:node.y+6,stroke:paint.stroke,"stroke-width":1})] : []),
 ...lines.map((line,index)=>text(line.value,line.role,node.x+8,start+index*lineHeight,node.width-16,line.fill)),
 primitive("rect",{class:"bk-diagram-node-focus",x:node.x-4,y:node.y-4,width:node.width+8,height:node.height+8,rx:9,fill:"none",stroke:ink("focus-ring"),"stroke-width":2})];
}
/** All geometry is supplied by the builder. This maps it to paints and safe elements only. */
export function diagramSvgModel(spec: DiagramSpec, layout: "default" | "narrow" = "default"): DiagramSvgModel {
 const tree=buildDiagramLayout(spec,layout);
 const positional=["quadrant","layer-stack","pyramid","funnel","loop","flywheel","venn"].includes(spec.type);
 const kinds=[...new Set([...spec.edges.map(edge=>edge.kind??"default"),...tree.elements.flatMap(item=>positional&&item.kind==="shape"&&(item.from||item.to)?[item.paint==="line"?"default":item.paint]:[])]), ...(tree.elements.some(item=>item.kind==="node"&&item.focal||positional&&item.kind==="shape"&&item.paint==="focal")?["focal"]:[]), ...(!positional&&spec.nodes.some(item=>item.role==="store")?["store"]:[])], columns=Math.max(1,Math.min(kinds.length||1,tree.viewBox.width<=320?2:Infinity,Math.floor((tree.viewBox.width-16)/Math.max(1,...kinds.map(kind=>typeWidthBudget(kind,"label")+44))))), rows=Math.ceil(kinds.length/columns), footerHeight=rows?rows*20+16:0;
 const contentBottom=Math.max(0,...tree.elements.map(element=>element.kind==="connector"?Math.max(...element.points.map(point=>point.y)):element.y+element.height));
 if(footerHeight && contentBottom+footerHeight+8>tree.viewBox.height){
  if(layout==="default" && spec.size==="fit") tree.viewBox={...tree.viewBox,height:Math.ceil((contentBottom+footerHeight+8)/4)*4};
  else throw Error("The selected canvas has no room for its readable legend footer; reserve footer space or use size: fit");
 }
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
    else if(element.from || element.to) elements.push(primitive("g",{"data-from":element.from??"","data-to":element.to??""},undefined,[drawing]));
    else elements.push(drawing); break;
   }

   case "group": { const heading=text(element.label,"label",element.x+8,element.y+3,element.width-16,ink("color-ink-mute")); const headingWidth=typeWidthBudget(element.label,"label",Number(heading.attrs["font-size"])); elements.push(primitive("g",{"data-diagram-group":element.id},undefined,[primitive("rect",{x:element.x,y:element.y,width:element.width,height:element.height,rx:8,fill:ink("diagram-cluster"),stroke:ink("diagram-cluster-border"),"stroke-width":1}),primitive("rect",{"data-group-heading-mask":"",x:element.x+4,y:element.y-7,width:headingWidth+8,height:14,fill:ink("diagram-cluster")}),heading])); break; }
   case "connector": {
    const paint=diagramEdgePaint(spec.edges[element.edge]!.kind,element.transit.length>0);
    elements.push(primitive("g",{"data-diagram-edge":element.edge,"data-from":element.from.node,"data-to":element.to.node},undefined,[primitive("path",{d:element.path,fill:"none",stroke:paint.stroke,"stroke-width":paint.width,"stroke-dasharray":paint.dash,"stroke-linecap":paint.linecap,"stroke-linejoin":"round"}),arrow(element.points,paint.head,paint.stroke,paint.width)]));break;
   }
   case "label-mask": { const within=tree.elements.some(group=>group.kind==="group"&&element.x>=group.x&&element.y>=group.y&&element.x+element.width<=group.x+group.width&&element.y+element.height<=group.y+group.height || group.kind==="shape"&&group.paint==="zone"&&element.x<group.x+group.width&&element.x+element.width>group.x&&element.y<group.y+group.height&&element.y+element.height>group.y); elements.push(primitive("rect",{x:element.x,y:element.y,width:element.width,height:element.height,"data-edge-mask":element.edge,fill:ink(within?"diagram-cluster":"diagram-bg")}));break; }
   case "edge-label": elements.push(text(element.text,"label",element.x+4,element.y+element.height/2+3,element.width-8,diagramEdgePaint(spec.edges[element.edge]!.kind).stroke,{"data-edge-label":element.edge}));break;
   case "node": elements.push(primitive("g",{"data-diagram-node":element.id,"aria-label":[element.label,element.sub,element.tag ?? diagramNodePaint(element.role,element.focal).tag].filter(Boolean).join(", "),...(element.link ? {"data-wiki-link":element.link} : {})},undefined,nodeParts(element,spec)));break;
   default: { const exhaustive:never=element; throw Error(`Unknown diagram element: ${String(exhaustive)}`); }
  }
 }
 if(kinds.length){
  const footerTop=tree.viewBox.height-footerHeight, cell=(tree.viewBox.width-16)/columns;
  const legend:SvgPrimitive[]=[primitive("line",{x1:8,y1:footerTop+2,x2:tree.viewBox.width-8,y2:footerTop+2,stroke:ink("color-line"),"stroke-width":1})];
  kinds.forEach((kind,index)=>{const paint=diagramEdgePaint(kind),x=8+(index%columns)*cell,y=footerTop+16+Math.floor(index/columns)*20;
   if(kind==="focal"||kind==="store"){const nodePaint=diagramNodePaint(kind==="focal"?"focal":"store");legend.push(primitive("rect",{x:x+3,y:y-5,width:14,height:10,rx:3,fill:nodePaint.fill,stroke:nodePaint.stroke,"stroke-width":nodePaint.strokeWidth}));if(kind==="store")legend.push(primitive("line",{x1:x+3,y1:y-2,x2:x+17,y2:y-2,stroke:nodePaint.stroke,"stroke-width":1}));}
   else legend.push(primitive("path",{d:`M ${x} ${y} L ${x+20} ${y}`,fill:"none",stroke:paint.stroke,"stroke-width":paint.width,"stroke-dasharray":paint.dash,"stroke-linecap":paint.linecap}),arrow([{x,y},{x:x+20,y}],paint.head,paint.stroke,paint.width));
   const legendLabel=(spec.type==="loop"||spec.type==="flywheel")?(kind==="default"?"FLOW":kind==="return"?"WRITE-BACK":kind):kind;legend.push(text(legendLabel,"label",x+28,y+3,cell-28,ink("color-ink-mute"),{"data-legend-key":kind}));});
  elements.push(primitive("g",{"data-diagram-legend":"","data-footer-top":footerTop,"data-content-bottom":contentBottom},undefined,legend));
 }
 const fonts:number[]=[]; const collect=(items:SvgPrimitive[])=>items.forEach(item=>{if(item.tag==="text")fonts.push(Number(item.attrs["font-size"]));if(item.children)collect(item.children);});collect(elements);
 return {tree,elements,minimumFont:Math.min(...fonts,9.5)};
}
export function escapeSvg(value: string | number): string { return String(value).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&apos;"); }
export function serializePrimitive(element: SvgPrimitive): string { return `<${element.tag}${Object.entries(element.attrs).map(([key,value])=>` ${key}="${escapeSvg(value)}"`).join("")}>${element.text === undefined ? "" : escapeSvg(element.text)}${element.children?.map(serializePrimitive).join("") ?? ""}</${element.tag}>`; }
