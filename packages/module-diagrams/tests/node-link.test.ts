import { expect, test } from "bun:test";
import { checkDiagram } from "../src/check.js";
import { assertSixRules, connectors } from "./geometry-assertions.js";
import { buildDiagram } from "../src/geometry.js";
import { diagramSpecSchema } from "../src/spec.js";
import { toStatic } from "../src/render.js";
const decision={schema_version:1,type:"flowchart",title:"Homecoming choice",desc:"Odysseus chooses a safe route.",size:"fit",nodes:[{id:"choice",label:"Safe route?",shape:"decision",at:[48,48],size:[240,144]}],edges:[]};
test("flowchart decisions render as diamonds and require labelled exits",async()=>{
 expect(checkDiagram(JSON.stringify(decision)).valid).toBe(true);
 expect(await toStatic(JSON.stringify(decision),{theme:"light"})).toContain('data-node-shape="decision"');
 const missing={...decision,nodes:[...decision.nodes,{id:"harbour",label:"Ithaca",at:[48,320],size:[240,64]}],edges:[{from:"choice",to:"harbour"}]};
 expect(checkDiagram(JSON.stringify(missing)).errors.some(item=>item.code==="decision_label")).toBe(true);
});

const examples=["architecture","flowchart","state-machine","tree","er","dependency","architecture-containment"] as const;
const example=async(name:string)=>Bun.file(new URL(`../skills/diagram/references/examples/${name}.diagram.yaml`,import.meta.url)).json();
for(const name of examples)test(`${name} example is accepted and renders safely in every theme`,async()=>{
 const spec=await example(name),source=JSON.stringify(spec),result=checkDiagram(source);
 expect(result,name).toMatchObject({valid:true,errors:[],warnings:[]});
 assertSixRules(diagramSpecSchema.parse(spec),buildDiagram(spec));
 for(const theme of ["light","dark","print"] as const){const svg=await toStatic(source,{theme});expect(svg).toContain(`data-theme="${theme}"`);expect(svg).not.toMatch(/<script|foreignObject|transform=/i);}
});
test("ER entities have mono fields and both relationship cardinalities without arrow heads",async()=>{
 const spec=await example("er"),svg=await toStatic(JSON.stringify(spec),{theme:"print"});expect(svg).toContain("# voyage_id");expect(svg).toContain("→ voyage_id");expect(svg).toContain('data-cardinality="0:from"');expect(svg).toContain('data-cardinality="0:to"');
 const edge=spec.edges[0];delete edge.toCardinality;expect(checkDiagram(JSON.stringify(spec)).errors.some(item=>item.code==="cardinality_pair")).toBe(true);
});
test("tree rejects shared parents and warns at the first excess child",async()=>{
 const spec=await example("tree");spec.edges.push({from:"voyage",to:"welcome"});expect(checkDiagram(JSON.stringify(spec)).errors.some(item=>item.code==="tree_parent")).toBe(true);
 spec.nodes=Array.from({length:7},(_,i)=>({id:`raft-${i}`,label:"Raft",at:[48+i*200,48],size:[160,48]}));spec.edges=Array.from({length:6},(_,i)=>({from:"raft-0",to:`raft-${i+1}`}));delete spec.focal;
 expect(checkDiagram(JSON.stringify(spec)).warnings.some(item=>item.message.includes("5 default budget"))).toBe(true);
});
test("every family budget warns at the first excess without dropping nodes",async()=>{
 const cases=[["architecture",10,9],["flowchart",10,9],["state-machine",10,9],["tree",10,9],["er",9,8],["dependency",10,9]] as const;
 for(const [type,count,limit] of cases){const spec={schema_version:1,type,title:"Homecoming",desc:"Odysseus prepares the homecoming.",size:"fit",nodes:Array.from({length:count},(_,i)=>({id:`raft-${i}`,label:"Raft",at:[i*200+24,48],size:[160,64]})),edges:[]};const result=checkDiagram(JSON.stringify(spec));expect(result.valid,type).toBe(true);expect(result.warnings.some(item=>item.message.includes(`${limit} default budget`)),type).toBe(true);const svg=await toStatic(JSON.stringify(spec),{theme:"light"});expect(svg.match(/data-diagram-node=/g)?.length,type).toBe(count);}
});
test("dependency cycles use outside routing, amber dashes, a label and computed fan-in",async()=>{
 const spec=await example("dependency"),source=JSON.stringify(spec),svg=await toStatic(source,{theme:"light"});expect(svg).toContain('data-fan-in="2"');expect(svg).toContain("2 IN");expect(svg).toContain("1 IN");expect(svg).toContain("CYCLE");expect(svg).toContain('stroke="var(--bk-amber-ink)"');
 const tree=buildDiagram(spec),cycle=connectors(tree)[0]!;expect(Math.max(...cycle.points.map(point=>point.x))).toBeGreaterThan(Math.max(...spec.nodes.map((node:{at:number[];size:number[]})=>node.at[0]!+node.size[0]!)));
 spec.edges[0].cycle=false;expect(checkDiagram(JSON.stringify(spec)).errors.some(item=>item.code==="dependency_rank")).toBe(true);
 const ranks=await example("dependency");ranks.nodes=Array.from({length:5},(_,i)=>({id:`raft-${i}`,label:"Raft",at:[48,i*160+48],size:[160,64],rank:i}));ranks.edges=[];expect(checkDiagram(JSON.stringify(ranks)).warnings.some(item=>item.message.includes("4 default budget"))).toBe(true);
});
test("containment proves authored hierarchy, endpoint targets, PaaS placement and sibling axes",async()=>{
 const original=await example("architecture-containment"),source=JSON.stringify(original),svg=await toStatic(source,{theme:"print"});expect(svg).toContain('data-grammar="architecture-containment"');expect(svg).toContain('data-scope-kind="admin"');expect(svg).toContain('data-scope-kind="traffic"');expect(svg).toContain('data-kind="endpoint"');expect(svg).toContain('data-peering="peering-2"');
 for(const mutate of [(s:any)=>{s.nodes[0].parent="homecoming"},(s:any)=>{s.nodes[1].target="hermes"},(s:any)=>{s.nodes[3].at=[64,128];s.nodes[3].parent="voyage-traffic"},(s:any)=>{s.containment.scopes[2].at[1]+=8},(s:any)=>{s.edges[2].to="ledger"}]){const spec=structuredClone(original);mutate(spec);expect(checkDiagram(JSON.stringify(spec)).errors.some(item=>item.code==="containment")).toBe(true);}
});

