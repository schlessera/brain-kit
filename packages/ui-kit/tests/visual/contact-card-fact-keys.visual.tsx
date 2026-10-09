/** Complete ContactCard fact text, measured in Chromium (#599). */
/// <reference types="@vitest/browser/matchers" />
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, expect, test } from "vitest";
import { page } from "vitest/browser";

import "../../src/styles.css";
import { ContactCard, type ContactFact } from "../../src/blocks/ContactCard.js";
import { penelopeFacts, poseidonFacts } from "../../fixtures/people.js";

const GAP = 10;
const LONG_KEY = "communication_preference";
const facts: ContactFact[] = [
  { k: LONG_KEY, v: "letters via Eumaeus" },
  { k: "home", v: "Ithaca" },
];
let host: HTMLDivElement | undefined;
let renderer: Root | undefined;
let viewport: { width: number; height: number };

beforeAll(async () => {
  // The shared setup has already installed and verified the pinned faces.
  await document.fonts.load('500 10.5px "JetBrains Mono"');
  await document.fonts.ready;
  expect(document.fonts.check('500 10.5px "JetBrains Mono"')).toBe(true);
});

beforeEach(async () => {
  viewport = { width: window.innerWidth, height: window.innerHeight };
  await page.viewport(800, 900);
});

afterEach(async () => {
  if (renderer) flushSync(() => renderer!.unmount());
  host?.remove();
  renderer = undefined;
  host = undefined;
  await page.viewport(viewport.width, viewport.height);
});

interface Cells { key: HTMLElement; value: HTMLElement }

function render(input: ContactFact[], keyWidth?: number, width = 288, theme = "dark"): Cells[] {
  host = document.createElement("div");
  host.style.width = `${width}px`;
  host.dataset.theme = theme;
  document.body.append(host);
  renderer = createRoot(host);
  flushSync(() => renderer!.render(<ContactCard facts={input} keyWidth={keyWidth} />));
  const values = [...host.querySelectorAll<HTMLElement>("[data-tone]")];
  expect(input.length, "the fact input is nonempty").toBeGreaterThan(0);
  expect(values).toHaveLength(input.length);
  return values.map(value => ({ key: value.previousElementSibling as HTMLElement, value }));
}

/** Measure every text node: inserted wbr elements must not hide later lines. */
function textRects(cell: HTMLElement): DOMRect[] {
  const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
  const rects: DOMRect[] = [];
  while (walker.nextNode()) {
    if (!walker.currentNode.textContent?.length) continue;
    const range = document.createRange();
    range.selectNodeContents(walker.currentNode);
    rects.push(...[...range.getClientRects()].filter(rect => rect.width > 0));
  }
  expect(rects.length, `nonempty glyph rectangles for ${cell.textContent}`).toBeGreaterThan(0);
  return rects;
}

function lines(cell: HTMLElement) {
  return new Set(textRects(cell).map(rect => Math.round(rect.top))).size;
}

/** A text-node boundary is not a line boundary: inspect every rendered glyph. */
function firstLineText(cell: HTMLElement): string {
  const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
  let top: number | undefined;
  let text = "";
  while (walker.nextNode()) {
    const node = walker.currentNode;
    for (let i = 0; i < (node.textContent?.length ?? 0); i++) {
      const range = document.createRange();
      range.setStart(node, i);
      range.setEnd(node, i + 1);
      const rect = [...range.getClientRects()].find(rect => rect.width > 0);
      expect(rect, "every source character is rendered").toBeDefined();
      top ??= rect!.top;
      if (rect!.top === top) text += node.textContent![i];
    }
  }
  return text;
}

/** Glyph advances are measured from the loaded face, never inferred from ems. */
function intrinsicWidth(text: string, cell: HTMLElement): number {
  const probe = document.createElement("span");
  probe.style.font = getComputedStyle(cell).font;
  probe.style.whiteSpace = "pre";
  probe.textContent = text;
  document.body.append(probe);
  try { return textRects(probe)[0]!.width; }
  finally { probe.remove(); }
}

function expectGutter(cells: Cells[]) {
  for (const { key, value } of cells) {
    if (!key.textContent || !value.textContent) continue;
    const right = Math.max(...textRects(key).map(rect => rect.right));
    const left = Math.min(...textRects(value).map(rect => rect.left));
    expect(left - right, `glyph gutter for ${key.textContent}`).toBeGreaterThanOrEqual(GAP - 0.5);
    const cue = value.querySelector("[data-cue]");
    if (cue) expect(cue.getBoundingClientRect().left - right, "cue also clears key glyphs").toBeGreaterThanOrEqual(GAP - 0.5);
  }
}

