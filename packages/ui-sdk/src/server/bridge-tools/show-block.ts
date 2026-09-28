import { classifyLink, refusalSentence } from "@schlessera/brain-ui-kit/links";

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
 *
 * A `link` block is validated twice over: by its schema, and by
 * `classifyLink`, the same function the card calls on its `url`. An address
 * the policy refuses (relative, not http(s), carrying credentials, invisible
 * characters, mixed scripts) is a rejected call like a schema failure, with
 * the reason, so the model can fix it and an echoed payload is always one the
 * policy accepts (the ruling on #43). The card still classifies on its own and
 * draws a withheld card for anything that reaches it anyway.
 */
export function handleShowBlock(input: ShowBlockInput): ShowBlockPayload {
  const payload = SHOW_BLOCK_INPUT_SCHEMA.parse(input);
  if (payload.block.kind === "link") {
    const verdict = classifyLink(payload.block.url);
    if (!verdict.ok) {
      throw new Error(
        `show_block refused the link: ${verdict.reason} (${refusalSentence(verdict)}). ` +
          "Use an absolute http(s) address with no user:password@, or leave the link out."
      );
    }
  }
  return payload;
}
