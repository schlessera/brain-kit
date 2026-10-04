import { expect, test } from "bun:test";
import { handleShowBlock } from "../src/server/index.js";
import { BLOCK_SCHEMA, showBlockInputSchema, type ShowBlockInput } from "../src/tool-contracts/blocks.js";

const input: ShowBlockInput = { block: { kind: "track", source: { path: ".brain-ui/inbox/00000000-0000-0000-0000-000000000000/ithaca-loop.gpx" }, title: "Ithaca loop" } };
test("every show_block schema form echoes a source-only track and cannot carry model-authored geometry or metrics", () => {
  expect(handleShowBlock(input)).toEqual(input);
  for (const sharedDefinitions of [false, true]) for (const restatedProse of [false, true]) {
    const schema = showBlockInputSchema({ sharedDefinitions, restatedProse });
    expect(schema.parse(input)).toEqual(input);
    const forged = schema.parse({ block: { ...input.block, coordinates: [[3,2]], metrics: { distance: 0 }, source: { path: input.block.kind === "track" ? input.block.source.path : "", lat: 90 } } });
    expect(forged).toEqual(input);
    expect(BLOCK_SCHEMA.safeParse({ kind: "track", source: { coordinates: [[3,2]] } }).success).toBe(false);
  }
});
