import { DIAGRAM_PALETTE,type DiagramTheme } from "./skin.js";
import { DIAGRAM_DRAWING_CSS } from "./drawing-style.js";
import { diagramSvgModel,parseDiagram,escapeSvg,type SvgPrimitive } from "./svg-model.js";
const themes=new Set(["light","dark","print"]);
/** Resolve only trusted generated paint/style values, never source text. */
export function flattenPaint(value:string,theme:DiagramTheme):string {
 const palette=DIAGRAM_PALETTE[theme];if(!palette)throw Error("Unknown diagram theme");
 let result=value.replace(/var\(--bk-([a-z0-9-]+)\)/g,(_all,name:string)=>{const color=palette[name];if(!color)throw Error(`Unknown generated paint role '${name}'`);return color;});
 result=result.replace(/color-mix\(in srgb,\s*(#[a-f0-9]{6})\s+(25|50|75|100)%,\s*(#[a-f0-9]{6})\s*\)/gi,(_all,a:string,percent:string,b:string)=>{const t=Number(percent)/100;return `rgb(${[1,3,5].map(i=>parseInt(a.slice(i,i+2),16)*t+parseInt(b.slice(i,i+2),16)*(1-t)).join(", ")})`;});
 if(result.includes("var("))throw Error("A generated paint could not be flattened");return result;
}
/** Self-contained chosen-theme SVG: no live theme tokens or external resources. */
export function toFlatSvg(source:string,theme:DiagramTheme):string {
 if(!themes.has(theme))throw Error("Unknown diagram theme");const spec=parseDiagram(source),model=diagramSvgModel(spec),{width,height}=model.tree.viewBox;
 const flat=(item:SvgPrimitive):SvgPrimitive=>({...item,attrs:Object.fromEntries(Object.entries(item.attrs).map(([key,value])=>[key,typeof value==="string"&&["fill","stroke","color"].includes(key)?flattenPaint(value,theme):value])),children:item.children?.map(flat)});
 const css=flattenPaint(DIAGRAM_DRAWING_CSS,theme);
 // Encode authored text deliberately; unresolved trusted paint already threw above.
 const text=(value:string|number)=>escapeSvg(value).replace(/var\(/g,"var&#40;");
 const serialize=(item:SvgPrimitive):string=>`<${item.tag}${Object.entries(item.attrs).map(([key,value])=>` ${key}="${text(value)}"`).join("")}>${item.text===undefined?"":text(item.text)}${item.children?.map(serialize).join("")??""}</${item.tag}>`;
 return `<svg xmlns="http://www.w3.org/2000/svg" class="bk-diagram" data-theme="${theme}" role="img" aria-label="${text(spec.title)}" aria-description="${text(spec.desc)}" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}"><title>${text(spec.title)}</title><desc>${text(spec.desc)}</desc><style>${css}</style>${model.elements.map(flat).map(serialize).join("")}</svg>`;
}
