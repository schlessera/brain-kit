import {calloutPathPoints,pointAlongCalloutPath} from "./callout-path.js";
import type { DiagramBox, DiagramPoint, DiagramTree } from "./geometry.js";
import type { DiagramSpec } from "./spec.js";
import { typeWidthBudget } from "./skin.js";
export type CalloutSide = "below" | "above" | "right" | "left";
export interface CalloutPlacement { index:number; target:string; name:string; text:string; placement:CalloutSide|"marker"; box:DiagramBox; lines:string[]; anchor:DiagramPoint; end?:DiagramPoint }
export interface CalloutPlan { placements:CalloutPlacement[]; bandTop:number; bandHeight:number; contentBottom:number; errors:Array<{path:string;code:"callout_room";message:string}> }
const sides:CalloutSide[]=["below","above","right","left"];
const pad=(box:DiagramBox,n:number):DiagramBox=>({x:box.x-n,y:box.y-n,width:box.width+2*n,height:box.height+2*n});
const overlaps=(a:DiagramBox,b:DiagramBox)=>a.x<=b.x+b.width&&a.x+a.width>=b.x&&a.y<=b.y+b.height&&a.y+a.height>=b.y;
const pointDistance=(point:DiagramPoint,box:DiagramBox)=>Math.hypot(Math.max(box.x-point.x,0,point.x-box.x-box.width),Math.max(box.y-point.y,0,point.y-box.y-box.height));
const bounds=(a:DiagramPoint,b:DiagramPoint):DiagramBox=>({x:Math.min(a.x,b.x),y:Math.min(a.y,b.y),width:Math.abs(a.x-b.x),height:Math.abs(a.y-b.y)});
/** Greedy word wrapping uses the same conservative sans width table as node names. */
export function wrapCallout(value:string,measure=168):{lines:string[];width:number;height:number}{
 const lines:string[]=[];
 for(const paragraph of value.split(/\r?\n/)){
  let line="";for(const word of paragraph.split(/\s+/).filter(Boolean)){
   if(line&&typeWidthBudget(`${line} ${word}`,"note")>measure){lines.push(line);line=word;}else line=line?`${line} ${word}`:word;
  }lines.push(line);
 }
 return {lines,width:Math.max(1,...lines.map(line=>typeWidthBudget(line,"note"))),height:lines.length*14};
}
export function calloutTargetName(spec:DiagramSpec,target:string):string {
 const node=spec.nodes.find(item=>item.id===target);if(node)return node.label;
 const group=spec.groups?.find(item=>item.id===target);if(group)return group.label;
 if(spec.type==="architecture"){const scope=spec.containment?.scopes.find(item=>item.id===target);if(scope)return scope.label;}
 const edge=spec.edges.find(item=>item.id===target);return edge?.label??(edge?`${spec.nodes.find(node=>node.id===edge.from)?.label??edge.from} to ${spec.nodes.find(node=>node.id===edge.to)?.label??edge.to}`:target);
}
/** Readable annotation placement only; nodes and routed connectors never move. */
export function planCallouts(spec:DiagramSpec,tree:DiagramTree,footerHeight:number,grow=spec.size==="fit"):CalloutPlan {
 const placements:CalloutPlacement[]=[],errors:CalloutPlan["errors"]=[];
 const nodes=tree.elements.filter(item=>item.kind==="node"),groups=tree.elements.filter(item=>item.kind==="group");
 const boxes:DiagramBox[]=tree.elements.flatMap(item=>item.kind==="connector"||item.kind==="group"?[]:item.kind==="shape"&&(item.paint==="zone"||item.paint==="cluster"||item.paint==="lifeline")?[]:[item]);
 const segments=tree.elements.flatMap(item=>item.kind==="connector"?item.points.slice(1).map((point,index)=>({a:item.points[index]!,b:point,edge:item.edge})):item.kind==="shape"&&item.shape==="line"?[{a:{x:item.x1,y:item.y1},b:{x:item.x2,y:item.y2},edge:-1}]:[]);
 let contentBottom=Math.max(0,...tree.elements.map(item=>item.kind==="connector"?Math.max(...item.points.map(point=>point.y)):item.y+item.height));
 const initialBottom=contentBottom;
 const frame={...tree.viewBox};
 if(grow&&frame.width!==320){const longest=Math.max(0,...(spec.callouts??[]).flatMap(note=>note.text.split(/\s+/).map(word=>typeWidthBudget(word,"note"))));frame.width=Math.max(frame.width,Math.ceil((longest+56)/4)*4);tree.viewBox.width=frame.width;}
 for(const group of groups)boxes.push({x:group.x+4,y:group.y-7,width:typeWidthBudget(group.label,"label")+8,height:14});
 function within(box:DiagramBox){return box.x>=8&&box.x+box.width<=frame.width-8&&box.y>=8&&(grow||box.y+box.height<=frame.height-footerHeight-8);}
 function targetFor(target:string){return nodes.find(item=>item.id===target)??groups.find(item=>item.id===target)??tree.elements.find(item=>item.kind==="shape"&&item.nodeId===target&&item.shape!=="text");}
 function boundary(target:string,side:CalloutSide):DiagramPoint|undefined{
  const box=targetFor(target);if(!box||box.kind==="connector")return;
  const cx=box.x+box.width/2,cy=box.y+box.height/2,dx=side==="left"?-1:side==="right"?1:0,dy=side==="above"?-1:side==="below"?1:0;
  const polygon=box.kind==="shape"&&box.shape==="polygon"?box.points:box.kind==="node"&&box.shape==="decision"?[{x:cx,y:box.y},{x:box.x+box.width,y:cy},{x:cx,y:box.y+box.height},{x:box.x,y:cy}]:undefined;
  if(polygon){for(let i=0;i<polygon.length;i++){const a=polygon[i]!,b=polygon[(i+1)%polygon.length]!,vx=b.x-a.x,vy=b.y-a.y,den=dx*vy-dy*vx;if(Math.abs(den)<1e-8)continue;const t=((a.x-cx)*vy-(a.y-cy)*vx)/den,u=((a.x-cx)*dy-(a.y-cy)*dx)/den;if(t>=0&&u>=0&&u<=1)return{x:cx+dx*t,y:cy+dy*t};}}
  return{x:cx+dx*box.width/2,y:cy+dy*box.height/2};
 }
 function anchorFor(target:string,side:CalloutSide):DiagramPoint|undefined {
  const border=boundary(target,side);if(border)return border;
  const index=spec.edges.findIndex(edge=>edge.id===target),route=tree.elements.find(item=>item.kind==="connector"&&item.edge===index);
  if(route?.kind==="connector"){
   const lengths=route.points.slice(1).map((point,i)=>Math.hypot(point.x-route.points[i]!.x,point.y-route.points[i]!.y)),total=lengths.reduce((a,b)=>a+b,0);
   for(const fraction of [0.25,0.75]){let remaining=total*fraction;for(let i=0;i<lengths.length;i++){const length=lengths[i]!;if(remaining>length){remaining-=length;continue;}const a=route.points[i]!,b=route.points[i+1]!,t=remaining/length,p={x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t};
    if(remaining>=8&&length-remaining>=8&&!tree.elements.some(item=>(item.kind==="label-mask"||item.kind==="cardinality")&&pointDistance(p,item)<8))return p;break;}
   }
  }
  const shape=tree.elements.find(item=>item.kind==="shape"&&item.edgeId===target);
  if(shape?.kind==="shape"&&shape.shape==="line")for(const fraction of [0.25,0.75]){const point={x:shape.x1+(shape.x2-shape.x1)*fraction,y:shape.y1+(shape.y2-shape.y1)*fraction};if(!boxes.some(box=>box!==shape&&overlaps(pad(box,8),{...point,width:0,height:0})))return point;}
  if(shape?.kind==="shape"&&shape.shape==="path"){const points=calloutPathPoints(shape.d);for(const fraction of [0.25,0.75]){const point=pointAlongCalloutPath(points,fraction);if(point&&!boxes.some(box=>box!==shape&&overlaps(pad(box,8),{...point,width:0,height:0})))return point;}}
  return undefined;
 }
 for(const [index,note] of (spec.callouts??[]).entries()){
  const order=note.side?[note.side,...sides.filter(side=>side!==note.side)]:sides;
  let chosen:CalloutPlacement|undefined;
  for(const side of order){const anchor=anchorFor(note.target,side);if(!anchor)continue;
   candidate: for(const measure of [168,112,80])for(const gap of [16,24,8])for(const slide of [0,-0.5,0.5]){
    const wrapped=wrapCallout(note.text,measure);
    const vertical=side==="below"||side==="above",box={x:vertical?anchor.x-wrapped.width/2+slide*wrapped.width:side==="right"?anchor.x+gap:anchor.x-gap-wrapped.width,y:vertical?side==="below"?anchor.y+gap:anchor.y-gap-wrapped.height:anchor.y-wrapped.height/2+slide*wrapped.height,width:wrapped.width,height:wrapped.height};
    const end=vertical?{x:anchor.x,y:side==="below"?box.y-2:box.y+box.height+2}:{x:side==="right"?box.x-2:box.x+box.width+2,y:anchor.y};
    if(groups.some(group=>overlaps(pad(box,4),group)&&!(box.x-4>=group.x&&box.y-4>=group.y&&box.x+box.width+4<=group.x+group.width&&box.y+box.height+4<=group.y+group.height)))continue;
    if(!within(pad(box,4))||boxes.some(obstacle=>overlaps(pad(box,4),obstacle))||segments.some(segment=>overlaps(pad(box,5),bounds(segment.a,segment.b)))||placements.some(other=>other.end&&overlaps(pad(box,4),pad(bounds(other.anchor,other.end),1))))continue;
    const leader=bounds(anchor,end),targetBox=nodes.find(node=>node.id===note.target)??tree.elements.find(item=>item.kind==="shape"&&item.nodeId===note.target&&item.shape!=="text");
    // The target boundary is the sole permitted contact. Group borders can be crossed.
    if(boxes.some(obstacle=>obstacle!==targetBox&&overlaps(pad(leader,1),obstacle))||placements.some(other=>overlaps(pad(leader,1),pad(other.box,4))))continue;
    const blocked=segments.some(segment=>{
     if(spec.edges[segment.edge]?.id===note.target&&pointDistance(anchor,bounds(segment.a,segment.b))<.01){const vx=segment.b.x-segment.a.x,vy=segment.b.y-segment.a.y,lx=end.x-anchor.x,ly=end.y-anchor.y;return Math.abs(vx*ly-vy*lx)<.01;}
     return overlaps(pad(leader,1),bounds(segment.a,segment.b));
    });if(blocked)continue;
    chosen={index,target:note.target,name:calloutTargetName(spec,note.target),text:note.text,placement:side,box,lines:wrapped.lines,anchor,end};break candidate;
   }if(chosen)break;
  }
  if(!chosen){
   const target=targetFor(note.target);
   const anchor=target&&target.kind!=="connector"?{x:target.x+target.width,y:target.y}:anchorFor(note.target,"below")??{x:16,y:initialBottom+16};
   chosen={index,target:note.target,name:calloutTargetName(spec,note.target),text:note.text,placement:"marker",box:{x:anchor.x-8,y:anchor.y-8,width:16,height:16},lines:wrapCallout(note.text).lines,anchor};
  }
  placements.push(chosen);boxes.push(chosen.box);contentBottom=Math.max(contentBottom,chosen.box.y+chosen.box.height);
 }
 const bandTop=contentBottom+12;let cursor=bandTop+12;
 for(const note of placements.filter(item=>item.placement==="marker")){
  const wrapped=wrapCallout(note.text,frame.width-56),box={x:40,y:cursor,width:wrapped.width,height:Math.max(16,wrapped.height)};
  if(box.width>frame.width-48||!grow&&box.y+box.height+footerHeight+16>frame.height)errors.push({path:`$.callouts[${note.index}]`,code:"callout_room",message:"No collision-free readable callout or notes band fits; reserve space or choose size: fit"});
  note.lines=wrapped.lines;cursor+=box.height+8;
 }
 const bandHeight=cursor===bandTop+12?0:cursor-bandTop+4;
 if(grow&&placements.length)tree.viewBox={...frame,height:Math.ceil((Math.max(frame.height-footerHeight,contentBottom+8,bandTop+bandHeight)+footerHeight+8)/4)*4};
 return {placements,bandTop,bandHeight,contentBottom,errors};
}
