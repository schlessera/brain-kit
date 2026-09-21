// Render tests for classified blocks (D42): a table swaps to a comparison
// block at its span, the markdown around it survives, a message without
// blocks renders exactly as before, and an anchor that does not fit the text
// is ignored. Props-only, keyless, mounted in happy-dom. Queries come from
// `render()`, never `screen` — see tests/render/dom.ts for why.
import { unregisterClassifiedBlocksDom } from "./classified-blocks-dom.js";

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import type { MessageBlock } from "@schlessera/brain-ui-sdk/protocol";

import { MarkdownContent, usableBlocks } from "../../src/components/chat/markdown-content.js";

afterEach(cleanup);
afterAll(unregisterClassifiedBlocksDom);

const TABLE = `| | Ithaca | Pylos |
|---|---|---|
| Days at sea | 0 | 4 |
| Host | Penelope | Nestor |`;

const TEXT = `Two ways home.\n\n${TABLE}\n\nPick Ithaca if the crew will hold.`;

const comparison: MessageBlock = {
  partIndex: 0,
  start: TEXT.indexOf(TABLE),
  end: TEXT.indexOf(TABLE) + TABLE.length,
  confidence: 0.9,
  block: {
    kind: "comparison",
    columns: [{ label: "Ithaca" }, { label: "Pylos" }],
    rows: [
      { label: "Days at sea", cells: ["0", "4"] },
      { label: "Host", cells: ["Penelope", "Nestor"] },
    ],
  },
};

describe("MarkdownContent with classified blocks", () => {
  test("a message without blocks renders the plain markdown table, as before", () => {
    const { container } = render(<MarkdownContent content={TEXT} />);
    expect(container.querySelector("table")).not.toBeNull();
    expect(container.querySelector("[data-classified-block]")).toBeNull();
    expect(container.textContent).toContain("Two ways home.");
    expect(container.textContent).toContain("Pick Ithaca");
  });

  test("a classified table draws the kit block at its span, with the prose around it intact", () => {
    const { container } = render(<MarkdownContent content={TEXT} blocks={[comparison]} />);
    expect(container.querySelector("table")).toBeNull();
    expect(container.querySelector('[data-classified-block="comparison"]')).not.toBeNull();
    expect(container.querySelector('[data-block="comparison"]')).not.toBeNull();
    const text = container.textContent ?? "";
    expect(text).toContain("Two ways home.");
    expect(text).toContain("Days at sea");
    expect(text).toContain("Nestor");
    expect(text).toContain("Pick Ithaca");
    // Order: prose, block, prose.
    expect(text.indexOf("Two ways home.")).toBeLessThan(text.indexOf("Days at sea"));
    expect(text.indexOf("Days at sea")).toBeLessThan(text.indexOf("Pick Ithaca"));
  });

  test("an anchor that does not fit the text is ignored, never a blank", () => {
    const stale: MessageBlock = { ...comparison, start: 5, end: TEXT.length + 40 };
    const { container } = render(<MarkdownContent content={TEXT} blocks={[stale]} />);
    expect(container.querySelector("table")).not.toBeNull();
    expect(container.querySelector("[data-classified-block]")).toBeNull();
  });

  test("overlapping anchors keep the first; out-of-range ones drop", () => {
    const a: MessageBlock = { ...comparison, start: 0, end: 10 };
    const b: MessageBlock = { ...comparison, start: 5, end: 20 };
    const c: MessageBlock = { ...comparison, start: 20, end: 30 };
    const bad: MessageBlock = { ...comparison, start: 30, end: 25 };
    expect(usableBlocks("x".repeat(40), [c, b, a, bad])).toEqual([a, c]);
    expect(usableBlocks("short", [comparison])).toEqual([]);
    expect(usableBlocks(TEXT, undefined)).toEqual([]);
  });
});
