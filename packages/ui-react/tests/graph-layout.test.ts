import { expect, test } from "bun:test";
import { planGraph } from "../src/lib/graph-layout.js";
const nodes = Array.from({length:20},(_,i)=>({label:`Scylla ${i+1}`+(i===10?"s".repeat(60):""),focus:i===10}));
test("graph layout is deterministic, preserves indices and allocates bounded distinct positions",()=>{
  const plan=planGraph(nodes); expect(nodes).toHaveLength(20); expect(plan).toEqual(planGraph(structuredClone(nodes)));
  expect(plan.nodes.map(n=>n.label)).toEqual(nodes.map(n=>n.label));
  expect(plan.nodes[10]!.x).toBe(50); expect(plan.minHeight).toBeGreaterThan(240);
  expect(new Set(plan.nodes.map(n=>`${n.x}:${n.y}`)).size).toBe(20);
  for(const n of plan.nodes){expect(n.x).toBeGreaterThan(0);expect(n.x).toBeLessThan(100);expect(n.y).toBeGreaterThan(0);expect(n.y).toBeLessThan(100);}
});
test("a graph without focus has no fabricated focus and remains input-stable",()=>{
  const original=[{label:"Scylla"},{label:"Circe"}]; const copy=structuredClone(original);
  const plan=planGraph(original); expect(original).toEqual(copy); expect(plan.nodes.map(n=>n.focus)).toEqual([false,false]);expect(plan.nodes.map(n=>n.x)).toEqual([25,75]);
});
