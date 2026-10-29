import { expect, test } from "bun:test";
import { rehypeMarkdownRange } from "../src/components/chat/markdown-range.js";

interface Node {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: Node[];
  position?: { start: { offset: number }; end: { offset: number } };
}
const position = (start: number, end: number) => ({ start: { offset: start }, end: { offset: end } });

for (const [name, properties, reset, expected] of [
  ["non-default start", { start: 3, type: "I" }, undefined, [5, 6]],
  ["reversed default", { reversed: true, type: "A" }, undefined, [2, 1]],
  ["explicit item reset", { start: 3, type: "I" }, 9, [10, 11]],
] as const) test(`ordered range retains HTML list metadata: ${name}`, () => {
  const source = "A B C D";
  const list: Node = {
    type: "element", tagName: "ol", properties: { ...properties, className: ["watch"] }, position: position(0, 7),
    children: [..."ABCD"].map((value, index) => ({
      type: "element", tagName: "li", properties: index === 1 && reset !== undefined ? { value: reset } : {}, position: position(index * 2, index * 2 + 1),
      children: [{ type: "text", value, position: position(index * 2, index * 2 + 1) }],
    })),
  };
  const original = structuredClone(list);
  const tree: Node = { type: "root", children: [list] };
  rehypeMarkdownRange({ source, start: 4, end: 7, fileLinks: false })(tree);
  const selected = tree.children![0]!;
  expect(selected.properties).toMatchObject({ ...properties, className: ["watch"], start: expected[0] });
  expect(selected.children!.map(item => item.properties?.value)).toEqual([...expected]);
  expect(selected.children!.map(item => item.children![0]!.value)).toEqual(["C", "D"]);
  expect(list).toEqual(original);
});
