import {
  SHOW_BLOCK_INPUT_SCHEMA,
  type ShowBlockInput,
  type ShowBlockPayload,
} from "../../tool-contracts/index.js";

/**
 * `show_block` has no side effect and needs no bridge: the block is data the
 * model authored, and the surface draws it. The handler validates against the
 * contract and echoes the validated input as the payload, so an argument that
 * fits the schema is exactly what the client parses and renders.
 */
export function handleShowBlock(input: ShowBlockInput): ShowBlockPayload {
  return SHOW_BLOCK_INPUT_SCHEMA.parse(input);
}
