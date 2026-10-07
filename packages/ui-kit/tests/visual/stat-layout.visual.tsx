/** Stat tile rows fit and share real font baselines (#1129). */
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, expect, test } from "vitest";
import { commands, page } from "vitest/browser";

import "../../src/styles.css";
import { StatTiles, type StatTile } from "../../src/blocks/StatTiles.js";
import { digestStats } from "../../fixtures/events.js";

let host: HTMLDivElement | undefined;
let renderer: Root | undefined;
let fonts: HTMLStyleElement;
let viewport: { width: number; height: number };

beforeAll(async () => {
  viewport = { width: innerWidth, height: innerHeight };
  await page.viewport(1440, 1800);
  fonts = document.createElement("style");
  fonts.textContent = await commands.rankFooterFonts();
  document.head.append(fonts);
  const faces = ['600 9px "JetBrains Mono"', '400 10px "JetBrains Mono"', '400 24px "DM Serif Text"'];
  await Promise.all(faces.map(face => document.fonts.load(face)));
  await document.fonts.ready;
  for (const face of faces) expect(document.fonts.check(face)).toBe(true);
});

afterEach(() => {
  if (renderer) flushSync(() => renderer!.unmount());
  host?.remove();
  renderer = undefined;
  host = undefined;
});
afterAll(async () => {
  fonts?.remove();
  await page.viewport(viewport.width, viewport.height);
});

function mount(width: number, theme: string, input: StatTile[], minTile?: number) {
  host = document.createElement("div");
  host.style.width = `${width}px`;
  host.dataset.theme = theme;
  document.body.append(host);
  renderer = createRoot(host);
  flushSync(() => renderer!.render(<StatTiles tiles={input} minTile={minTile} />));
  const values = [...host.querySelectorAll<HTMLElement>("[data-tone]")];
  expect(input.length).toBeGreaterThan(0);
  expect(values).toHaveLength(input.length);
  values.forEach((value, i) => expect(value.firstElementChild!.textContent).toBe(input[i]!.value));
  return values.map(value => ({ value: value.firstElementChild as HTMLElement, tile: value.parentElement!, label: value.previousElementSibling as HTMLElement }));
}

function rows(tiles: ReturnType<typeof mount>) {
  const grouped = new Map<number, typeof tiles>();
  for (const t of tiles) {
    const y = Math.round(t.tile.getBoundingClientRect().top);
    grouped.set(y, [...(grouped.get(y) ?? []), t]);
  }
  return [...grouped.values()];
}

function fits(cell: HTMLElement) {
  const bounds = cell.getBoundingClientRect();
  const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
  let painted = 0;
  while (walker.nextNode()) {
    if (!walker.currentNode.textContent?.trim()) continue;
    const range = document.createRange();
    range.selectNodeContents(walker.currentNode);
    for (const r of range.getClientRects()) {
      if (!r.width) continue;
      painted += 1;
      expect(r.left, cell.textContent ?? "").toBeGreaterThanOrEqual(bounds.left - 1);
      expect(r.right, cell.textContent ?? "").toBeLessThanOrEqual(bounds.right + 1);
      expect(r.bottom).toBeLessThanOrEqual(bounds.bottom + 1);
    }
  }
  expect(painted).toBeGreaterThan(0);
}

for (const theme of ["dark", "light"]) for (const width of [320, 360, 390, 720, 1280]) {
  test(`three default tiles ${theme} ${width}: all three fit on one row`, () => {
    const tiles = mount(width, theme, digestStats);
    expect(rows(tiles), "the default three tiles share a row").toHaveLength(1);
    tiles.forEach(t => fits(t.tile));
  });
  test(`mixed labels ${theme} ${width}: same-row numeric values align`, () => {
    // At 360px the old minTile=96 already fits three. This assertion therefore
    // isolates the label-height defect from the default-basis wrapping defect.
    const tiles = mount(width, theme, digestStats, 96);
    const top = tiles[0]!.value.getBoundingClientRect().top;
    for (const tile of tiles) expect(tile.value.getBoundingClientRect().top, "values align across one- and two-line labels").toBeCloseTo(top, 1);
  });
  test(`label bands ${theme} ${width}: subject icons share a vertical centre`, () => {
    const tiles = mount(width, theme, digestStats, 96);
    const centers = tiles.map(tile => {
      const icon = tile.label.querySelector("svg");
      expect(icon).not.toBeNull();
      const bounds = icon!.getBoundingClientRect();
      return bounds.top + bounds.height / 2;
    });
    for (const center of centers) expect(center).toBeCloseTo(centers[0]!, 1);
  });
  test(`four tiles ${theme} ${width}: remainder tiles keep their peers' width`, () => {
    const four = [...digestStats, { label: "sources", value: "4", meta: "all resolved" }];
    const tiles = mount(width, theme, four);
    const grouped = rows(tiles);
    expect(grouped[0]).toHaveLength(width >= 1100 ? 4 : 3);
    const peer = tiles[0]!.tile.getBoundingClientRect().width;
    for (const tile of tiles) expect(tile.tile.getBoundingClientRect().width).toBeCloseTo(peer, 1);
    tiles.forEach(t => fits(t.tile));
  });
}

for (const theme of ["dark", "light"]) {
  test(`custom minimum ${theme}: a wider minimum still reduces column count`, () => {
    const tiles = mount(360, theme, digestStats, 160);
    expect(rows(tiles).map(row => row.length)).toEqual([2, 1]);
    expect(tiles[2]!.tile.getBoundingClientRect().width).toBeCloseTo(tiles[0]!.tile.getBoundingClientRect().width, 1);
  });
  test(`long labels ${theme}: full text fits and values share a baseline`, () => {
    const input = digestStats.map((tile, i) => ({ ...tile, label: i === 0 ? "Ithaca".repeat(12) : tile.label }));
    const tiles = mount(360, theme, input, 96);
    const top = tiles[0]!.value.getBoundingClientRect().top;
    tiles.forEach((tile, i) => {
      expect(tile.label.textContent).toBe(input[i]!.label);
      fits(tile.tile);
      expect(tile.value.getBoundingClientRect().top).toBeCloseTo(top, 1);
    });
  });
}
