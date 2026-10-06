/**
 * The `tracker` block through `show_block`'s schema, handler and contract
 * (#1001). An event carries a url, an action, a title and an optional
 * qualifier and nothing else: the item's repository, number and type are the
 * kit's to derive from the url (D1), so a payload stating them is rejected
 * with the key named. Each url passes the link policy as a `link` block's
 * does, and the rejection names which event failed.
 */
import { describe, expect, test } from "bun:test";

import { SHOW_BLOCK_CONTRACT, parseToolPayload } from "../src/client/index.js";
import { handleShowBlock } from "../src/server/index.js";
import {
  BLOCK_SCHEMA,
  SHOW_BLOCK_DESCRIPTION,
  SHOW_BLOCK_INPUT_SCHEMA,
  type ShowBlockInput,
} from "../src/tool-contracts/index.js";

const event = (extra: Record<string, unknown> = {}) => ({
  url: "https://github.com/ithaca/hall/pull/21",
  action: "merged",
  title: "Restore the bow to the great hall",
  ...extra,
});

const tracker = (events: unknown[]) => ({ block: { kind: "tracker", events } }) as ShowBlockInput;

/** The first issue zod reports, as `path: message`. */
function rejection(schema: typeof SHOW_BLOCK_INPUT_SCHEMA, input: unknown): string {
  const result = schema.safeParse(input);
  expect(result.success).toBe(false);
  const issue = result.error!.issues[0]!;
  return `${issue.path.join(".")}: ${issue.message}`;
}

describe("show_block: tracker", () => {
  test("accepts 1 to 20 events and echoes them unchanged", () => {
    const one = tracker([event()]);
    expect(handleShowBlock(one)).toEqual(one);
    const mixed = tracker([
      event({ url: "https://github.com/ithaca/hall/issues/12", action: "opened", title: "Suitors overstay" }),
      event(),
      event({ url: "https://github.com/ithaca/hall/issues/9", action: "closed", qualifier: "not planned", title: "Weave a second shroud" }),
      event({ url: "https://tracker.ogygia-shipyard.example/t/4", action: "opened", title: "Order pine for the raft" }),
    ]);
    expect(handleShowBlock(mixed)).toEqual(mixed);
    const twenty = tracker(Array.from({ length: 20 }, (_, i) => event({ url: `https://github.com/ithaca/hall/issues/${i + 1}` })));
    expect(SHOW_BLOCK_INPUT_SCHEMA.safeParse(twenty).success).toBe(true);
  });

  test("rejects an empty list and a 21st event", () => {
    expect(rejection(SHOW_BLOCK_INPUT_SCHEMA, tracker([]))).toContain("block.events");
    const many = tracker(Array.from({ length: 21 }, () => event()));
    expect(rejection(SHOW_BLOCK_INPUT_SCHEMA, many)).toContain("block.events");
  });

  test("rejects an event without a url or a known action", () => {
    const { url: _url, ...noUrl } = event();
    expect(rejection(SHOW_BLOCK_INPUT_SCHEMA, tracker([noUrl]))).toStartWith("block.events.0.url:");
    expect(rejection(SHOW_BLOCK_INPUT_SCHEMA, tracker([event({ url: "" })]))).toStartWith("block.events.0.url:");
    const { action: _action, ...noAction } = event();
    expect(rejection(SHOW_BLOCK_INPUT_SCHEMA, tracker([noAction]))).toStartWith("block.events.0.action:");
    expect(rejection(SHOW_BLOCK_INPUT_SCHEMA, tracker([event({ action: "deleted" })]))).toStartWith("block.events.0.action:");
  });

  test("rejects an event that states its repository, number or type, naming the key", () => {
    for (const [key, value] of [
      ["repository", "ithaca/hall"],
      ["repo", "ithaca/hall"],
      ["number", 21],
      ["type", "pull_request"],
      ["host", "github.com"],
    ] as const) {
      // Both the model's call and the client's render parse refuse it, so a
      // stated identity reaches no pill by either path.
      for (const schema of [SHOW_BLOCK_INPUT_SCHEMA, SHOW_BLOCK_INPUT_SCHEMA.extend({ block: BLOCK_SCHEMA })]) {
        const message = rejection(schema, tracker([event({ [key]: value })]));
        expect(message).toStartWith("block.events.0:");
        expect(message).toContain(key);
      }
    }
  });

  test("a title and a qualifier are one line", () => {
    expect(rejection(SHOW_BLOCK_INPUT_SCHEMA, tracker([event({ title: "two\nlines" })]))).toContain("one line");
    expect(rejection(SHOW_BLOCK_INPUT_SCHEMA, tracker([event({ qualifier: "not\nplanned" })]))).toContain("one line");
    expect(rejection(SHOW_BLOCK_INPUT_SCHEMA, tracker([event({ title: "  " })]))).toStartWith("block.events.0.title:");
  });

  test("a url the link policy refuses is a rejected call that names the event and the reason", () => {
    const cases: [string, string][] = [
      ["javascript:alert(1)", "scheme"],
      ["/ithaca/hall/issues/12", "relative"],
      ["https://odysseus:nobody@github.com/ithaca/hall/issues/12", "credentials"],
      ["https://github.com/ithaca/hall/issues/12\u202E", "hidden-characters"],
    ];
    for (const [url, reason] of cases) {
      const input = tracker([event(), event({ url })]);
      expect(() => handleShowBlock(input)).toThrow(`refused tracker event 2: ${reason}`);
    }
  });

  test("the client parse is structural: a refused url still parses, for the withheld pill", () => {
    const input = tracker([event({ url: "javascript:alert(1)" })]);
    expect(parseToolPayload(SHOW_BLOCK_CONTRACT, JSON.stringify(input))).toEqual(input);
    expect(parseToolPayload(SHOW_BLOCK_CONTRACT, JSON.stringify(tracker([event({ number: 21 })])))).toBeNull();
  });

  test("the description tells the model to use it instead of prose, and never to state identity", () => {
    const line = SHOW_BLOCK_DESCRIPTION.split("\n").find((text) => text.startsWith("tracker:"));
    expect(line).toBeDefined();
    expect(line).toContain("instead of listing tracker changes in prose");
    expect(line).toContain("Never state the repository, number or type");
  });
});
