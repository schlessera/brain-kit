import type { DiagramSpec } from "./spec.js";
import type { DiagramTree } from "./geometry.js";
import { typeWidthBudget } from "./skin.js";
export function diagramLegend(spec:DiagramSpec,tree:DiagramTree){
 const positional=["quadrant","layer-stack","pyramid","funnel","loop","flywheel","venn"].includes(spec.type);
 const kinds=[...new Set([...(positional?[]:spec.edges.map(edge=>"cycle" in edge&&edge.cycle?"cycle":edge.kind??"default")),...tree.elements.flatMap(item=>positional&&item.kind==="shape"&&(item.from||item.to)?[item.paint==="line"?"default":item.paint]:[])]), ...(tree.elements.some(item=>item.kind==="node"&&item.focal||positional&&item.kind==="shape"&&item.paint==="focal")?["focal"]:[]), ...(!positional&&spec.nodes.some(item=>item.role==="store")?["store"]:[])], columns=Math.max(1,Math.min(kinds.length||1,tree.viewBox.width<=320?2:Infinity,Math.floor((tree.viewBox.width-16)/Math.max(1,...kinds.map(kind=>typeWidthBudget(kind,"label")+44))))), rows=Math.ceil(kinds.length/columns), footerHeight=rows?rows*20+16:0;
 return {kinds,columns,footerHeight};
}
