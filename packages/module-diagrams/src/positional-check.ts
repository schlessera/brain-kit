import type { DiagramSpec } from "./spec.js";
import { buildPositionalDiagram } from "./positional-layout.js";
export interface PositionalFinding { path:string; code:"positional"|"budget"; message:string }
export function checkPositional(spec:DiagramSpec):{errors:PositionalFinding[];warnings:PositionalFinding[]} {
 const errors:PositionalFinding[]=[],warnings:PositionalFinding[]=[];
 if(!["quadrant","layer-stack","pyramid","funnel","loop","flywheel","venn"].includes(spec.type))return{errors,warnings};
 const s=spec as Extract<DiagramSpec,{type:"quadrant"|"layer-stack"|"pyramid"|"funnel"|"loop"|"flywheel"|"venn"}>,data=s.positional,ids=new Set(spec.nodes.map(node=>node.id));
 const error=(path:string,message:string)=>errors.push({path,code:"positional",message});
 const budget=(path:string,count:number,min:number,max:number,noun:string)=>{if(count<min||count>max)warnings.push({path,code:"budget",message:`${count} ${noun} is outside the ${min}–${max} editorial budget; split into overview and detail`});};
 const allowed=({quadrant:"quadrant","layer-stack":"stack",pyramid:"pyramid",funnel:"pyramid",loop:"loop",flywheel:"loop",venn:"venn"} as const)[s.type];
 for(const key of Object.keys(data??{}))if(key!==allowed)error(`$.positional.${key}`,`'${key}' does not belong to ${s.type}`);
 const cover=(list:string[],path:string)=>{const seen=new Set<string>();for(const id of list){if(!ids.has(id)||seen.has(id))error(path,`Unknown or duplicate semantic node '${id}'`);seen.add(id);}for(const id of ids)if(!seen.has(id))error(path,`Missing semantic node '${id}'`);};
 if(s.type==="quadrant"){
  budget("$.nodes",spec.nodes.length,0,12,"quadrant items");
  if(data?.quadrant){cover(data.quadrant.points.map(p=>p.node),"$.positional.quadrant.points");for(const [i,p]of data.quadrant.points.entries())if(p.x===0||p.y===0)error(`$.positional.quadrant.points[${i}]`,"An item cannot lie ambiguously on an axis");for(const [key,a]of Object.entries({xAxis:data.quadrant.xAxis,yAxis:data.quadrant.yAxis}))for(const [end,label]of Object.entries(a))if(!/^[\p{L}\p{N}-]+$/u.test(label))error(`$.positional.quadrant.${key}.${end}`,"Axis tips use one word without arrow glyphs or parentheticals");}
 } else if(s.type==="layer-stack"){
  budget("$.nodes",spec.nodes.length,4,6,"layers");if(data?.stack?.order)cover(data.stack.order,"$.positional.stack.order");
 } else if(s.type==="pyramid"||s.type==="funnel"){
  budget("$.nodes",spec.nodes.length,4,6,`${s.type} layers`);
  if(data?.pyramid){const layers=data.pyramid.layers;cover(layers.map(l=>l.node),"$.positional.pyramid.layers");const numeric=layers.filter(l=>l.value!==undefined);if(numeric.length&&numeric.length!==layers.length)error("$.positional.pyramid.layers","Quantitative layers must all supply a value");if(numeric.length)for(let i=1;i<layers.length;i++)if(s.type==="funnel"?layers[i]!.value!>layers[i-1]!.value!:layers[i]!.value!<layers[i-1]!.value!)error(`$.positional.pyramid.layers[${i}].value`,"Values must follow the selected narrowing orientation");}
 } else if(s.type==="loop"||s.type==="flywheel"){
  const loop=data?.loop,stations=loop?.stations??spec.nodes.slice(1).map(n=>n.id);budget("$.positional.loop.stations",stations.length,5,8,"loop stations");
  if(loop){cover([loop.hub,...stations],"$.positional.loop");for(const [i,label]of(loop.spokeLabels??[]).entries())if(!stations.includes(label.station))error(`$.positional.loop.spokeLabels[${i}].station`,"Spoke labels reference a station");if(stations.filter(id=>spec.nodes.find(n=>n.id===id)?.role==="focal"||spec.focal?.includes(id)).length>1)error("$.focal","A loop has at most one focal station");}
 } else if(s.type==="venn"){
  const venn=data?.venn,sets=venn?.sets??spec.nodes.map(node=>({node:node.id}));
  if(spec.nodes.some(node=>node.role==="focal"||spec.focal?.includes(node.id)))warnings.push({path:"$.focal",code:"positional",message:"Venn focal set IDs do not identify an intersection; use positional.venn.intersections[].focal for one focal region"});budget("$.nodes",sets.length,2,3,"Venn sets");if(venn){cover(sets.map(s=>s.node),"$.positional.venn.sets");const setIds=new Set(sets.map(s=>s.node));for(const [i,region]of(venn.intersections??[]).entries())if(new Set(region.members).size!==region.members.length||region.members.some(id=>!setIds.has(id)))error(`$.positional.venn.intersections[${i}].members`,"Intersection members must be distinct declared sets");if((venn.intersections??[]).filter(r=>r.focal).length>1)error("$.positional.venn.intersections","Use at most one focal intersection");}
 }
 if(data&&!errors.length)try{buildPositionalDiagram(spec);}catch(failure){error("$.positional",(failure as Error).message);}
 return{errors,warnings};
}
