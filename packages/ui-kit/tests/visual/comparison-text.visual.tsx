/** Comparison text keeps its own column even when it has no break points. */
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, expect, test } from "vitest";
import { page } from "vitest/browser";

import "../../src/styles.css";
import { ComparisonTable, type ComparisonTableProps } from "../../src/conversation/ComparisonTable.js";
import { straitChoice } from "../../fixtures/projects.js";

let host: HTMLDivElement | undefined;
let renderer: Root | undefined;
let viewport: { width: number; height: number };

beforeAll(async () => {
  viewport = { width: innerWidth, height: innerHeight };
  await page.viewport(1440, 1800);
  const faces = ['400 9px "JetBrains Mono"', '500 11px "JetBrains Mono"', '600 11px "JetBrains Mono"', '400 11px "Plus Jakarta Sans"', '600 11px "Plus Jakarta Sans"'];
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
  await page.viewport(viewport.width, viewport.height);
});

function mount(width: number, theme: string, props: ComparisonTableProps) {
  host = document.createElement("div");
  host.style.width = `${width}px`;
  host.dataset.theme = theme;
  document.body.append(host);
  renderer = createRoot(host);
  flushSync(() => renderer!.render(<ComparisonTable {...props} />));
  return host.firstElementChild as HTMLElement;
}

function fits(cell: HTMLElement) {
  const bounds = cell.getBoundingClientRect();
  const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
  let rectangles = 0;
  while (walker.nextNode()) {
    if (!walker.currentNode.textContent?.trim()) continue;
    const range = document.createRange();
    range.selectNodeContents(walker.currentNode);
    for (const rect of range.getClientRects()) {
      if (!rect.width) continue;
      rectangles += 1;
      expect(rect.left, `text stays inside its cell: ${cell.textContent}`).toBeGreaterThanOrEqual(bounds.left - 1);
      expect(rect.right, `text stays inside its cell: ${cell.textContent}`).toBeLessThanOrEqual(bounds.right + 1);
      expect(rect.bottom).toBeLessThanOrEqual(bounds.bottom + 1);
    }
  }
  expect(rectangles, "nonempty text has rendered rectangles").toBeGreaterThan(0);
}

for (const theme of ["dark", "light"]) for (const width of [320, 360, 390, 720, 1280]) {
  test(`source paths ${theme} ${width}: full fixture values stay in their columns`, () => {
    const table = mount(width, theme, { ...straitChoice, footnote: "" });
    const rows = [...table.children].slice(1);
    expect(rows).toHaveLength(straitChoice.rows.length);
    rows.forEach((row, index) => {
      const cells = [...row.children] as HTMLElement[];
      expect(cells).toHaveLength(3);
      expect(cells[0]!.textContent).toBe(straitChoice.rows[index]!.label);
      cells.forEach(fits);
      for (let i = 1; i < cells.length; i++) {
        const raw = straitChoice.rows[index]!.cells[i - 1]!;
        expect(cells[i]!.textContent).toBe(typeof raw === "string" ? raw : raw.v);
      }
    });
  });
  for (const count of width >= 1100 ? [2, 3, 4] : [2, 3]) {
    test(`long text ${count} columns ${theme} ${width}: every text role remains readable`, () => {
      const long = "Ithaca".repeat(12);
      const table = mount(width, theme, {
        columns: Array.from({ length: count }, (_, i) => ({ label: long, note: long, recommended: i === 0 })),
        rows: [{ label: long, cells: Array.from({ length: count }, () => long) }],
        corner: long,
        footnote: long,
      });
      const [head, row, foot] = [...table.children] as HTMLElement[];
      expect(head!.children).toHaveLength(count + 1);
      expect(row!.children).toHaveLength(count + 1);
      for (const cell of [...head!.children, ...row!.children]) {
        expect(cell.textContent).toContain(long);
        fits(cell as HTMLElement);
      }
      expect(foot!.textContent).toBe(long);
      fits(foot!);
      expect(table.scrollWidth).toBeLessThanOrEqual(table.clientWidth + 1);
    });
  }
}
