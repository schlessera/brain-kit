import { expect, test } from "bun:test";
import { SHOW_BLOCK_INPUT_SCHEMA, showBlockInputSchema } from "../src/tool-contracts/blocks.js";

const input = { block: { kind: "files" as const, items: [
  { path: "knowledge/scylla.md", reason: "Names the cost in men." },
  { path: "people/circe.md", reason: "Gives the directions for the crossing." },
] } };

test("supporting files are accepted as nonempty data by every advertised show_block schema", () => {
  expect(input.block.items).toHaveLength(2);
  expect(SHOW_BLOCK_INPUT_SCHEMA.safeParse(input).success).toBe(true);
  for (const sharedDefinitions of [false, true]) for (const restatedProse of [false, true]) {
    expect(showBlockInputSchema({ sharedDefinitions, restatedProse }).parse(input)).toEqual(input);
  }
});

test("supporting file bounds reject empty/oversized lists and invalid path or reason fields", () => {
  const variants = [
    { items: [] },
    { items: Array.from({ length: 21 }, () => input.block.items[0]) },
    { items: [{ path: "" }] },
    { items: [{ path: "s".repeat(1025) }] },
    { items: [{ path: "knowledge/scylla.md", reason: "s".repeat(241) }] },
    { items: [{ path: "knowledge/scylla.md", reason: 42 }] },
    { items: "broken" },
  ];
  for (const fields of variants) expect(SHOW_BLOCK_INPUT_SCHEMA.safeParse({ block: { kind: "files", ...fields } }).success).toBe(false);
  expect(SHOW_BLOCK_INPUT_SCHEMA.safeParse({ block: { kind: "files", items: Array.from({ length: 20 }, () => input.block.items[0]) } }).success).toBe(true);
});

test("supporting files carry neither invented scores nor executable actions", () => {
  const forged = { block: { ...input.block, onClick: "run", items: input.block.items.map(item => ({ ...item, score: "99%", href: "https://ithaca.example" })) } };
  expect(SHOW_BLOCK_INPUT_SCHEMA.parse(forged)).toEqual(input);
  expect(SHOW_BLOCK_INPUT_SCHEMA.parse({ block: { kind: "files", items: [{ path: "knowledge/scylla.md" }] } })).toEqual({ block: { kind: "files", items: [{ path: "knowledge/scylla.md" }] } });
});
