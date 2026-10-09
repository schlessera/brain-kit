/**
 * The Receipt key column, measured in a real browser (#88).
 *
 * The key column was a fixed `keyWidth` box with `flex: none` and no overflow
 * rule, so a key longer than the box drew its glyphs over the 10px gutter and
 * into the value. The row's `gap` measures from the BOX edge, which is why a
 * test over boxes cannot see this: it measures the TEXT, one client rect per
 * line box, the way `receipt-value-budget.visual.tsx` counts lines.
 *
 * The rule (#88's design): the key column is as wide as the widest key in the
 * receipt, never narrower than `keyWidth` and never wider than 90px. A key
 * still longer than 90px wraps inside the column and is never cut. The value
 * column's left edge is therefore identical on every row.
 *
 * The shared browser setup loads checksum-pinned JetBrains Mono before
 * this fixture measures glyphs; no system-font alias is installed.
 *
 * It lives in the visual project because that is the runner with a layout
 * engine; it takes no screenshot.
 */
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, test } from "vitest";

import "../../src/styles.css";
import { Receipt, type ReceiptRow } from "../../src/evidence/Receipt.js";

/** The row gap the gutter must keep, between glyphs and not only boxes. */
const GAP = 10;
/** The widest the key column grows to. */
const KEY_MAX = 90;
/** The receipt box on a 320px phone (`receipt-value-budget.visual.tsx`). */
const PHONE = 288;
const DESKTOP = 640;

let host: HTMLDivElement | null = null;

afterEach(() => {
  host?.remove();
  host = null;
});

interface Cells {
  key: HTMLElement;
  value: HTMLElement;
}

function render(rows: ReceiptRow[], keyWidth: number | undefined, width = PHONE): Cells[] {
  host?.remove();
  host = document.createElement("div");
  host.style.width = `${width}px`;
  document.body.append(host);
  const root = host;
  flushSync(() => createRoot(root).render(<Receipt title="" footnote="" rows={rows} keyWidth={keyWidth} />));
  const values = [...root.querySelectorAll<HTMLElement>("[data-tone]")];
  expect(values).toHaveLength(rows.length);
  return values.map((value) => ({ key: value.previousElementSibling as HTMLElement, value }));
}

function textRects(cell: HTMLElement): DOMRect[] {
  const text = [...cell.childNodes].find((node) => node.nodeType === Node.TEXT_NODE);
  if (!text) throw new Error("the cell has no text node");
  const range = document.createRange();
  range.selectNodeContents(text);
  const rects = [...range.getClientRects()].filter((rect) => rect.width > 0);
  expect(rects.length).toBeGreaterThan(0);
  return rects;
}

/** Where the key's glyphs end and the value's begin, on the page. */
function glyphEdges({ key, value }: Cells) {
  return {
    keyRight: Math.max(...textRects(key).map((rect) => rect.right)),
    valueLeft: Math.min(...textRects(value).map((rect) => rect.left)),
    keyLines: new Set(textRects(key).map((rect) => Math.round(rect.top))).size,
  };
}

/** The gutter holds between glyphs, and every key is drawn whole. */
function expectSeparated(cells: Cells[]) {
  for (const cell of cells) {
    const { keyRight, valueLeft } = glyphEdges(cell);
    expect(valueLeft - keyRight, `"${cell.key.textContent}" runs into its value`).toBeGreaterThanOrEqual(GAP - 0.5);
    // The box agrees with the glyphs, so nothing is clipped either.
    expect(cell.key.scrollWidth).toBeLessThanOrEqual(cell.key.clientWidth);
    expect(cell.key.getBoundingClientRect().right + GAP).toBeLessThanOrEqual(cell.value.getBoundingClientRect().left + 0.5);
    expect(cell.key.textContent).not.toMatch(/…/);
  }
}

