import type { DiagramSpec } from "./spec.js";
import type { DiagramFinding } from "./check.js";
/** Type grammar constraints and editorial budgets; limits never discard content. */
export function checkNodeLink(spec:DiagramSpec):{errors:DiagramFinding[];warnings:DiagramFinding[]}{
 const errors:DiagramFinding[]=[],warnings:DiagramFinding[]=[];
 const error=(path:string,code:string,message:string)=>errors.push({path,code,message});
 const warn=(path:string,count:number,limit:number,noun:string)=>{if(count>limit)warnings.push({path,code:"budget",message:`${count} ${noun} exceeds the ${limit} default budget; split into overview and detail`});};
 switch(spec.type){
  case "architecture":warn("$.groups",spec.groups?.length??0,3,"architecture zones");break;
  case "flowchart":spec.nodes.forEach((node,index)=>{
   if(node.shape==="merge"&&(node.size[0]!==8||node.size[1]!==8))error(`$.nodes[${index}].size`,"marker_size","A merge dot requires its exact 8px boundary box");
   if(node.shape!=="decision")return;
   const exits=spec.edges.filter(edge=>edge.from===node.id);warn(`$.nodes[${index}]`,exits.length,3,"decision exits");
   exits.forEach(edge=>{if(!edge.label)error(`$.edges[${spec.edges.indexOf(edge)}].label`,"decision_label","Every decision exit needs an explicit outcome label");});
  });break;
  case "state-machine":
   warn("$.edges",spec.edges.length,spec.nodes.filter(node=>node.shape!=="initial"&&node.shape!=="final").length*2,"state transitions");
   spec.edges.forEach((edge,index)=>{const source=spec.nodes.find(node=>node.id===edge.from);if(source?.shape!=="initial"&&!edge.label)warnings.push({path:`$.edges[${index}].label`,code:"state_label",message:"Name the transition event, with optional [guard] / action"});});
   spec.nodes.forEach((node,index)=>{const diameter=node.shape==="initial"?12:node.shape==="final"?16:undefined;if(diameter&&(node.size[0]!==diameter||node.size[1]!==diameter))error(`$.nodes[${index}].size`,"marker_size","Initial/final markers require their exact diameter boundary box");if(node.shape==="initial"&&spec.edges.some(edge=>edge.to===node.id))error(`$.nodes[${index}]`,"initial_incoming","An initial marker cannot receive a transition");if(node.shape==="final"&&spec.edges.some(edge=>edge.from===node.id))error(`$.nodes[${index}]`,"final_outgoing","A final marker cannot emit a transition");});break;
  case "tree":spec.nodes.forEach((node,index)=>{
   if(spec.edges.filter(edge=>edge.to===node.id).length>1){const message="A tree node has at most one parent; use dependency for shared children";if(spec.hierarchy)error(`$.nodes[${index}]`,"tree_parent",message);else warnings.push({path:`$.nodes[${index}]`,code:"tree_parent",message});}
  });
   if(spec.hierarchy||spec.direction)spec.edges.forEach((edge,index)=>{const from=spec.nodes.find(node=>node.id===edge.from),to=spec.nodes.find(node=>node.id===edge.to);if(!from||!to)return;const axis=spec.direction==="right"?0:1;if(to.at[axis]<from.at[axis]+from.size[axis])error(`$.edges[${index}]`,"tree_direction","Author every child beyond its parent in the declared hierarchy direction");});
   break;
  case "er":spec.edges.forEach((edge,index)=>{if(Boolean(edge.fromCardinality)!==Boolean(edge.toCardinality))error(`$.edges[${index}]`,"cardinality_pair","Declare cardinality at both ends of a relationship");});break;
  case "dependency":{
   if(spec.nodes.some(node=>node.rank===undefined))warnings.push({path:"$.nodes",code:"rank_missing",message:"Dependency ranks are not fully declared; author rank on every node before claiming a ranked layout"});
   const ranks=new Set(spec.nodes.flatMap(node=>node.rank===undefined?[]:[node.rank])),cycles=spec.edges.filter(edge=>edge.cycle);
   const ordered=[...ranks].sort((a,b)=>a-b);
   ordered.forEach((rank,index)=>{const rows=spec.nodes.filter(node=>node.rank===rank).map(node=>node.at[1]);if(new Set(rows).size>1)warnings.push({path:"$.nodes",code:"rank_alignment",message:`Rank ${rank} nodes do not share one horizontal row; align the authored placements`});if(index){const previous=spec.nodes.filter(node=>node.rank===ordered[index-1]).map(node=>node.at[1]);if(Math.min(...rows)-Math.max(...previous)<120)warnings.push({path:"$.nodes",code:"rank_spacing",message:"Dependency rank rows have less than the 120px spacing guidance; separate them for readable routes"});}});
   warn("$.nodes",ranks.size,4,"dependency ranks");warn("$.edges",cycles.length,1,"highlighted cycles");
   spec.edges.forEach((edge,index)=>{const from=spec.nodes.find(node=>node.id===edge.from),to=spec.nodes.find(node=>node.id===edge.to);if(from?.rank!==undefined&&to?.rank!==undefined&&from.rank>to.rank&&!edge.cycle)error(`$.edges[${index}]`,"dependency_rank","An upward dependency must be explicitly marked cycle: true");if(edge.cycle&&!edge.label)error(`$.edges[${index}].label`,"cycle_label","Name the highlighted cycle, for example CYCLE");});
   if(cycles.length&&(spec.focal?.length||spec.nodes.some(node=>node.role==="focal")))warnings.push({path:"$.focal",code:"accent_budget",message:"The highlighted cycle uses the accent budget; remove focal node accents"});
   const incoming=new Map(spec.nodes.map(node=>[node.id,0])),children=new Map<string,string[]>();for(const edge of spec.edges)if(incoming.has(edge.from)&&incoming.has(edge.to)){incoming.set(edge.to,incoming.get(edge.to)!+1);children.set(edge.from,[...(children.get(edge.from)??[]),edge.to]);}const queue=[...incoming].filter(([,count])=>count===0).map(([id])=>id);for(let position=0;position<queue.length;position++)for(const child of children.get(queue[position]!)??[]){incoming.set(child,incoming.get(child)!-1);if(incoming.get(child)===0)queue.push(child);}const cyclic=queue.length!==spec.nodes.length;
   if(cyclic&&!cycles.length)warnings.push({path:"$.edges",code:"unmarked_cycle",message:"The dependency graph contains a cycle; mark its editorial back-edge explicitly"});
   if(ranks.size&&spec.edges.length&&!cycles.length&&!cyclic&&spec.nodes.every(node=>spec.edges.filter(edge=>edge.to===node.id).length<=1))warnings.push({path:"$.type",code:"prefer_tree",message:"This dependency graph has no shared children or highlighted cycles; consider tree"});
   spec.nodes.forEach((node,index)=>{if(node.rank!==undefined&&spec.nodes.some(other=>other.rank!==undefined&&other.rank<node.rank!&&other.at[1]>node.at[1]))error(`$.nodes[${index}].at`,"dependency_rank","Place deeper dependency ranks below earlier ranks");});
   break;
  }
 }
 return{errors,warnings};
}