function expectComplete(cells: Cells[], input: ContactFact[], contained = true) {
  expect(new Set(cells.map(({ value }) => value.getBoundingClientRect().left)).size, "one aligned value edge").toBe(1);
  cells.forEach(({ key, value }, i) => {
    expect(key.textContent, "complete key").toBe(input[i]!.k);
    expect(value.textContent, "complete value").toBe(input[i]!.v);
    for (const cell of [key, value]) {
      expect(cell.getAttribute("title"), "no hover-only text").toBeNull();
      expect(cell.getAttribute("aria-hidden"), "text remains accessible").not.toBe("true");
      const range = document.createRange();
      range.selectNodeContents(cell);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      expect(selection.toString(), "selectable source text").toBe(cell.textContent);
      selection.removeAllRanges();
      if (contained) {
        expect(cell.scrollWidth, "cell does not overflow").toBeLessThanOrEqual(cell.clientWidth + 1);
        if (cell.textContent) for (const rect of textRects(cell)) {
          const box = cell.getBoundingClientRect();
          expect(rect.right, "glyphs stay within their cell").toBeLessThanOrEqual(box.right + 0.5);
          expect(rect.bottom, "wrapped lines stay within their cell").toBeLessThanOrEqual(box.bottom + 0.5);
        }
      }
    }
  });
  if (contained) {
    const card = host!.firstElementChild as HTMLElement;
    expect(card.scrollWidth, "card does not overflow").toBeLessThanOrEqual(card.clientWidth + 1);
    expect(document.documentElement.scrollWidth, "page does not overflow").toBeLessThanOrEqual(document.documentElement.clientWidth + 1);
  }
}

