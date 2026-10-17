import type { DiagramSpec } from "./spec.js";
import type { DiagramFinding } from "./check.js";
export function checkAxis(spec:DiagramSpec):{errors:DiagramFinding[];warnings:DiagramFinding[]} {
 const errors:DiagramFinding[]=[],warnings:DiagramFinding[]=[];if(!("axis" in spec)||!spec.axis)return {errors,warnings};const axis=spec.axis;
 const error=(path:string,message:string)=>errors.push({path,code:"axis",message}), warn=(path:string,count:number,limit:number,noun:string)=>{if(count>limit)warnings.push({path,code:"budget",message:`${count} ${noun} exceeds the ${limit} default budget; split into overview and detail`});};
 if(axis.kind!==spec.type)error("$.axis.kind","Axis grammar must match the diagram type");
 const ids=new Set(spec.nodes.map(n=>n.id)), seen=new Set<string>();
 const ref=(id:string,path:string)=>{if(!ids.has(id))error(path,`Unknown node '${id}'`);};
 if(axis.kind==="sequence"){
  let focal=0;axis.messages.forEach((m,i)=>{ref(m.from,`$.axis.messages[${i}].from`);ref(m.to,`$.axis.messages[${i}].to`);if(seen.has(m.id)||ids.has(m.id))error(`$.axis.messages[${i}].id`,"Duplicate message id");seen.add(m.id);if(m.focal)focal++;warn(`$.axis.messages[${i}].label`,Array.from(m.label).length,14,"arrow-label characters");});
  if(focal+new Set([...(spec.focal??[]),...spec.nodes.filter(n=>n.role==="focal").map(n=>n.id)]).size>2)error("$.axis.messages","At most two focal messages are allowed");warn("$.axis.messages",axis.messages.length,12,"messages");warn("$.axis.messages",axis.messages.filter(m=>m.note).length,2,"notes");
  const fragments=axis.fragments??[];warn("$.axis.fragments",fragments.length,fragments.every(f=>f.kind!=="alt")?2:1,"combined fragments");
  fragments.forEach((f,i)=>{const path=`$.axis.fragments[${i}]`;if(f.from>f.to||f.to>=axis.messages.length)error(path,"Fragment range must name existing messages in order");if(f.kind==="alt"&&(f.elseAt===undefined||f.elseAt<=f.from||f.elseAt>f.to))error(path,"An alt needs exactly two nonempty regions divided by elseAt");if(f.kind!=="alt"&&(f.elseAt!==undefined||f.elseGuard!==undefined))error(path,"Only alt fragments have an else region");const depth=fragments.filter(other=>other!==f&&other.from<=f.from&&other.to>=f.to).length;warn(path,depth,1,"fragment nesting levels");for(const other of fragments.slice(0,i))if(f.from<=other.to&&f.to>=other.from&&!((f.from>=other.from&&f.to<=other.to)||(other.from>=f.from&&other.to<=f.to)))error(path,"Fragment ranges cannot partially overlap");});
 }
 if(axis.kind==="swimlane"){
  const lanes=new Set<string>();axis.lanes.forEach((lane,i)=>{if(lanes.has(lane.id))error(`$.axis.lanes[${i}]`,"Duplicate lane id");lanes.add(lane.id);});warn("$.axis.lanes",axis.lanes.length,5,"lanes");
  axis.steps.forEach((step,i)=>{ref(step.node,`$.axis.steps[${i}].node`);if(!lanes.has(step.lane))error(`$.axis.steps[${i}].lane`,"Unknown lane");if(seen.has(step.node))error(`$.axis.steps[${i}].node`,"A step has exactly one lane owner");seen.add(step.node);});for(const node of spec.nodes)if(!seen.has(node.id))error("$.axis.steps",`Missing lane ownership for '${node.id}'`);
 }
 if(axis.kind==="timeline")axis.events.forEach((event,i)=>{ref(event.node,`$.axis.events[${i}].node`);if(seen.has(event.node))error(`$.axis.events[${i}].node`,"Repeated event node");seen.add(event.node);if(i&&event.date<axis.events[i-1]!.date)error(`$.axis.events[${i}].date`,"Timeline dates must be ordered");});
 if(axis.kind==="gantt"){
  if(spec.edges.length)error("$.edges","Gantt dependency arrows are outside the v1 grammar");
  const phases=new Set<string>();axis.phases?.forEach((phase,i)=>{if(phases.has(phase.id))error(`$.axis.phases[${i}]`,"Duplicate phase id");phases.add(phase.id);});warn("$.axis.tasks",axis.tasks.length,12,"tasks");
  const finishedPhases=new Set<string>();let previousPhase:string|undefined;
  axis.tasks.forEach((task,i)=>{if(task.phase!==previousPhase){if(previousPhase)finishedPhases.add(previousPhase);if(task.phase&&finishedPhases.has(task.phase))error(`$.axis.tasks[${i}].phase`,"Phase rows must form a contiguous group");previousPhase=task.phase;}});
  axis.tasks.forEach((task,i)=>{ref(task.node,`$.axis.tasks[${i}].node`);if(seen.has(task.node))error(`$.axis.tasks[${i}].node`,"Repeated task node");seen.add(task.node);if(task.end<task.start)error(`$.axis.tasks[${i}].end`,"Task end precedes start");if(task.phase&&!phases.has(task.phase))error(`$.axis.tasks[${i}].phase`,"Unknown phase");});
  for(const phase of new Set(axis.tasks.map(t=>t.phase)))for(const task of axis.tasks.filter(t=>t.phase===phase)){const parallel=axis.tasks.filter(t=>t.phase===phase&&t.start<=task.start&&t.end>=task.start).length;warn("$.axis.tasks",parallel,5,"parallel tasks per phase");}
 }
 return {errors,warnings};
}
