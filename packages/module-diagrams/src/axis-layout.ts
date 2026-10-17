import type { DiagramSpec } from "./spec.js";
import type { DiagramShape } from "./shape.js";
import { buildDiagram, type DiagramTree, type DiagramElement } from "./geometry.js";
import { typeWidthBudget } from "./skin.js";
import { checkAxis } from "./axis-check.js";
export interface AxisShape {
 kind:"axis-shape"; shape:"line"|"rect"|"path"|"circle"|"text"; name:string;
 x:number;y:number;x2?:number;y2?:number;width?:number;height?:number;radius?:number;path?:string;text?:string;
 paint:"line"|"lifeline"|"bar"|"node"|"zone"|"mask"|"focal-mask"|"message"|"return"|"async"|"focal";
 textRole?:"name"|"label"|"note";align?:"start"|"middle"|"end";head?:"open"|"filled";edgeId?:string;node?:string;link?:string;from?:string;to?:string;
}
const day=(s:string)=>Date.parse(`${s}T00:00:00Z`)/86400000;
/** Order/date-derived geometry; all glyphs stay at their normal role size. */
export function buildAxisDiagram(spec:DiagramSpec,width=720):DiagramTree {
 const findings=checkAxis(spec);if(findings.errors.length)throw Error(findings.errors.map(f=>`${f.path}: ${f.message}`).join("; "));
 if(spec.type==="swimlane"&&width===720)width=960;
 const auxiliary:DiagramElement[]=[];
 const nodes=spec.nodes, focal=new Set([...(spec.focal??[]),...nodes.filter(n=>n.role==="focal").map(n=>n.id)]), elements:AxisShape[]=[];
 const add=(shape:AxisShape["shape"],name:string,x:number,y:number,paint:AxisShape["paint"],more:Partial<AxisShape>={})=>elements.push({kind:"axis-shape",shape,name,x,y,paint,...more});
 const txt=(value:string,x:number,y:number,role:AxisShape["textRole"]="label",paint:AxisShape["paint"]="line",align:AxisShape["align"]="start")=>add("text",role??"label",x,y,paint,{text:value,textRole:role,align});
 const line=(name:string,x:number,y:number,x2:number,y2:number,paint:AxisShape["paint"]="line")=>add("line",name,x,y,paint,{x2,y2});
 const box=(name:string,x:number,y:number,w:number,h:number,paint:AxisShape["paint"]="node")=>add("rect",name,x,y,paint,{width:w,height:h,radius:5});
 const axis="axis" in spec?spec.axis:undefined;let height=300;
 if(!nodes.length)return {schema_version:1,type:spec.type,title:spec.title,desc:spec.desc,viewBox:{x:0,y:0,width,height:128},elements:[]};
 if(spec.type==="sequence"){
  const messages=axis?.kind==="sequence"?axis.messages:spec.edges.map((e,i)=>({id:e.id??`message-${i}`,from:e.from,to:e.to,label:e.label??"MESSAGE",kind:e.kind==="async"?"async" as const:"message" as const,focal:e.kind==="primary",note:undefined}));
  const pitch=width/Math.max(1,nodes.length);if(pitch<64)throw Error("Sequence participant pitch is below 64px; use summary and Open diagram");
  const centers=new Map(nodes.map((n,i)=>[n.id,pitch*(i+.5)])), narrow=width<=320;
  const tagged=nodes.some(n=>n.tag), header=tagged?52:narrow?36:40, row=narrow?56:48;
  // Labels and self messages reserve distinct rows; notes never overlap the following row.
  const ys:number[]=[];let cursor=24+header+48;for(const [index,m] of messages.entries()){if(axis?.kind==="sequence"&&(axis.fragments??[]).some(f=>f.from===index||f.elseAt===index))cursor+=40;ys.push(cursor);cursor+=row+(m.note?60:0)+(m.from===m.to?24:0);}height=cursor+40;
  nodes.forEach(n=>{const x=centers.get(n.id)!;if(typeWidthBudget(n.label,"name")>pitch-8||n.tag&&typeWidthBudget(n.tag,"label")>pitch-8)throw Error("Participant name or tag cannot fit without shrinking; use summary and Open diagram");line("lifeline",x,24+header,x,height-24,"lifeline");box("participant",x-pitch/2+4,24,pitch-8,header);elements.at(-1)!.node=n.id;if(n.tag){txt(n.tag,x,40,"label","line","middle");elements.at(-1)!.node=n.id;}txt(n.label,x,24+header/2+(n.tag?12:4),"name","line","middle");elements.at(-1)!.node=n.id;});
  // Outlined activations cover each contiguous run of participating messages.
  nodes.forEach(n=>{let start=-1;for(let i=0;i<=messages.length;i++){const m=messages[i],active=!!m&&(m.from===n.id||m.to===n.id);if(active&&start<0)start=i;if(!active&&start>=0){box("activation",centers.get(n.id)!-4,ys[start]!-8,8,ys[i-1]!-ys[start]!+24,"bar");start=-1;}}});
  if(axis?.kind==="sequence")for(const fragment of axis.fragments??[]){const y=ys[fragment.from]!-64,h=ys[fragment.to]!-y+24;box("fragment",20,y,width-40,h,"zone");txt(fragment.kind.toUpperCase(),28,y+12);txt(fragment.guard,76,y+12);if(fragment.elseAt!==undefined){const divider=ys[fragment.elseAt]!-48;line("fragment-divider",24,divider,width-24,divider,"return");txt(fragment.elseGuard??"ELSE",28,divider+12);}}
  messages.forEach((m,i)=>{const a=centers.get(m.from)!,b=centers.get(m.to)!,y=ys[i]!,paint=m.focal?"focal":m.kind??"message",self=a===b,dir=b>=a?1:-1;
   const labelWidth=typeWidthBudget(m.label,"label")+8;let labelX=narrow?(self?a-8:a):((a+b)/2),align:AxisShape["align"]=narrow?(self?"end":dir>0?"start":"end"):"middle";
   if(!narrow&&self){labelX=a-12;align="end";}
   const left=align==="end"?labelX-labelWidth:align==="middle"?labelX-labelWidth/2:labelX;
   if(left<8||left+labelWidth>width-8)throw Error("Message label cannot fit at its normal size; use summary and Open diagram");
   box("message-mask",left,y-26,labelWidth,18,m.focal?"focal-mask":"mask");txt(m.label,labelX+(align==="start"?4:align==="end"?-4:0),y-13,"label",m.focal?"focal":"line",align);
   if(self){const loop=narrow?24:32;if(a+loop+4>width-8)throw Error("Self-message does not fit; use summary and Open diagram");add("path","self-message",a+4,y,paint as AxisShape["paint"],{width:loop-4,height:24,path:`M ${a+4} ${y} L ${a+loop-8} ${y} Q ${a+loop} ${y} ${a+loop} ${y+8} L ${a+loop} ${y+16} Q ${a+loop} ${y+24} ${a+loop-8} ${y+24} L ${a+4} ${y+24}`,x2:a+4,y2:y+24,head:m.focal?"filled":"open"});}
   else add("line","message",a+4*dir,y,paint as AxisShape["paint"],{x2:b-4*dir,y2:y,head:m.focal?"filled":"open"});
   elements.at(-1)!.edgeId=m.id;elements.at(-1)!.from=m.from;elements.at(-1)!.to=m.to;
   if(m.note){const noteWidth=Math.max(140,typeWidthBudget(m.note,"name",11)+16);if(noteWidth>width-32)throw Error("Note cannot fit without shrinking");const x=Math.min(Math.max(16,left),width-noteWidth-16);box("note",x,y+32,noteWidth,44);txt("NOTE",x+8,y+45);txt(m.note,x+8,y+62,"note");}
  });
 }else if(spec.type==="swimlane"){
  const lanes=axis?.kind==="swimlane"?axis.lanes:nodes.map(n=>({id:n.id,label:n.label})),steps=axis?.kind==="swimlane"?axis.steps:nodes.map(n=>({node:n.id,lane:n.id}));
  const laneHeight=112,labelWidth=160,stepWidth=144,pitch=240;const required=labelWidth+steps.length*pitch+24;if(width<required)throw Error("Swimlane needs a readable full canvas; use summary and Open diagram");height=40+lanes.length*laneHeight;
  lanes.forEach((lane,i)=>{const y=24+i*laneHeight;box("lane",16,y,width-32,laneHeight,"zone");txt(lane.label,24,y+24);});
  const positions=new Map<string,{x:number;y:number}>();steps.forEach((step,i)=>{const n=nodes.find(n=>n.id===step.node)!,x=labelWidth+i*pitch,y=56+lanes.findIndex(l=>l.id===step.lane)*laneHeight;positions.set(n.id,{x,y});box("step",x,y,stepWidth,48,focal.has(n.id)?"focal":"node");elements.at(-1)!.node=n.id;if(typeWidthBudget(n.label,"name")>stepWidth-16)throw Error("Step label needs a shorter label or a wider detail diagram");txt(n.label,x+8,y+28,"name");elements.at(-1)!.node=n.id;});
  const placed=nodes.map(n=>({...n,at:[positions.get(n.id)!.x,positions.get(n.id)!.y] as [number,number],size:[144,48] as [number,number]}));
  const {axis:_ignoredAxis,...commonSpec}=spec as Extract<DiagramSpec,{type:"sequence"|"swimlane"|"timeline"|"gantt"}>;
  const routed=buildDiagram({...commonSpec,type:"flowchart",layouts:undefined,size:"fit",nodes:placed,groups:undefined} as unknown as DiagramSpec);
  auxiliary.push(...routed.elements.filter(e=>e.kind!=="node"));

 }else{
  const dated=axis?.kind==="timeline"?axis.events.map(e=>({node:e.node,start:e.date,end:e.date,phase:undefined})):axis?.kind==="gantt"?axis.tasks:nodes.map((n,i)=>({node:n.id,start:new Date(i*86400000).toISOString().slice(0,10),end:new Date((i+1)*86400000).toISOString().slice(0,10),phase:undefined}));
  const start=Math.min(...dated.map(e=>day(e.start))),end=Math.max(...dated.map(e=>day(e.end))),span=Math.max(1,end-start),left=spec.type==="gantt"?184:48,right=width-48;
  if(right-left<192)throw Error("Dated diagram cannot fit readable labels; use summary and Open diagram");const x=(date:string)=>left+(day(date)-start)/span*(right-left);
  if(spec.type==="timeline"){
   height=360;line("time-axis",left,180,right,180);dated.forEach((event,i)=>{const n=nodes.find(n=>n.id===event.node)!,cx=x(event.start),above=i%2===0,y=above?112:248;line("event-drop",cx,180,cx,above?y+8:y-24,"lifeline");add("circle","event",cx,180,focal.has(n.id)?"focal":"line",{radius:focal.has(n.id)?6:4,node:n.id});const w=typeWidthBudget(n.label,"name"),tx=Math.min(Math.max(cx,left+w/2),right-w/2);if(w>right-left)throw Error("Timeline label cannot fit");txt(n.label,tx,y,"name",focal.has(n.id)?"focal":"line","middle");elements.at(-1)!.node=n.id;txt(axis?event.start:`ORDER ${i+1}`,tx,y+16,"label","line","middle");elements.at(-1)!.node=n.id;});txt(axis?"DATE · UTC":"ORDER · DATES NOT PROVIDED",left,328);
  }else{
   height=104+dated.length*48;line("time-axis",left,56,right,56);txt(axis?dated[0]?.start??"DATE":"ORDER · NO DATES",left,44);txt(axis?dated.reduce((max,e)=>e.end>max?e.end:max,dated[0]?.end??""):"",right,44,"label","line","end");
   const phases=axis?.kind==="gantt"?axis.phases??[]:[];
   for(const phase of phases){const rows=dated.map((t,i)=>t.phase===phase.id?i:-1).filter(i=>i>=0);if(rows.length){box("phase",16,64+Math.min(...rows)*48,width-32,(Math.max(...rows)-Math.min(...rows)+1)*48,"zone");txt(phase.label,24,76+Math.min(...rows)*48);}}
   dated.forEach((task,i)=>{const n=nodes.find(n=>n.id===task.node)!,y=80+i*48;txt(n.label,24,y+18,"name");elements.at(-1)!.node=n.id;if(typeWidthBudget(n.label,"name")>left-48)throw Error("Gantt row label cannot fit");box("task",x(task.start),y,Math.max(4,x(task.end)-x(task.start)),24,focal.has(n.id)?"focal":"bar");elements.at(-1)!.node=n.id;});
   if(axis?.kind==="gantt"&&axis.marker){if(day(axis.marker)<start||day(axis.marker)>end)throw Error("Gantt marker must lie within the displayed date range");line("marker",x(axis.marker),56,x(axis.marker),height-24,"return");}
  }
 }
 const shapes=elements.map((item,index):DiagramShape=>{
 const common={kind:"shape" as const,id:`axis-${index}`,family:"axis" as const,name:item.name,x:item.x,y:item.y,width:item.width??0,height:item.height??0,paint:item.paint,edgeId:item.edgeId,nodeId:item.node,from:item.from,to:item.to};
 const arrow=item.head?{x:item.x2!,y:item.y2!,dx:item.shape==="path"?-1:Math.sign(item.x2!-item.x),dy:0,head:item.head}:undefined;
 if(item.shape==="text") {const role=item.textRole??"label",size=role==="name"?12:role==="note"?11:9.5,w=typeWidthBudget(item.text!,role==="note"?"name":role,size)+4;return {...common,shape:"text",text:item.text!,textRole:role,fontSize:size,width:w,height:12,x:item.x-(item.align==="middle"?w/2:item.align==="end"?w:0),y:item.y-9,align:item.align,paint:item.paint==="focal"?"accent":"text"};}
 if(item.shape==="line")return {...common,shape:"line",x1:item.x,y1:item.y,x2:item.x2!,y2:item.y2!,x:Math.min(item.x,item.x2!),y:Math.min(item.y,item.y2!),width:Math.abs(item.x2!-item.x),height:Math.abs(item.y2!-item.y),arrow};
 if(item.shape==="circle")return {...common,shape:"circle",cx:item.x,cy:item.y,radius:item.radius!,x:item.x-item.radius!,y:item.y-item.radius!,width:item.radius!*2,height:item.radius!*2,paint:item.paint==="focal"?"accent":"ink"};
 if(item.shape==="path")return {...common,shape:"path",d:item.path!,width:item.width??Math.abs(item.x2!-item.x),height:item.height??Math.abs(item.y2!-item.y),arrow};
 return {...common,shape:"rect",radius:item.radius,paint:item.paint==="mask"&&elements.some(zone=>zone.paint==="zone"&&item.x>=zone.x&&item.y>=zone.y&&item.x+(item.width??0)<=zone.x+(zone.width??0)&&item.y+(item.height??0)<=zone.y+(zone.height??0))?"cluster-mask":item.paint};
 });
 return {schema_version:1,type:spec.type,title:spec.title,desc:spec.desc,viewBox:{x:0,y:0,width,height:height+64},elements:[...shapes.filter(s=>s.paint==="zone").sort((a,b)=>b.width*b.height-a.width*a.height),...auxiliary,...shapes.filter(s=>s.paint!=="zone")]};
}
