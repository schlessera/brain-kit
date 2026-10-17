import type { DiagramShape } from "./shape.js";
import type { SvgPrimitive } from "./svg-model.js";
import { DIAGRAM_TYPE, diagramEdgePaint, typeWidthBudget } from "./skin.js";
const ink = (name: string) => `var(--bk-${name})`;
/** The only adapter from closed generated shapes to concrete SVG attributes. */
export function shapeSvg(shape: DiagramShape): SvgPrimitive {
 const edge = diagramEdgePaint(shape.paint), paints = {
  line: ["none", ink("diagram-line")], primary: ["none", ink("diagram-text")], link: ["none", ink("blue-ink")], async: ["none", ink("diagram-line")], return: ["none", ink("diagram-line")],
  node: [ink("diagram-node"), ink("diagram-line")], focal: [ink("diagram-focal-tint"), ink("amber-ink")], cluster: [ink("diagram-cluster"), ink("diagram-cluster-border")],
  "cluster-mask": [ink("diagram-cluster"), "none"],
  lifeline: ["none", ink("diagram-cluster-border")], bar: [ink("diagram-node"), ink("diagram-cluster-border")], zone: [ink("diagram-cluster"), ink("diagram-cluster-border")], mask: [ink("diagram-bg"), "none"], "focal-mask": [ink("diagram-focal-tint"), "none"], message: ["none", ink("diagram-line")],
  text: [ink("diagram-text"), "none"], muted: [ink("color-ink-mute"), "none"], accent: [ink("amber-ink"), "none"], ink: [ink("diagram-text"), ink("diagram-text")], "on-ink": [ink("diagram-bg"), "none"], none: ["none", "none"],
 } as const;
 const [fill, stroke] = paints[shape.paint], attrs: SvgPrimitive["attrs"] = {fill, stroke, "stroke-width":shape.strokeWidth ?? (shape.paint === "focal" ? 2 : edge.width), "stroke-dasharray":edge.dash, "stroke-linecap":edge.linecap, "stroke-linejoin":"round"};
 let result: SvgPrimitive;
 switch (shape.shape) {
  case "line": result={tag:"line",attrs:{...attrs,x1:shape.x1,y1:shape.y1,x2:shape.x2,y2:shape.y2}}; break;
  case "rect": result={tag:"rect",attrs:{...attrs,x:shape.x,y:shape.y,width:shape.width,height:shape.height,rx:shape.radius ?? 5}}; break;
  case "circle": result={tag:"circle",attrs:{...attrs,cx:shape.cx,cy:shape.cy,r:shape.radius}}; break;
  case "polygon": result={tag:"polygon",attrs:{...attrs,points:shape.points.map(point=>`${point.x},${point.y}`).join(" ")}}; break;
  case "path": result={tag:"path",attrs:{...attrs,fill:shape.paint==="focal"?"none":fill,d:shape.d}}; break;
  case "text": {
   const role=shape.textRole==="note"?"name":shape.textRole, style=DIAGRAM_TYPE[role], normal=shape.fontSize ?? (shape.textRole==="note"?11:style.size), fitted=Math.min(normal, normal*shape.width/Math.max(1,typeWidthBudget(shape.text,role,normal)));
   if(fitted<9 || typeWidthBudget(shape.text,role,fitted)>shape.width+0.001) throw Error("Generated text cannot fit at the 9px floor");
   const align=shape.align ?? "start";
   result={tag:"text",attrs:{...attrs,x:shape.x+(align==="middle"?shape.width/2:align==="end"?shape.width:0),y:shape.y+shape.height/2+3,"text-anchor":align,"font-family":style.family,"font-size":fitted,"font-weight":shape.fontWeight ?? (shape.textRole==="note"?500:style.weight),"letter-spacing":`${style.tracking}em`},text:style.uppercase?shape.text.toUpperCase():shape.text}; break;
  }
 }
 if(shape.name) result.attrs[shape.family==="axis"?"data-axis":"data-positional"] = shape.name;
 result.attrs["data-diagram-shape"]=shape.id;
 if(!shape.arrow) return result;
 const {x,y,dx,dy,head}=shape.arrow, a={x:x-dx*7-dy*4,y:y-dy*7+dx*4}, b={x:x-dx*7+dy*4,y:y-dy*7-dx*4};
 return {tag:"g",attrs:{"data-diagram-shape":shape.id},children:[result,{tag:"path",attrs:{d:`M ${a.x} ${a.y} L ${x} ${y} L ${b.x} ${b.y}${head==="open"?"":" Z"}`,fill:head==="filled"?stroke:head==="hollow"?ink("diagram-bg"):"none",stroke,"stroke-width":shape.strokeWidth ?? (shape.paint==="focal"?2:edge.width)}}]};
}
