import type { DiagramSpec } from "./spec.js";
import type { DiagramTree, DiagramBox } from "./geometry.js";
import type { DiagramShape, DiagramShapePaint } from "./shape.js";
import { fitDiagramText, typeWidthBudget, type DiagramTypeRole } from "./skin.js";
type Fixed=Extract<DiagramSpec,{type:"quadrant"|"layer-stack"|"pyramid"|"funnel"|"loop"|"flywheel"|"venn"}>;
const sizes:Record<string,[number,number]>={"doc-inline":[960,600],"doc-wide":[1280,720],"slide-16x9":[1280,720],"slide-4x3":[1024,768],"social-og":[1200,632],"social-square":[1080,1080],"print-a4-landscape":[1120,792],"print-a3-landscape":[1584,1120],"print-letter-landscape":[1056,816]};
const round=(n:number)=>Math.round(n/4)*4;
/** Deterministic type geometry. Typed content references the same common semantic nodes. */
export function buildPositionalDiagram(input:DiagramSpec):DiagramTree {
 const spec=input as Fixed, [width,height]=sizes[spec.size]??[960,600], elements:DiagramShape[]=[];
 const nodes=new Map(spec.nodes.map(node=>[node.id,node])), focal=new Set([...(spec.focal??[]),...spec.nodes.filter(n=>n.role==="focal").map(n=>n.id)]);
 const base=(id:string,x:number,y:number,w:number,h:number,paint:DiagramShapePaint)=>({kind:"shape" as const,id,x,y,width:w,height:h,paint,family:"positional" as const});
 const rect=(id:string,x:number,y:number,w:number,h:number,paint:DiagramShapePaint,nodeId?:string)=>elements.push({...base(id,x,y,w,h,paint),shape:"rect",radius:5,nodeId});
 const line=(id:string,x1:number,y1:number,x2:number,y2:number,paint:DiagramShapePaint="line",arrow=false,from?:string,to?:string)=>elements.push({...base(id,Math.min(x1,x2)-5,Math.min(y1,y2)-5,Math.abs(x2-x1)+10,Math.abs(y2-y1)+10,paint),shape:"line",x1,y1,x2,y2,from,to,...(arrow?{arrow:{x:x2,y:y2,dx:(x2-x1)/Math.hypot(x2-x1,y2-y1),dy:(y2-y1)/Math.hypot(x2-x1,y2-y1),head:"open" as const}}:{})});
 const text=(id:string,value:string,x:number,y:number,w:number,role:DiagramTypeRole="name",paint:DiagramShapePaint="text",align:"start"|"middle"|"end"="middle",h=20)=>{
  const owner=id.replace(/-(?:name|label|sub|index)$/u,"");fitDiagramText(value,role,w); elements.push({...base(id,x,y,w,h,paint),shape:"text",text:value,textRole:role,align,...(owner!==id&&nodes.has(owner)?{nodeId:owner}:{})});
 };
 const circle=(id:string,cx:number,cy:number,radius:number,paint:DiagramShapePaint,nodeId?:string)=>elements.push({...base(id,cx-radius,cy-radius,2*radius,2*radius,paint),shape:"circle",cx,cy,radius,nodeId});
 const polygon=(id:string,points:Array<{x:number;y:number}>,paint:DiagramShapePaint,nodeId?:string)=>{const x=Math.min(...points.map(p=>p.x)),y=Math.min(...points.map(p=>p.y));elements.push({...base(id,x,y,Math.max(...points.map(p=>p.x))-x,Math.max(...points.map(p=>p.y))-y,paint),shape:"polygon",points,nodeId});};
 const name=(id:string,box:DiagramBox,inverse=false)=>{const node=nodes.get(id);if(!node)throw Error(`Unknown positional node '${id}'`);text(`${id}-name`,node.label,box.x+8,box.y+(node.sub?box.height/2-20:box.height/2-10),box.width-16,"name",inverse?"on-ink":"text");if(node.sub)text(`${id}-sub`,node.sub,box.x+8,box.y+box.height/2,box.width-16,"sub",inverse?"on-ink":focal.has(id)?"text":"muted");};
 if(spec.type==="quadrant") {
  const data=spec.positional?.quadrant, cx=width/2,cy=height/2-20, rx=width/2-168,ry=height/2-112;
  line("x-axis",cx-rx,cy,cx+rx,cy,"primary",true);line("y-axis",cx,cy+ry,cx,cy-ry,"primary",true);
  const axes=data??{xAxis:{negative:"EFFORT",positive:"IMPACT"},yAxis:{negative:"LATER",positive:"NOW"}};
  text("x-negative",axes.xAxis.negative,16,cy-10,132,"label");text("x-positive",axes.xAxis.positive,width-148,cy-10,132,"label");
  text("y-positive",axes.yAxis.positive,cx-100,cy-ry-40,200,"label");text("y-negative",axes.yAxis.negative,cx-100,cy+ry+16,200,"label");
  spec.nodes.forEach((node,i)=>{const p=data?.points.find(p=>p.node===node.id),x=p?.x??(i%2?-.55:.55),y=p?.y??(i%4<2?.55:-.55),px=cx+x*(rx-56),py=cy-y*(ry-24);
   if(Math.abs(px-cx)<8||Math.abs(py-cy)<14)throw Error("Quadrant dots and labels must remain clear of both axes; author a less ambiguous position");
   circle(node.id,px,py,4,focal.has(node.id)?"focal":"ink",node.id);text(`${node.id}-label`,node.label,x<0?px-146:px+10,py-10,136,"name","text",x<0?"end":"start");
  });
 } else if(spec.type==="layer-stack") {
  const data=spec.positional?.stack,order=data?.order??spec.nodes.map(n=>n.id), w=width-240,h=Math.min(64,Math.floor((height-136)/Math.max(1,order.length)/4)*4),x=144,y=48;
  order.forEach((id,i)=>{const rowY=y+i*h;rect(id,x,rowY,w,h,focal.has(id)?"focal":i%2?"cluster":"node",id);text(`${id}-index`,`L${order.length-i}`,x+12,rowY+h/2-10,48,"label","muted");const n=nodes.get(id)!;text(`${id}-label`,n.label,x+80,rowY+h/2-10,n.sub?w/2-104:w-104,"name","text","start");if(n.sub)text(`${id}-sub`,n.sub,x+w/2,rowY+h/2+8,w/2-16,"sub","muted","end");});
  if(order.length){const up=data?.direction!=="down";line("direction",96,up?y+order.length*h:y,96,up?y:y+order.length*h,"line",true);text("direction-label",data?.directionLabel??"LAYERS",16,y+order.length*h/2-10,64,"label");}
 } else if(spec.type==="pyramid"||spec.type==="funnel") {
  const data=spec.positional?.pyramid,layers:Array<{node:string;value?:number;annotation?:string}>=data?.layers??spec.nodes.map(node=>({node:node.id})), maxWidth=width-320, rowH=Math.min(64,Math.floor((height-136)/Math.max(1,layers.length)/4)*4),cx=width/2,y=48;
  const values=layers.map((layer,i)=>layer.value??(spec.type==="funnel"?layers.length-i:i+1)),maximum=Math.max(1,...values);
  layers.forEach((layer,i)=>{const node=nodes.get(layer.node)!;const topValue=spec.type==="funnel"?values[i]!:i===0?0:values[i-1]!,bottomValue=spec.type==="funnel"?(i===layers.length-1?values[i]!:values[i+1]!):values[i]!;
   const top=maxWidth*topValue/maximum,bottom=maxWidth*bottomValue/maximum,yy=y+i*rowH;
   polygon(layer.node,[{x:cx-top/2,y:yy},{x:cx+top/2,y:yy},{x:cx+bottom/2,y:yy+rowH},{x:cx-bottom/2,y:yy+rowH}],focal.has(layer.node)?"focal":i%2?"cluster":"node",layer.node);
   const textY=yy+(node.sub?Math.max(16,rowH-44):rowH/2-6), bandHeight=node.sub?40:20;
   const widthAt=(offset:number)=>top+(bottom-top)*offset/rowH;
   const available=Math.min(widthAt(textY-yy),widthAt(textY-yy+bandHeight))-16;
   text(`${layer.node}-name`,node.label,cx-available/2,textY,available,"name");if(node.sub)text(`${layer.node}-sub`,node.sub,cx-available/2,textY+20,available,"sub","muted");if(layer.annotation)text(`${layer.node}-annotation`,layer.annotation,cx+maxWidth/2+12,yy+rowH/2-10,132,"sub","muted","start");
  });
 } else if(spec.type==="loop"||spec.type==="flywheel") {
  const data=spec.positional?.loop,hub=data?.hub??spec.nodes[0]?.id,stations=data?.stations??spec.nodes.slice(1).map(n=>n.id),count=stations.length,cx=width/2,cy=height/2-20,radius=Math.max(216,Math.ceil((count*112/(2*Math.PI)+24)/4)*4),sw=112,sh=64,hubBox={x:cx-88,y:cy-48,width:176,height:96};
  const boxes=stations.map((id,k)=>{const angle=-Math.PI/2+k*2*Math.PI/Math.max(1,count),x=round(cx+radius*Math.cos(angle)-sw/2),y=round(cy+radius*Math.sin(angle)-sh/2);return{id,angle,x,y,width:sw,height:sh};});
  const intersection=(box:typeof boxes[number],clockwise:boolean)=>{
   const points:Array<{x:number;y:number;delta:number}>=[],add=(x:number,y:number)=>{if(x<box.x-0.001||x>box.x+sw+0.001||y<box.y-0.001||y>box.y+sh+0.001)return;points.push({x,y,delta:Math.atan2(Math.sin(Math.atan2(y-cy,x-cx)-box.angle),Math.cos(Math.atan2(y-cy,x-cx)-box.angle))});};
   for(const x of[box.x,box.x+sw]){const d=radius*radius-(x-cx)**2;if(d>=0){add(x,cy+Math.sqrt(d));add(x,cy-Math.sqrt(d));}}
   for(const y of[box.y,box.y+sh]){const d=radius*radius-(y-cy)**2;if(d>=0){add(cx+Math.sqrt(d),y);add(cx-Math.sqrt(d),y);}}
   const sorted=points.filter(p=>clockwise?p.delta>=0:p.delta<=0).sort((a,b)=>Math.abs(a.delta)-Math.abs(b.delta));if(!sorted.length)throw Error("Loop circle has no station-edge intersection");return sorted[0]!;
  };
  const spokeLabels:Array<{id:string;text:string;sx:number;sy:number;ex:number;ey:number}>=[];
  const rayDistance=(box:DiagramBox,ux:number,uy:number,exit:boolean)=>{let low=-Infinity,high=Infinity;for(const [origin,direction,min,max]of [[cx,ux,box.x,box.x+box.width],[cy,uy,box.y,box.y+box.height]]){if(Math.abs(direction!)<1e-8){if(origin!<min!||origin!>max!)throw Error("Radial spoke misses its station");continue;}const a=(min!-origin!)/direction!,b=(max!-origin!)/direction!;low=Math.max(low,Math.min(a,b));high=Math.min(high,Math.max(a,b));}if(low>high)throw Error("Radial spoke misses its station");return exit?high:low;};
  boxes.forEach((box,k)=>{const target=boxes[(k+1)%count]!,start=intersection(box,true),end=intersection(target,false),angleStart=Math.atan2(start.y-cy,start.x-cx),angleEnd=Math.atan2(end.y-cy,end.x-cx),sweep=(angleEnd-angleStart+2*Math.PI)%(2*Math.PI),d=`M ${start.x} ${start.y} A ${radius} ${radius} 0 ${sweep>Math.PI?1:0} 1 ${end.x} ${end.y}`;
   elements.push({...base(`ring-${k}`,cx-radius-8,cy-radius-8,2*radius+16,2*radius+16,"line"),shape:"path",d,from:box.id,to:target.id,arrow:{x:end.x,y:end.y,dx:-Math.sin(angleEnd),dy:Math.cos(angleEnd),head:"open"}});
   const ux=Math.cos(box.angle),uy=Math.sin(box.angle),stationDistance=rayDistance(box,ux,uy,false),hubDistance=rayDistance(hubBox,ux,uy,true),sx=cx+ux*stationDistance,sy=cy+uy*stationDistance,ex=cx+ux*(hubDistance+6),ey=cy+uy*(hubDistance+6);
   line(`spoke-${k}`,sx,sy,ex,ey,"return",true,box.id,hub);
   const label=data?.spokeLabels?.find(label=>label.station===box.id)?.text;if(label)spokeLabels.push({id:String(k),text:label,sx,sy,ex,ey});
  });
  for(const label of spokeLabels){
   const w=Math.ceil((typeWidthBudget(label.text,"label")+8)/4)*4,h=16,length=Math.hypot(label.ex-label.sx,label.ey-label.sy),nx=-(label.ey-label.sy)/length,ny=(label.ex-label.sx)/length,support=Math.abs(nx)*w/2+Math.abs(ny)*h/2;
   const clear=(candidate:DiagramBox)=>{
    if([...boxes,hubBox,...elements.filter(e=>e.paint==="mask")].some(b=>candidate.x<b.x+b.width&&candidate.x+candidate.width>b.x&&candidate.y<b.y+b.height&&candidate.y+candidate.height>b.y))return false;
    for(const x of[candidate.x,candidate.x+w])for(const y of[candidate.y,candidate.y+h])if(Math.hypot(x-cx,y-cy)>radius-8)return false;
    for(const e of elements)if(e.shape==="line"){
     let lo=0,hi=1;for(const [origin,delta,min,max]of [[e.x1,e.x2-e.x1,candidate.x-8+1e-6,candidate.x+w+8-1e-6],[e.y1,e.y2-e.y1,candidate.y-8+1e-6,candidate.y+h+8-1e-6]]){if(Math.abs(delta!)<1e-8){if(origin!<min!||origin!>max!){lo=1;hi=0;}continue;}const a=(min!-origin!)/delta!,b=(max!-origin!)/delta!;lo=Math.max(lo,Math.min(a,b));hi=Math.min(hi,Math.max(a,b));}if(lo<=hi)return false;
    }return true;
   };
   let mask:DiagramBox|undefined;
   for(const t of[.5,.35,.65])for(const side of[-1,1]){const mx=label.sx+(label.ex-label.sx)*t+nx*side*(support+8),my=label.sy+(label.ey-label.sy)*t+ny*side*(support+8),candidate={x:mx-w/2,y:my-h/2,width:w,height:h};if(!mask&&clear(candidate))mask=candidate;}
   if(!mask)throw Error(`Loop spoke '${label.id}' has no safe opaque label mask; shorten its label or split the diagram`);
   rect(`spoke-mask-${label.id}`,mask.x,mask.y,w,h,"mask");text(`spoke-label-${label.id}`,label.text,mask.x+4,mask.y,w-8,"label","muted","middle",h);
  }
  boxes.forEach(box=>{rect(box.id,box.x,box.y,sw,sh,focal.has(box.id)?"focal":"node",box.id);name(box.id,box);});
  if(hub){rect(hub,hubBox.x,hubBox.y,hubBox.width,hubBox.height,"ink",hub);name(hub,hubBox,true);}
 } else if(spec.type==="venn") {
  const data=spec.positional?.venn,sets:Array<{node:string;weight?:number}>=data?.sets??spec.nodes.map(node=>({node:node.id})),cx=width/2,cy=height/2-40,maxWeight=Math.max(1,...sets.map(set=>set.weight??1));
  let radiusScale=144,bestError=Infinity;
  for(let scale=128;scale<=160;scale+=4){const error=Math.max(0,...sets.map(set=>{const ratio=(set.weight??1)/maxWeight,r=round(scale*Math.sqrt(ratio));return r<8?Infinity:Math.abs((r/scale)**2/ratio-1);}));if(error<bestError-1e-8||Math.abs(error-bestError)<1e-8&&Math.abs(scale-144)<Math.abs(radiusScale-144)){radiusScale=scale;bestError=error;}}
  if(bestError>.05)throw Error("Venn weights cannot retain honest areas within 5% on the 4px radius grid; split or annotate the comparison");
  const radii=sets.map(set=>round(radiusScale*Math.sqrt((set.weight??1)/maxWeight))),depth=Math.max(4,round(Math.min(...radii)/2));
  const circles=sets.map((set,i)=>{const count=sets.length,angle=count===2?(i?0:Math.PI):count===3?[-5*Math.PI/6,-Math.PI/6,Math.PI/2][i]!:-Math.PI+i*2*Math.PI/Math.max(1,count),radius=radii[i]!,x=cx+round((radius-depth)*Math.cos(angle)),y=cy+round((radius-depth)*Math.sin(angle));return{...set,cx:x,cy:y,radius};});
  for(const c of circles)if(Math.hypot(c.cx-cx,c.cy-cy)>=c.radius)throw Error("Venn circles must share a genuine overlap");
  const left=Math.min(...circles.map(c=>c.cx-c.radius)),right=Math.max(...circles.map(c=>c.cx+c.radius)),top=Math.min(...circles.map(c=>c.cy-c.radius)),bottom=Math.max(...circles.map(c=>c.cy+c.radius));
  circles.forEach((set,i)=>{circle(set.node,set.cx,set.cy,set.radius,"line",set.node);const outline=elements.at(-1)!;outline.strokeWidth=i===0?2:1;
   const node=nodes.get(set.node)!;
   const count=circles.length,side=count===2?i===0?"left":"right":count===3?i===0?"left":i===1?"right":"bottom":["left","top","right","bottom"][i%4]!,x=side==="left"?left-160:side==="right"?right+12:set.cx-74,y=side==="top"?top-(node.sub?52:32):side==="bottom"?bottom+12:set.cy-10;
   text(`${set.node}-label`,node.label,x,y,148,"name","text",side==="left"?"end":side==="right"?"start":"middle");
   if(node.sub)text(`${set.node}-sub`,node.sub,x,y+20,148,"sub","muted",side==="left"?"end":side==="right"?"start":"middle");
  });
  const distanceToBox=(x:number,y:number,box:DiagramBox)=>Math.hypot(Math.max(box.x-x,0,x-box.x-box.width),Math.max(box.y-y,0,y-box.y-box.height));
  const farthest=(x:number,y:number,box:DiagramBox)=>Math.max(...[box.x,box.x+box.width].flatMap(px=>[box.y,box.y+box.height].map(py=>Math.hypot(px-x,py-y))));
  (data?.intersections??[]).forEach((region,i)=>{const selected=circles.filter(set=>region.members.includes(set.node)),w=Math.ceil((typeWidthBudget(region.label,"label")+16)/4)*4,h=24;
   let box:DiagramBox|undefined;
   for(const dx of[0,-24,24,-48,48])for(const dy of[0,-24,24,-48,48]){const candidate={x:cx+dx-w/2,y:cy+dy-h/2,width:w,height:h};if(!box&&selected.every(c=>farthest(c.cx,c.cy,candidate)<=c.radius-4)&&circles.every(c=>farthest(c.cx,c.cy,candidate)<=c.radius-4||distanceToBox(c.cx,c.cy,candidate)>=c.radius+4)&&!elements.some(e=>e.id.startsWith("intersection-")&&candidate.x<e.x+e.width&&candidate.x+w>e.x&&candidate.y<e.y+e.height&&candidate.y+h>e.y))box=candidate;}
   if(!box){
    box={x:cx-w/2,y:Math.max(bottom+36,...elements.filter(e=>e.shape==="text").map(e=>e.y+e.height+12))+i*36,width:w,height:h};
    if(box.y+h>height-48)throw Error("The small Venn overlap needs a readable leader callout; select a taller canvas");
    line(`intersection-leader-${i}`,cx,box.y,cx,cy,region.focal?"primary":"line",false);circle(`intersection-anchor-${i}`,cx,cy,3,region.focal?"accent":"ink");
   }
   rect(`intersection-${i}`,box.x,box.y,w,h,region.focal?"focal":"node");text(`intersection-label-${i}`,region.label,box.x+4,box.y+2,w-8,"label",region.focal?"accent":"text");
  });
 }

 for(const item of elements){for(const value of[item.x,item.y,item.width,item.height])if(!Number.isFinite(value)||item.width<0||item.height<0)throw Error("Positional geometry must be finite and bounded");if(item.x<8||item.y<8||item.x+item.width>width-8||item.y+item.height>height-48)throw Error(`Positional shape '${item.id}' exceeds its canvas; split the diagram or select a larger canvas`);}
 return{schema_version:1,type:spec.type,title:spec.title,desc:spec.desc,viewBox:{x:0,y:0,width,height},elements};
}
