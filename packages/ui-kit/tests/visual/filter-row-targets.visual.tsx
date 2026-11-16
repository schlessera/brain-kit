/// <reference types="@vitest/browser-playwright" />
/**
 * `FilterRow` reaches 44px by default (#4086, ruled on #3531).
 *
 * Runs in the rail-fine, rail-coarse and rail-mixed projects, each a native
 * pointer premise with no matchMedia mock. Under a coarse pointer every
 * interactive pill carries `.bk-hit`, keeps its 20.5px paint height, paints at
 * least 44px wide, and owns `elementFromPoint` 1px inside each edge of its
 * 44px target: at the strip's start, at its end, and beside a neighbour 6px
 * away. The strip clips only horizontally there, so the vertical reach is not
 * cut off. Under a fine pointer the pill is its paint, exactly as before.
 */
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, inject, test, vi } from "vitest";
import { commands, page, userEvent } from "vitest/browser";
import { FilterRow } from "../../src/rows/FilterRow.js";
import "../../src/styles.css";
import { OWNED, edgeOwners, targetRect } from "../../../ui-react/tests/browser/hit-reach.js";

let root: Root | undefined;
let host: HTMLDivElement | undefined;
afterEach(() => {
  if (root) flushSync(() => root!.unmount());
  host?.remove();
  host = undefined;
  root = undefined;
});

function premise() {
  const mode = inject("railPointer");
  expect(matchMedia("(any-pointer: coarse)").matches, "native coarse pointer premise").toBe(mode !== "fine");
  return mode !== "fine";
}

// The graph's Direction row: "In" paints 31px wide at the kit's pill size,
// "Out" 41px, "Both" 46px. The two narrow ones are the strip's first pill
// and its 6px neighbour, the two places a horizontal reach would fail.
const LABELS = ["In", "Out", "Both"];

type Item = { label: string; onClick?: ReturnType<typeof vi.fn<() => void>> };

async function mount(items: Item[] = LABELS.map(label => ({ label, onClick: vi.fn<() => void>() }))) {
  await page.viewport(320, 400);
  host = document.createElement("div");
  // Padding keeps the vertical reach inside the stage, so a probe that misses
  // lands on the stage rather than outside the page.
  host.style.cssText = "width:288px;padding:24px 16px;background:var(--bk-color-surface)";
  document.body.append(host);
  root = createRoot(host);
  flushSync(() => root!.render(createElement(FilterRow, { items, active: 0, mono: false })));
  const strip = host.firstElementChild as HTMLElement;
  const pills = [...strip.children] as HTMLElement[];
  return { strip, pills, items };
}

test("every interactive pill reaches 44px and owns each edge of its target", async () => {
  const coarse = premise();
  const { pills } = await mount();
  for (const pill of pills) {
    const label = pill.textContent!;
    const box = pill.getBoundingClientRect();
    expect(pill.classList.contains("bk-hit"), `${label}: carries the hit-area utility`).toBe(true);
    expect(box.height, `${label}: keeps the kit paint height`).toBeCloseTo(20.5, 0);
    if (coarse) {
      // No horizontal reach: the pill is at least as wide as its target.
      expect(box.width, `${label}: paints at least 44px wide under a coarse pointer`).toBeGreaterThanOrEqual(44);
      expect(targetRect(pill, 44).height, `${label}: target is 44px tall`).toBe(44);
    }
    expect(edgeOwners(pill, coarse ? 44 : 0), `${label}: owns each edge of its target`).toEqual(OWNED);
  }
});

test("a fine pointer keeps the paint", async () => {
  const coarse = premise();
  const { pills } = await mount();
  const widths = pills.map(pill => Math.round(pill.getBoundingClientRect().width));
  if (coarse) expect(widths.every(width => width >= 44), `coarse widths ${widths}`).toBe(true);
  else expect(widths[0], "In keeps its 31px paint under a fine pointer").toBeLessThan(38);
});

test("the strip clips horizontally only, under a coarse pointer", async () => {
  const coarse = premise();
  const { strip } = await mount();
  const css = getComputedStyle(strip);
  expect({ x: css.overflowX, y: css.overflowY }).toEqual(coarse ? { x: "clip", y: "visible" } : { x: "hidden", y: "hidden" });
});

// A mouse click, not a tap: Chromium's touch adjustment snaps a tap near a
// control onto it, so a tap passes with no reach at all. The mixed lane has
// reach (any-pointer: coarse) and a mouse, so it proves the reach clicks.
if (inject("railPointer") !== "coarse") test("a real click on the extended top edge selects that pill", async () => {
  const coarse = premise();
  const { pills, items } = await mount();
  const out = pills[1]!;
  const box = out.getBoundingClientRect();
  // 1px inside the top of the 44px target, which is 11.75px above the paint.
  await commands.overlayMouse({ x: box.left + box.width / 2, y: coarse ? targetRect(out, 44).top + 1 : box.top + 1 });
  expect(items[1]!.onClick, "Out takes its own extended edge").toHaveBeenCalledTimes(1);
  expect(items[0]!.onClick).not.toHaveBeenCalled();
  expect(items[2]!.onClick).not.toHaveBeenCalled();
});

test("static pills gain no target and no width", async () => {
  premise();
  const { pills } = await mount(LABELS.map(label => ({ label })));
  for (const pill of pills) expect(pill.classList.contains("bk-hit"), `${pill.textContent}: static`).toBe(false);
  expect(Math.round(pills[0]!.getBoundingClientRect().width), "a static In keeps its paint").toBeLessThan(38);
});

test("focus keeps the inset ring", async () => {
  premise();
  const { pills } = await mount();
  await userEvent.tab();
  const css = getComputedStyle(pills[0]!);
  expect({ active: document.activeElement === pills[0], offset: css.outlineOffset, style: css.outlineStyle }).toEqual({ active: true, offset: "-2px", style: "solid" });
});
