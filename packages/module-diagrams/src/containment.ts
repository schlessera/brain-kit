import type { DiagramSpec } from "./spec.js";
import type { DiagramFinding } from "./check.js";
import { typeWidthBudget } from "./skin.js";
type Architecture=Extract<DiagramSpec,{type:"architecture"}>;
/** Authored bounds are authoritative; containment is checked, never rearranged. */
export function checkContainment(spec:Architecture):{errors:DiagramFinding[];warnings:DiagramFinding[]}{
 const errors:DiagramFinding[]=[],warnings:DiagramFinding[]=[];
 if(!spec.containment)return{errors,warnings};
 const scopes=spec.containment.scopes, scopeIds=new Map(scopes.map(scope=>[scope.id,scope]));
 const error=(path:string,message:string)=>errors.push({path,code:"containment",message});
 const warn=(path:string,count:number,limit:number,noun:string)=>{if(count>limit)warnings.push({path,code:"budget",message:`${count} ${noun} exceeds the ${limit} default budget; split into overview and detail`});};
 const contains=(a:{at:[number,number];size:[number,number]},b:{at:[number,number];size:[number,number]})=>b.at[0]>=a.at[0]&&b.at[1]>=a.at[1]&&b.at[0]+b.size[0]<=a.at[0]+a.size[0]&&b.at[1]+b.size[1]<=a.at[1]+a.size[1];
 const area=(scope:typeof scopes[number])=>scope.size[0]*scope.size[1];
 const innermost=(box:{at:[number,number];size:[number,number]},omit?:string)=>scopes.filter(scope=>scope.id!==omit&&contains(scope,box)).sort((a,b)=>area(a)-area(b))[0];
 const overlap=(a:typeof scopes[number],b:typeof scopes[number])=>a.at[0]<b.at[0]+b.size[0]&&a.at[0]+a.size[0]>b.at[0]&&a.at[1]<b.at[1]+b.size[1]&&a.at[1]+a.size[1]>b.at[1];
 if(!scopes.some(scope=>scope.kind==="admin")||!scopes.some(scope=>scope.kind==="traffic"))error("$.containment.scopes","Containment needs an administrative band and a traffic scope");
 warn("$.containment.scopes",scopes.filter(scope=>scope.kind==="admin").length,2,"administrative bands");warn("$.containment.scopes",scopes.filter(scope=>scope.kind==="traffic").length,4,"traffic scopes");warn("$.nodes",spec.nodes.length,8,"containment nodes");
 scopes.forEach((scope,index)=>{
  const path=`$.containment.scopes[${index}]`;
  if([...scope.at,...scope.size].some(value=>value%4))error(path,"Scope bounds must align to the 4px structural grid");
  if(scope.kind==="admin"&&scope.size[0]<scope.size[1])error(path,"An administrative band is a horizontal rectangle");
  if(scope.kind==="admin"&&scope.size[1]<48)error(path,"An administrative band needs its 24px header and content clearance");
  if(typeWidthBudget(scope.label,"label",9)>scope.size[0]-16)error(path,"Scope heading cannot fit at the 9px floor");
  const parent=innermost(scope,scope.id);
  if(scope.parent!==parent?.id)error(`${path}.parent`,"Name the innermost geometrically enclosing scope; only outer scopes may omit parent");
  const chain=new Set([scope.id]);let ancestor=scope.parent;while(ancestor){if(chain.has(ancestor)){error(`${path}.parent`,"Scope parents cannot contain a cycle");break;}chain.add(ancestor);ancestor=scopeIds.get(ancestor)?.parent;}
  if(scopes.some(other=>other.id!==scope.id&&contains(scope,other)&&contains(other,scope)))error(path,"Distinct scopes cannot have identical bounds");
  if(scope.parent&&!scopeIds.has(scope.parent))error(`${path}.parent`,"The parent scope does not exist");
  if(parent?.kind==="admin"&&scope.at[1]<parent.at[1]+24)error(path,"Child scope intrudes into the administrative 24px header");
  for(const other of scopes.slice(0,index))if(overlap(scope,other)&&!contains(scope,other)&&!contains(other,scope))error(path,"Scopes must be disjoint siblings or completely nested");
 });
 const axis=(id:string,seen=new Set<string>()):"row"|"column"=>{
  const scope=scopeIds.get(id)!;if(seen.has(id))return"row";seen.add(id);
  if(scope.kind==="admin"||!scope.parent)return scope.size[0]>=scope.size[1]?"row":"column";
  return axis(scope.parent,seen)==="row"?"column":"row";
 };
 for(const parent of scopes){const children=scopes.filter(scope=>scope.parent===parent.id&&scope.kind==="traffic"),coordinate=axis(parent.id)==="row"?1:0;if(children.some(child=>child.at[coordinate]!==children[0]?.at[coordinate]))error("$.containment.scopes",`Traffic siblings in '${parent.id}' must share one ${coordinate===1?"y":"x"} axis`);}
 spec.nodes.forEach((node,index)=>{
  const path=`$.nodes[${index}]`,parent=innermost(node),declared=node.parent?scopeIds.get(node.parent):undefined;
  if(!node.kind)error(`${path}.kind`,"Containment nodes require compute, endpoint or managed kind");
  if(!parent||node.parent!==parent.id)error(`${path}.parent`,"Name the innermost enclosing scope for every containment node");
  if(declared?.kind==="admin"&&node.at[1]<declared.at[1]+24)error(path,"Node intrudes into the administrative 24px header");
  if(scopes.some(scope=>node.at[0]<scope.at[0]+scope.size[0]&&node.at[0]+node.size[0]>scope.at[0]&&node.at[1]<scope.at[1]+scope.size[1]&&node.at[1]+node.size[1]>scope.at[1]&&!contains(scope,node)))error(path,"A node cannot straddle a scope boundary");
  if(declared?.kind==="traffic"&&node.at[1]<declared.at[1]+16)error(path,"Leave readable clearance below the traffic scope heading");
  if(node.kind==="managed"&&scopes.some(scope=>scope.kind==="traffic"&&contains(scope,node)))error(path,"A managed service must stay outside every traffic scope");
  if(node.kind==="managed"&&declared?.kind!=="admin")error(path,"A managed service belongs to its administrative band");
  if((node.kind==="compute"||node.kind==="endpoint")&&declared?.kind!=="traffic")error(path,"Compute and endpoint nodes belong inside a traffic scope");
  if(node.kind==="endpoint"&&!spec.nodes.some(target=>target.id===node.target&&target.kind==="managed"))error(`${path}.target`,"An endpoint must target an existing managed node");
  if(node.kind!=="endpoint"&&node.target)error(`${path}.target`,"Only endpoint nodes have a managed target");
 });
 spec.edges.forEach((edge,index)=>{if(edge.peering&&(edge.from===edge.to||scopeIds.get(edge.from)?.kind!=="traffic"||scopeIds.get(edge.to)?.kind!=="traffic"))error(`$.edges[${index}]`,"Peering joins two distinct declared traffic scopes");});
 return{errors,warnings};
}