test("legacy shared-parent trees warn while explicit hierarchy rejects; breadth counts the whole level",async()=>{
 const spec=await example("tree");delete spec.hierarchy;spec.edges.push({from:"voyage",to:"welcome"});const legacy=checkDiagram(JSON.stringify(spec));expect(legacy.errors.some(item=>item.code==="tree_parent")).toBe(false);expect(legacy.warnings.some(item=>item.code==="tree_parent")).toBe(true);
 const wide={...spec,hierarchy:true,nodes:Array.from({length:9},(_,i)=>({id:`raft-${i}`,label:"Raft",at:[i*200+24,48],size:[160,48]})),edges:[{from:"raft-0",to:"raft-1"},{from:"raft-0",to:"raft-2"},...Array.from({length:6},(_,i)=>({from:i<3?"raft-1":"raft-2",to:`raft-${i+3}`}))]};expect(checkDiagram(JSON.stringify(wide)).warnings.some(item=>item.message.includes("tree items at level 3"))).toBe(true);
});

test("dependency entry nodes expose zero fan-in and fixed cycle canvases refuse clipping",async()=>{
 const spec=await example("dependency");spec.edges=[];expect(await toStatic(JSON.stringify(spec),{theme:"light"})).toContain("0 IN");
 const fixed=await example("dependency");fixed.size="doc-inline";fixed.nodes.forEach((node:{at:number[]})=>node.at[0]+=328);const result=checkDiagram(JSON.stringify(fixed));expect(result.errors.some(item=>item.code==="unroutable"&&item.message.includes("replan"))).toBe(true);
});

