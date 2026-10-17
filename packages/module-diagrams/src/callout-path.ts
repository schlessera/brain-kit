import type { DiagramPoint } from "./geometry.js";
/** Sample only the concrete M/L/Q/circular-A paths emitted by the family builders. */
export function calloutPathPoints(path:string):DiagramPoint[]{
 const tokens=path.match(/[MLQA]|-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/gi)??[];let i=0,current={x:0,y:0};const points:DiagramPoint[]=[];
 const number=()=>Number(tokens[i++]);
 while(i<tokens.length){const command=tokens[i++];
  if(command==="M"||command==="L"){current={x:number(),y:number()};points.push(current);}
  else if(command==="Q"){
   const control={x:number(),y:number()},end={x:number(),y:number()},start=current;
   for(let j=1;j<=64;j++){const t=j/64;points.push({x:(1-t)**2*start.x+2*(1-t)*t*control.x+t*t*end.x,y:(1-t)**2*start.y+2*(1-t)*t*control.y+t*t*end.y});}current=end;
  }else if(command==="A"){
   const rx=number(),ry=number(),rotation=number(),large=number(),sweep=number(),end={x:number(),y:number()},start=current;
   if(rx!==ry||rotation!==0)throw Error("Unsupported generated annotation arc");
   const dx=(start.x-end.x)/2,dy=(start.y-end.y)/2,r=Math.max(rx,Math.hypot(dx,dy)),factor=(large===sweep?-1:1)*Math.sqrt(Math.max(0,(r*r-dx*dx-dy*dy)/(dx*dx+dy*dy))),cx=(start.x+end.x)/2+factor*dy,cy=(start.y+end.y)/2-factor*dx;
   const angle=Math.atan2(start.y-cy,start.x-cx);let delta=Math.atan2(end.y-cy,end.x-cx)-angle;if(sweep&&delta<0)delta+=2*Math.PI;if(!sweep&&delta>0)delta-=2*Math.PI;
   for(let j=1;j<=256;j++){const a=angle+delta*j/256;points.push({x:cx+r*Math.cos(a),y:cy+r*Math.sin(a)});}current=end;
  }else throw Error("Unsupported generated annotation path");
 }
 return points;
}
export function pointAlongCalloutPath(points:DiagramPoint[],fraction:number):DiagramPoint|undefined{
 const lengths=points.slice(1).map((point,i)=>Math.hypot(point.x-points[i]!.x,point.y-points[i]!.y));let remaining=lengths.reduce((sum,n)=>sum+n,0)*fraction;
 for(let i=0;i<lengths.length;i++){const length=lengths[i]!;if(remaining>length){remaining-=length;continue;}const a=points[i]!,b=points[i+1]!,t=length?remaining/length:0;return{x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t};}return points.at(-1);
}
