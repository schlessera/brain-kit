import { expect, test } from "bun:test";
import { SHOW_BLOCK_INPUT_SCHEMA, showBlockInputSchema } from "../src/tool-contracts/blocks.js";
const input = { block: { kind: "graph" as const, nodes: [{ label: "Scylla", path: "knowledge/scylla.md", focus: true }, { label: "Circe", tone: "teal" as const }], edges: [[0, 1] as [number,number]] } };
test("a nonempty agent-authored graph is accepted by every advertised schema", () => {
  expect(input.block.nodes).toHaveLength(2); expect(input.block.edges).toHaveLength(1);
  expect(SHOW_BLOCK_INPUT_SCHEMA.safeParse(input).success).toBe(true);
  for (const sharedDefinitions of [false,true]) for (const restatedProse of [false,true]) expect(showBlockInputSchema({sharedDefinitions,restatedProse}).parse(input)).toEqual(input);
});
test("graph bounds and index validation reject malformed supplied topology", () => {
  const nodes = input.block.nodes;
  for (const fields of [
    {nodes: nodes.slice(0,1)}, {nodes: Array.from({length:21},()=>nodes[0])},
    {edges:Array.from({length:41},()=>[0,1])}, {edges:[[0,2]]}, {edges:[[-1,1]]}, {edges:[[0,0]]}, {edges:[[0,0.5]]}, {edges:[[0,1,2]]},
    {nodes:[{label:""},nodes[1]]}, {nodes:[{label:"s".repeat(81)},nodes[1]]}, {title:"s".repeat(61)}, {meta:"s".repeat(41)},
  ]) expect(SHOW_BLOCK_INPUT_SCHEMA.safeParse({block:{...input.block,...fields}}).success).toBe(false);
  expect(SHOW_BLOCK_INPUT_SCHEMA.safeParse({block:{kind:"graph",nodes:Array.from({length:20},(_,i)=>({label:`Scylla ${i}`})),edges:Array.from({length:40},(_,i)=>[Math.floor(i/19),i%19+1])}}).success).toBe(false); // Includes a self-loop; edge validation is active at the maximum.
  expect(SHOW_BLOCK_INPUT_SCHEMA.safeParse({block:{kind:"graph",nodes:Array.from({length:20},(_,i)=>({label:`Scylla ${i}`})),edges:[]}}).success).toBe(true);
});
test("graph drops repeated and reversed edges, coordinates and later focus claims", () => {
  const value = SHOW_BLOCK_INPUT_SCHEMA.parse({block:{...input.block, nodes:input.block.nodes.map(node=>({...node,focus:true,x:99,y:99})), edges:[[0,1],[1,0],[0,1]],onClick:"run"}}).block;
  expect(value.kind).toBe("graph"); if(value.kind!=="graph") throw new Error("wrong kind");
  expect(value.edges).toEqual([[0,1]]); expect(value.nodes.map(node=>node.focus)).toEqual([true,false]);
  expect(Object.keys(value.nodes[0]!)).not.toContain("x"); expect(Object.keys(value)).not.toContain("onClick");
});
