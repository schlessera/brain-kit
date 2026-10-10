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
 *
 * A `tracker` block's events get the same check, each `url` on its own, and
 * the rejection names the event by its position so the model can fix that
 * one (#1001). The pill list draws a refused one that reaches it as withheld.
 *
 * @experimental Backend toolkit (#1399); may change before 1.0.
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
  if (payload.block.kind === "tracker") {
    payload.block.events.forEach((event, i) => {
      const verdict = classifyLink(event.url);
      if (!verdict.ok) {
        throw new Error(
          `show_block refused tracker event ${i + 1}: ${verdict.reason} (${refusalSentence(verdict)}). ` +
            "Use the item's absolute https address with no user:password@, or leave the event out."
        );
      }
    });
  }
  return payload;
}
