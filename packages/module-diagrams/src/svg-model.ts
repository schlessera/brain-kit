import { parseDocument } from "yaml";
import { checkDiagram, diagramSource } from "./check.js";
import { diagramSpecSchema, type DiagramSpec } from "./spec.js";
import { buildDiagramLayout } from "./layout.js";
import { DIAGRAM_TYPE, diagramNodePaint, diagramEdgePaint, fitDiagramText, type DiagramTypeRole } from "./skin.js";
import type { DiagramTree, DiagramNode } from "./geometry.js";

/** Concrete internal SVG primitives shared by the two first-party entries. */
export interface SvgPrimitive { tag: "g" | "rect" | "path" | "text" | "line" | "circle"; attrs: Record<string, string | number>; text?: string; children?: SvgPrimitive[] }
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
 const tree=buildDiagramLayout(spec,layout), elements:SvgPrimitive[]=[primitive("rect",{class:"bk-diagram-screen-frame",x:0.5,y:0.5,width:tree.viewBox.width-1,height:tree.viewBox.height-1,rx:8,fill:"none",stroke:ink("color-line"),"stroke-width":1})];
 for (const element of tree.elements) {
  switch(element.kind) {
   case "group": elements.push(primitive("g",{"data-diagram-group":element.id},undefined,[primitive("rect",{x:element.x,y:element.y,width:element.width,height:element.height,rx:8,fill:ink("diagram-cluster"),stroke:ink("diagram-cluster-border"),"stroke-width":1}),text(element.label,"label",element.x+8,element.y+12,element.width-16,ink("color-ink-mute"))])); break;
   case "connector": {
    const paint=diagramEdgePaint(spec.edges[element.edge]!.kind,element.transit.length>0);
    elements.push(primitive("g",{"data-diagram-edge":element.edge,"data-from":element.from.node,"data-to":element.to.node},undefined,[primitive("path",{d:element.path,fill:"none",stroke:paint.stroke,"stroke-width":paint.width,"stroke-dasharray":paint.dash,"stroke-linecap":paint.linecap,"stroke-linejoin":"round"}),arrow(element.points,paint.head,paint.stroke,paint.width)]));break;
   }
   case "label-mask": { const within=tree.elements.some(group=>group.kind==="group"&&element.x>=group.x&&element.y>=group.y&&element.x+element.width<=group.x+group.width&&element.y+element.height<=group.y+group.height); elements.push(primitive("rect",{x:element.x,y:element.y,width:element.width,height:element.height,"data-edge-mask":element.edge,fill:ink(within?"diagram-cluster":"diagram-bg")}));break; }
   case "edge-label": elements.push(text(element.text,"label",element.x+4,element.y+element.height/2+3,element.width-8,diagramEdgePaint(spec.edges[element.edge]!.kind).stroke,{"data-edge-label":element.edge}));break;
   case "node": elements.push(primitive("g",{"data-diagram-node":element.id,"aria-label":[element.label,element.sub,element.tag ?? diagramNodePaint(element.role,element.focal).tag].filter(Boolean).join(", "),...(element.link ? {"data-wiki-link":element.link} : {})},undefined,nodeParts(element,spec)));break;
   default: { const exhaustive:never=element; throw Error(`Unknown diagram element: ${String(exhaustive)}`); }
  }
 }
 const kinds=[...new Set(spec.edges.map(edge=>edge.kind??"default"))];
 const legendY=tree.viewBox.height-12, cell=Math.min(128,(tree.viewBox.width-16)/Math.max(1,kinds.length));
 elements.push(primitive("line",{x1:8,y1:legendY-10,x2:tree.viewBox.width-8,y2:legendY-10,stroke:ink("color-line"),"stroke-width":1}));
 kinds.forEach((kind,index)=>{const paint=diagramEdgePaint(kind),x=8+index*cell;elements.push(primitive("path",{d:`M ${x} ${legendY} L ${x+20} ${legendY}`,fill:"none",stroke:paint.stroke,"stroke-width":paint.width,"stroke-dasharray":paint.dash,"stroke-linecap":paint.linecap}),arrow([{x,y:legendY},{x:x+20,y:legendY}],paint.head,paint.stroke,paint.width),text(kind,"label",x+28,legendY+3,cell-28,ink("color-ink-mute")));});
 const fonts:number[]=[]; const collect=(items:SvgPrimitive[])=>items.forEach(item=>{if(item.tag==="text")fonts.push(Number(item.attrs["font-size"]));if(item.children)collect(item.children);});collect(elements);
 return {tree,elements,minimumFont:Math.min(...fonts,9.5)};
}
export function escapeSvg(value: string | number): string { return String(value).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&apos;"); }
export function serializePrimitive(element: SvgPrimitive): string { return `<${element.tag}${Object.entries(element.attrs).map(([key,value])=>` ${key}="${escapeSvg(value)}"`).join("")}>${element.text === undefined ? "" : escapeSvg(element.text)}${element.children?.map(serializePrimitive).join("") ?? ""}</${element.tag}>`; }