test("type-specific editorial budgets report their first excess",async()=>{
 const architecture=await example("architecture");architecture.groups=Array.from({length:4},(_,i)=>({id:`zone-${i}`,label:"ZONE",members:["hermes"]}));expect(checkDiagram(JSON.stringify(architecture)).warnings.some(item=>item.message.includes("3 default budget"))).toBe(true);
 const flow={...decision,edges:Array.from({length:4},()=>({from:"choice",to:"choice",label:"YES"}))};expect(checkDiagram(JSON.stringify(flow)).warnings.some(item=>item.message.includes("3 default budget"))).toBe(true);
 const state=await example("state-machine");state.nodes=state.nodes.slice(0,3);state.edges=Array.from({length:5},()=>({from:"planning",to:"sailing",label:"DEPART"}));expect(checkDiagram(JSON.stringify(state)).warnings.some(item=>item.message.includes("4 default budget"))).toBe(true);
 const dependency=await example("dependency");dependency.edges.push({...dependency.edges[0],id:"replan-again"});expect(checkDiagram(JSON.stringify(dependency)).warnings.some(item=>item.message.includes("1 default budget"))).toBe(true);
});
test("containment has ported nested perpendicular-axis and first-over-budget controls",async()=>{
 const nested=await example("architecture-containment");nested.edges=[];nested.containment.scopes=[{id:"homecoming",label:"HOMECOMING",kind:"admin",at:[24,24],size:[1000,600]},{id:"voyage-traffic",label:"VOYAGE",kind:"traffic",parent:"homecoming",at:[48,80],size:[500,480]},{id:"ithaca-traffic",label:"ITHACA",kind:"traffic",parent:"homecoming",at:[700,80],size:[280,480]},{id:"outward",label:"OUTWARD",kind:"traffic",parent:"voyage-traffic",at:[64,112],size:[464,160]},{id:"returning",label:"RETURNING",kind:"traffic",parent:"voyage-traffic",at:[64,320],size:[464,160]}];nested.nodes[0].at=[96,160];nested.nodes[0].parent="outward";nested.nodes[1].at=[96,368];nested.nodes[1].parent="returning";nested.nodes[2].at=[740,128];nested.nodes[3].at=[564,400];nested.nodes[3].size=[120,64];nested.nodes[3].label="Ledger";expect(checkDiagram(JSON.stringify(nested)).valid).toBe(true);nested.containment.scopes[4].at[0]+=4;expect(checkDiagram(JSON.stringify(nested)).errors.some(item=>item.code==="containment"&&item.message.includes("axis"))).toBe(true);
 const admin=await example("architecture-containment");admin.edges=[];admin.containment.scopes.push(...[900,1800].map((x,index)=>({id:`administration-${index}`,label:"ADMIN",kind:"admin",at:[x,24],size:[800,400]})));const adminResult=checkDiagram(JSON.stringify(admin));expect(adminResult.valid).toBe(true);expect(adminResult.warnings.some(item=>item.message.includes("2 default budget"))).toBe(true);
 const traffic=await example("architecture-containment");traffic.edges=[];traffic.containment.scopes[0].size[0]=2400;traffic.containment.scopes.push(...[900,1200,1500].map((x,index)=>({id:`traffic-${index}`,label:"TRAFFIC",kind:"traffic",parent:"homecoming",at:[x,80],size:[216,160]})));const trafficResult=checkDiagram(JSON.stringify(traffic));expect(trafficResult.valid).toBe(true);expect(trafficResult.warnings.some(item=>item.message.includes("4 default budget"))).toBe(true);
 const nodes=await example("architecture-containment");nodes.edges=[];nodes.containment.scopes[0].size[0]=2500;nodes.containment.scopes[1].size[0]=2000;nodes.containment.scopes[2].at[0]=2200;nodes.nodes[2].at=[2240,128];nodes.nodes.push(...[552,784,1016,1248,1480].map((x,index)=>({id:`relay-${index}`,label:"Relay",kind:"compute",parent:"voyage-traffic",at:[x,128],size:[160,64]})));const nodeResult=checkDiagram(JSON.stringify(nodes));expect(nodeResult.valid).toBe(true);expect(nodeResult.warnings.some(item=>item.message.includes("8 default budget"))).toBe(true);
});

test("an endpoint cannot target a compute node",async()=>{const spec=await example("architecture-containment");spec.nodes[1].target="hermes";expect(checkDiagram(JSON.stringify(spec)).errors.some(item=>item.code==="containment"&&item.path==="$.nodes[1].target"),"ENDPOINT_TARGET_MUST_BE_MANAGED").toBe(true);});

test("explicit dependency row misalignment and tight spacing warn without moving nodes",async()=>{
 const spec=await example("dependency");spec.nodes[2].at[1]+=4;const original=JSON.stringify(spec);expect(checkDiagram(original).warnings.some(item=>item.code==="rank_alignment")).toBe(true);expect(JSON.stringify(spec)).toBe(original);
 spec.nodes[1].at[1]=128;spec.nodes[2].at[1]=128;expect(checkDiagram(JSON.stringify(spec)).warnings.some(item=>item.code==="rank_spacing")).toBe(true);
});