for (const theme of ["dark", "light"]) {
  for (const width of [288, 320, 640]) {
    test(`${theme} ${width}: communication_preference keeps the glyph gutter`, () => {
      const cells = render(facts, undefined, width, theme);
      // This is deliberately first: the original defect must fail on glyphs,
      // not on a later grid, line-count or containment assertion.
      expectGutter(cells);
      expectComplete(cells, facts);
      expect(cells[0]!.key.getBoundingClientRect().width).toBe(92);
      expect(lines(cells[0]!.key)).toBe(2);
      expect(firstLineText(cells[0]!.key), "preferred separator first line").toBe("communication_");
      expect(textRects(cells[0]!.key)[0]!.width, "preferred separator line").toBe(intrinsicWidth("communication_", cells[0]!.key));
      expect(cells[0]!.key.getBoundingClientRect().height).toBe(31.5);
      expect(cells[1]!.key.getBoundingClientRect().height, "only wrapped rows grow").toBe(15.75);
      if (width === 288) expect(cells[0]!.value.getBoundingClientRect().width).toBe(160);
    });
  }

  for (const floor of [40, 72, 84, 92, 120]) {
    test(`${theme} floor ${floor}: one capped column, independent of fact order`, () => {
      const input = [facts[1]!, facts[0]!, { k: "communicationpreference", v: "Ithaca" }];
      const cells = render(input, floor, 288, theme);
      expectGutter(cells);
      expectComplete(cells, input);
      const expected = Math.max(92, floor);
      for (const { key, value } of cells) {
        expect(key.getBoundingClientRect().width).toBe(expected);
        expect(value.getBoundingClientRect().left - host!.getBoundingClientRect().left).toBe(13 + expected + GAP);
      }
      expect(lines(cells[1]!.key)).toBe(2);
      expect(lines(cells[2]!.key), "emergency wrapping of an unbroken key").toBe(2);
    });
  }

  for (const [label, invalid] of [
    ["absent", undefined], ["zero", 0], ["negative", -40], ["NaN", NaN],
    ["positive infinity", Infinity], ["negative infinity", -Infinity],
    ["numeric string", "72" as unknown as number], ["null", null as unknown as number],
  ] as const) {
    test(`${theme} ${label}: invalid width normalizes to the 84px floor`, () => {
      const input = [{ k: "home", v: "Ithaca" }, { k: "at", v: "the hall" }];
      const cells = render(input, invalid, 288, theme);
      expect(cells[0]!.key.getBoundingClientRect().width, "finite fallback floor").toBe(84);
      expectComplete(cells, input);
      expectGutter(cells);
    });
  }

  for (const floor of [72, 84]) {
    test(`${theme} floor ${floor}: fitting facts preserve value edge and row pitch`, () => {
      const input = [{ k: "home", v: "Ithaca" }, { k: "at", v: "the hall" }];
      const cells = render(input, floor, 320, theme);
      expect(cells[0]!.value.getBoundingClientRect().left - host!.getBoundingClientRect().left, "fitting value edge").toBe(13 + floor + GAP);
      expect(textRects(cells[1]!.key)[0]!.top - textRects(cells[0]!.key)[0]!.top, "fitting row pitch").toBe(20.75);
      for (const { key, value } of cells) {
        expect(key.getBoundingClientRect().width).toBe(floor);
        expect(key.getBoundingClientRect().height).toBe(15.75);
        expect(value.getBoundingClientRect().height).toBe(15.75);
        expect(lines(key)).toBe(1);
      }
      expectComplete(cells, input);
    });
  }

  test(`${theme}: between floor and cap the widest intrinsic key sizes the column`, () => {
    const input = [{ k: "communication", v: "letters" }, { k: "home", v: "Ithaca" }];
    const cells = render(input, 72, 288, theme);
    const intrinsic = textRects(cells[0]!.key)[0]!.width;
    expect(intrinsic).toBeGreaterThan(72);
    expect(intrinsic).toBeLessThan(92);
    for (const { key } of cells) expect(key.getBoundingClientRect().width).toBeCloseTo(intrinsic, 2);
    expectGutter(cells);
    expectComplete(cells, input);
  });

  test(`${theme}: an unbroken key wraps into readable lines`, () => {
    const input = [{ k: "communicationpreference", v: "Ithaca" }];
    const cells = render(input, undefined, 288, theme);
    expect(lines(cells[0]!.key), "emergency key wrapping").toBe(2);
    expectGutter(cells);
    expectComplete(cells, input);
  });

  for (const width of [288, 320, 640]) test(`${theme} ${width}: long values wrap, empty keys and values stay honest`, () => {
    const input: ContactFact[] = [
      { k: LONG_KEY, v: "Ithaca" },
      { k: "seal", v: "a".repeat(128) },
      { k: "unknown", v: "" },
      { k: "", v: "Eumaeus" },
      { k: "oath", v: "b".repeat(128), tone: "red" },
    ];
    const cells = render(input, undefined, width, theme);
    expect(intrinsicWidth(input[1]!.v, cells[1]!.value), "fixture text genuinely exceeds its track").toBeGreaterThan(cells[1]!.value.getBoundingClientRect().width);
    expect(lines(cells[1]!.value), "unbroken value has multiple readable lines").toBeGreaterThan(1);
    expect(textRects(cells[1]!.value)[0]!.top).toBe(textRects(cells[1]!.key)[0]!.top);
    expect(cells[2]!.value.textContent, "empty value has no invented placeholder").toBe("");
    expect(cells[2]!.key.getBoundingClientRect().height).toBe(15.75);
    expect(cells[3]!.key.textContent).toBe("");
    expectGutter(cells);
    expectComplete(cells, input);
  });

  for (const separator of ["_", "-", ".", "/"]) {
    test(`${theme}: preferred wrapping after ${separator}`, () => {
      const key = `communication${separator}preference`;
      const input = [{ k: key, v: "letters" }];
      const cells = render(input, undefined, 288, theme);
      expect(firstLineText(cells[0]!.key), "preferred separator first line").toBe(`communication${separator}`);
      expect(textRects(cells[0]!.key)[0]!.width, "preferred separator line").toBe(intrinsicWidth(`communication${separator}`, cells[0]!.key));
      expect(lines(cells[0]!.key)).toBe(2);
      expectComplete(cells, input);
    });
  }

  test(`${theme}: an oversized positive floor remains the caller's responsibility`, () => {
    const input = [{ k: "home", v: "Ithaca" }];
    const cells = render(input, 1000, 288, theme);
    expect(cells[0]!.key.getBoundingClientRect().width, "explicit positive floor is not clamped").toBe(1000);
    expect(cells[0]!.value.getBoundingClientRect().width, "no fictitious minimum value allocation").toBe(0);
    expect((host!.firstElementChild as HTMLElement).scrollWidth, "caller-supplied overflow is observable").toBeGreaterThan(288);
    expectComplete(cells, input, false);
  });

  for (const [label, input, width] of [
    ["default", penelopeFacts, 288], ["hostile", poseidonFacts, 288], ["wide", penelopeFacts, 640],
  ] as const) {
    test(`${theme} ${label}: incumbent fitting pixels`, async () => {
      render(input, undefined, width, theme);
      await expect(page.elementLocator(host!)).toMatchScreenshot(`contact-fitting-${label}-${theme}`, {
        comparatorOptions: { threshold: 0, allowedMismatchedPixels: 0, includeAA: true },
      });
    });
  }

  for (const width of [288, 640]) test(`${theme} ${width}: approved long fact key pixels`, async () => {
    const input = [...penelopeFacts, ...facts];
    const cells = render(input, undefined, width, theme);
    expectGutter(cells);
    expectComplete(cells, input);
    await expect(page.elementLocator(host!)).toMatchScreenshot(`contact-long-key-${theme}-${width}`);
  });
}
