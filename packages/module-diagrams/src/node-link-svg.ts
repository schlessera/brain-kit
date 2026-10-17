import type { DiagramNode } from "./geometry.js";
import type { DiagramSpec } from "./spec.js";
import type { SvgPrimitive } from "./svg-model.js";
import { DIAGRAM_TYPE, diagramNodeLines, diagramNodePaint, fitDiagramText, typeWidthBudget } from "./skin.js";
const ink=(name:string)=>`var(--bk-${name})`;
const primitive=(tag:SvgPrimitive["tag"],attrs:SvgPrimitive["attrs"],text?:string):SvgPrimitive=>({tag,attrs,text});
/** Concrete node grammar. Coordinates are authored and never inferred from SVG input. */
export function nodeLinkSvg(node:DiagramNode,spec:DiagramSpec):SvgPrimitive[]{
 const paint=diagramNodePaint(node.role,node.focal,(spec.groups?.some(group=>group.members.includes(node.id)) || Boolean(node.parent))),shape=node.shape;
 const leaf=spec.type==="dependency"&&!spec.edges.some(edge=>edge.from===node.id&&!("cycle" in edge&&edge.cycle));
 const attrs={fill:leaf&&node.role!=="external"?ink("diagram-cluster"):paint.fill,stroke:paint.stroke,"stroke-width":paint.strokeWidth,"stroke-dasharray":paint.dash,...(node.nodeKind?{"data-role":"bounds"}:{}),"data-node-shape":shape ?? (spec.type==="er"?"entity":"box")};
 let outline:SvgPrimitive;
 if(shape==="decision") outline=primitive("path",{...attrs,d:`M ${node.x+node.width/2} ${node.y} L ${node.x+node.width} ${node.y+node.height/2} L ${node.x+node.width/2} ${node.y+node.height} L ${node.x} ${node.y+node.height/2} Z`});
 else if(shape==="initial"||shape==="final"||shape==="merge"){
  const radius=shape==="initial"?6:shape==="final"?8:4,cx=node.x+node.width/2,cy=node.y+node.height/2;
  outline=primitive("circle",{...attrs,cx,cy,r:radius,fill:shape==="final"?ink("diagram-bg"):ink("diagram-text"),stroke:ink("diagram-text")});
  return [outline,...(shape==="final"?[primitive("circle",{cx,cy,r:5,fill:ink("diagram-text")})]:[]),primitive("rect",{class:"bk-diagram-node-focus",x:node.x-4,y:node.y-4,width:node.width+8,height:node.height+8,rx:9,fill:"none",stroke:ink("focus-ring"),"stroke-width":2})];
 }else outline=primitive("rect",{...attrs,x:node.x,y:node.y,width:node.width,height:node.height,rx:shape==="start"||shape==="end"?node.height/2:shape==="state"?8:paint.radius});
 const lines=diagramNodeLines(node,spec.type),lineHeight=Math.max(12,Math.min(16,(node.height-16)/Math.max(lines.length,1))),start=node.y+(node.height-lines.length*lineHeight)/2+lineHeight*.75;
 const inset=shape==="decision"?node.width/4+8:8,width=shape==="decision"?node.width/2-16:node.width-16;
 const children=[outline,...(node.role==="store"?[primitive("line",{x1:node.x,y1:node.y+6,x2:node.x+node.width,y2:node.y+6,stroke:paint.stroke,"stroke-width":1})]:[])];
 if(spec.type==="er" && node.fields?.length) children.push(primitive("line",{x1:node.x,y1:start+lineHeight+5,x2:node.x+node.width,y2:start+lineHeight+5,stroke:paint.stroke,"stroke-width":1}));
 lines.forEach((line,index)=>{const style=DIAGRAM_TYPE[line.role],badge=spec.type==="dependency"&&index===0,badgeWidth=badge?typeWidthBudget(line.value,"label")+8:0;
 if(badge)children.push(primitive("rect",{"data-fan-in":node.fanIn!,x:node.x+node.width-8-badgeWidth,y:node.y+6,width:badgeWidth,height:16,rx:3,fill:ink("diagram-cluster"),stroke:paint.stroke,"stroke-width":1}));
 children.push(primitive("text",{x:badge?node.x+node.width-12-badgeWidth+8:node.x+inset,y:badge?node.y+17:start+index*lineHeight,fill:line.role==="name"?paint.text:line.role==="label"&&node.focal?ink("amber-ink"):paint.sub,"font-family":style.family,"font-size":fitDiagramText(line.value,line.role,width),"font-weight":style.weight,"letter-spacing":`${style.tracking}em`},style.uppercase?line.value.toUpperCase():line.value));});
 children.push(primitive("rect",{class:"bk-diagram-node-focus",x:node.x-4,y:node.y-4,width:node.width+8,height:node.height+8,rx:9,fill:"none",stroke:ink("focus-ring"),"stroke-width":2}));
 return children;
}
