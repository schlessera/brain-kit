/**
 * The `link` block through `show_block`'s handler and contract (#43).
 *
 * The handler rejects an address the kit's link policy refuses, with the
 * reason, and echoes an accepted one unchanged; a schema failure is rejected
 * as before. The contract's payload parse stays structural on purpose: a
 * refused address that reaches a client anyway (a replayed transcript, a
 * payload written under a looser policy) parses, so the card can draw it as
 * withheld instead of falling back to the generic view.
 */
import { describe, expect, test } from "bun:test";

import { SHOW_BLOCK_CONTRACT, parseToolPayload } from "../src/client/index.js";
import { handleShowBlock } from "../src/server/index.js";
import type { ShowBlockInput } from "../src/tool-contracts/index.js";

const link = (url: string, extra: Record<string, unknown> = {}) =>
  ({ block: { kind: "link", url, ...extra } }) as ShowBlockInput;

describe("show_block: link", () => {
  test("an accepted address is echoed unchanged", () => {
    const input = link("https://ithaca-harbour.example/tides", {
      title: "Harbour tide tables",
      description: "High water before dawn.",
    });
    expect(handleShowBlock(input)).toEqual(input);
  });

  test("a refused address is a rejected call that names the reason", () => {
    const cases: [string, string][] = [
      ["javascript:alert(1)", "scheme"],
      ["data:text/html,hi", "scheme"],
      ["/tides", "relative"],
      ["https://odysseus:nobody@ithaca-harbour.example/", "credentials"],
      ["https://\u0430pple.example/", "mixed-script"],
      ["https://ithaca-harbour.example/\u202E", "hidden-characters"],
    ];
    for (const [url, reason] of cases) {
      expect(() => handleShowBlock(link(url))).toThrow(`refused the link: ${reason}`);
    }
  });

  test("a schema failure is rejected before the policy runs", () => {
    expect(() => handleShowBlock(link(""))).toThrow();
    expect(() => handleShowBlock(link(`https://x.example/${"a".repeat(2048)}`))).toThrow();
    expect(() => handleShowBlock(link("https://x.example/", { title: "t".repeat(101) }))).toThrow();
    // The host is never a field: an unknown key is stripped, never echoed.
    const echoed = handleShowBlock(link("https://ithaca-harbour.example/", { host: "bank.example" }));
    expect(echoed.block).not.toHaveProperty("host");
  });

  test("the client parse is structural: a refused address still parses, for the withheld card", () => {
    const payload = parseToolPayload(SHOW_BLOCK_CONTRACT, JSON.stringify(link("javascript:alert(1)")));
    expect(payload).toEqual(link("javascript:alert(1)"));
    expect(parseToolPayload(SHOW_BLOCK_CONTRACT, JSON.stringify({ block: { kind: "link" } }))).toBeNull();
  });
});
