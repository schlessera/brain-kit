import { expect, test } from "bun:test";
import { createShowBlockTool } from "../packages/ui-backend-claude/src/show-block-tool";
import { createPiBridgeTools } from "../packages/ui-backend-pi/src/bridge-tools";
import { SHOW_BLOCK_CONTRACT, parseToolPayload } from "../packages/ui-sdk/src/tool-contracts/index";
import { showBlockInputSchema } from "../packages/ui-sdk/src/tool-contracts/blocks";
import { listedTool, SCHEMA_ARMS } from "../scripts/show-block-schema-forms";

const valid = { block: { kind: "suggestions" as const, label: "Ask next", items: [{ label: "Who was on watch then?", icon: "ask" }] } };
const claude = createShowBlockTool();
const pi = createPiBridgeTools({ brainPath: "/unused-fixture", turn: {} as never }).find(t => t.name === "show_block")!;

for (const level of ["block", "item"] as const) {
  const input = level === "block"
    ? { block: { ...valid.block, extra: "block-sentinel" } }
    : { block: { ...valid.block, items: [{ ...valid.block.items[0]!, tone: "amber" }] } };
  test(`Claude new call rejects unknown ${level} fields with nonempty valid items`, async () => {
    expect(input.block.items).toHaveLength(1);
    expect(input.block.items[0]!.label.length).toBeGreaterThan(4);
    expect(JSON.stringify(input)).toContain(level === "block" ? "block-sentinel" : "amber");
    const result = await claude.handler(input as never, {});
    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({ type: "text" });
    expect(JSON.stringify(result.content)).toContain("Unrecognized key");
  });
  test(`pi new call rejects unknown ${level} fields with nonempty valid items`, async () => {
    expect(input.block.items).toHaveLength(1);
    expect(input.block.items[0]!.label.length).toBeGreaterThan(4);
    expect(JSON.stringify(input)).toContain(level === "block" ? "block-sentinel" : "amber");
    await expect(pi.execute("fixture-call", input, undefined, undefined, {} as never)).rejects.toThrow("Unrecognized key");
  });
  test(`stored suggestions discard unknown ${level} fields and retain nonempty data`, () => {
    const output = JSON.stringify(input);
    expect(output).toContain(level === "block" ? "block-sentinel" : "amber");
    expect(parseToolPayload(SHOW_BLOCK_CONTRACT, output)).toEqual(valid);
  });
}

test("both actual handlers still echo supported suggestions", async () => {
  expect(valid.block.items).toHaveLength(1);
  const c = await claude.handler(valid as never, {});
  expect(c.isError).not.toBe(true);
  expect(JSON.parse((c.content[0] as { text: string }).text)).toEqual(valid);
  const p = await pi.execute("fixture-call", valid, undefined, undefined, {} as never);
  expect(p.details).toEqual(valid);
  const content = p.content[0]!;
  expect(content.type).toBe("text");
  if (content.type !== "text") throw new Error("Expected echoed text");
  expect(JSON.parse(content.text)).toEqual(valid);
});

interface InputSchema {
  properties: { block: { oneOf: Array<{
    properties: { kind: { const: string }; items: { items: { additionalProperties?: boolean } } };
    additionalProperties?: boolean;
  }> } };
}
for (const adapter of ["Claude MCP listing", "pi parameters"] as const) test(`${adapter} advertises strict suggestions at both levels`, async () => {
  const schema = (adapter === "Claude MCP listing" ? (await listedTool(claude)).inputSchema : pi.parameters) as unknown as InputSchema;
  const variant = schema.properties.block.oneOf.find(v => v.properties.kind.const === "suggestions");
  expect(variant).toBeDefined();
  expect(variant!.additionalProperties).toBe(false);
  expect(variant!.properties.items.items.additionalProperties).toBe(false);
});

test("every schema form rejects independent block and item extras on new calls", () => {
  for (const form of Object.values(SCHEMA_ARMS)) {
    const schema = showBlockInputSchema(form);
    expect(schema.safeParse(valid).success).toBe(true);
    expect(schema.safeParse({ block: { ...valid.block, extra: "block-sentinel" } }).success).toBe(false);
    expect(schema.safeParse({ block: { ...valid.block, items: [{ label: "Who was on watch then?", tone: "amber" }] } }).success).toBe(false);
  }
});

test("malformed stored suggestions still request generic fallback", () => {
  expect(parseToolPayload(SHOW_BLOCK_CONTRACT, JSON.stringify({ block: { kind: "suggestions", extra: "sentinel", items: [{ label: "x", tone: "amber" }] } }))).toBeNull();
});