/** Every value starts at the same x: the column is still a column. */
function expectOneValueEdge(cells: Cells[]): number {
  const lefts = new Set(cells.map(({ value }) => Math.round(value.getBoundingClientRect().left)));
  expect(lefts.size).toBe(1);
  return [...lefts][0]!;
}

const overflowing: ReceiptRow[] = [
  { k: "tool", v: "fetch" },
  { k: "capability", v: "network.read" },
  { k: "signature", v: "ed25519:7b3d0c5e8a1f", tone: "teal" },
  { k: "arguments", v: "url, headers" },
  { k: "scope", v: "this run only" },
  { k: "hash", v: "9f2c4e7a1b0d3c85e6f4a2917b3d0c5e8a1f4b7c2d9e0a3f6b8c1d4e7a0b3c6f", tone: "red" },
];

describe("receipt: a key wider than its column keeps the gutter", () => {
  for (const keyWidth of [40, 56, 90]) {
    for (const [name, width] of [
      ["phone", PHONE],
      ["desktop", DESKTOP],
    ] as const) {
      test(`keyWidth ${keyWidth}, ${name}: "capability", "signature" and "arguments" stay clear of their values`, () => {
        const cells = render(overflowing, keyWidth, width);
        expectSeparated(cells);
        expectOneValueEdge(cells);
        const lines = cells.map((cell) => glyphEdges(cell).keyLines);
        // Each of these keys fits under the 90px cap, so none wraps.
        expect(lines).toEqual(overflowing.map(() => 1));
      });
    }
  }

  test("the default width is 56, and the column grows to the widest key", () => {
    const cells = render(overflowing, undefined);
    const key = cells[1]!.key;
    expect(key.textContent).toBe("capability");
    // 10 characters at the 7px advance.
    expect(textRects(key)[0]!.width).toBe(70);
    expect(key.getBoundingClientRect().width).toBe(70);
    expectSeparated(cells);
  });

  test("a key past the 90px cap wraps inside the column and is never cut", () => {
    const rows: ReceiptRow[] = [
      { k: "tool", v: "fetch" },
      { k: "subject_alt_names", v: "aeaea.example, ithaca.example" },
    ];
    const cells = render(rows, 90);
    expectSeparated(cells);
    expectOneValueEdge(cells);
    const [short, long] = cells as [Cells, Cells];
    expect(long.key.getBoundingClientRect().width).toBeLessThanOrEqual(KEY_MAX);
    expect(glyphEdges(long).keyLines).toBe(2);
    expect(long.key.textContent).toBe("subject_alt_names");
    // Only the row with the long key grows.
    expect(glyphEdges(short).keyLines).toBe(1);
  });
});

describe("receipt: keys that fit keep today's geometry", () => {
  for (const keyWidth of [56, 68, 78, 90]) {
    test(`keyWidth ${keyWidth}: the value starts at 1 + 12 + ${keyWidth} + 10`, () => {
      const rows: ReceiptRow[] = [
        { k: "tool", v: "fetch" },
        { k: "path", v: "voyage/aeaea-landing.md", tone: "teal" },
      ];
      const cells = render(rows, keyWidth);
      const left = host!.getBoundingClientRect().left;
      expect(expectOneValueEdge(cells) - left).toBe(1 + 12 + keyWidth + GAP);
      for (const { key, value } of cells) {
        expect(key.getBoundingClientRect().width).toBe(keyWidth);
        expect(key.getBoundingClientRect().left - left).toBe(1 + 12);
        // The cells are one line box high, with the padding outside them.
        expect(key.getBoundingClientRect().height).toBe(16.5);
        expect(value.getBoundingClientRect().height).toBe(16.5);
      }
      // Rows are 8 + 16.5 + 8 apart, measured on the text.
      const tops = cells.map(({ key, value }) => [textRects(key)[0]!.top, textRects(value)[0]!.top]);
      expect(tops[1]![0]! - tops[0]![0]!).toBe(32.5);
      expect(tops[1]![1]! - tops[0]![1]!).toBe(32.5);
    });
  }
});
