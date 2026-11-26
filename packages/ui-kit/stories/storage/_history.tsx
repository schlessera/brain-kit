import type { Decorator } from "@storybook/react-vite";
import { expect, waitFor } from "storybook/test";

import { FilterRow } from "../../src/rows/FilterRow.js";
import { color, font } from "../../src/tokens.js";
import { overflowing } from "../_stage.js";
import { consumerViewportKey, viewportAt, type ConsumerWidth } from "../_viewports.js";

/**
 * Story furniture for the storage history stories (#4543).
 *
 * The chart fills its container and measures it, so the frame is a BLOCK at
 * the width a consumer gives it: Storybook's centred layout shrink-wraps its
 * root, and a chart that measures a shrink-wrapped box measures nothing. The
 * stories therefore run `fullscreen`, with the 12px phone gutter on each side,
 * so a 320px viewport hands the chart the 296px the design brief draws.
 *
 * Opened by hand, a story's viewport global sets the width. In the Vitest
 * runner the play function sets the same viewport first ({@link openAt}), so
 * "320" and "desktop" are the widths the assertions actually measured.
 */
export const frame: Decorator = (Story, context) => (
  <div style={{ boxSizing: "border-box", width: "100%", padding: 12, background: color.canvas, minHeight: "100vh" }}>
    <div style={{ maxWidth: (context.parameters.frameWidth as number | undefined) ?? 880 }}>
      <Story />
    </div>
  </div>
);

/** A phone: 320px viewport, a 296px chart. */
export const PHONE = 320 satisfies ConsumerWidth;
/** Desktop: 1280px viewport, the chart at 880px, as the brief draws it. */
export const DESKTOP = 1280 satisfies ConsumerWidth;

export const phone = { parameters: { layout: "fullscreen" as const, viewportWidth: PHONE }, globals: viewportAt(PHONE) };
export const desktop = { parameters: { layout: "fullscreen" as const, viewportWidth: DESKTOP, frameWidth: 880 }, globals: viewportAt(DESKTOP) };

/** The Vitest runner sets this; opened by hand, a story runs without it. */
const inRunner = () => Boolean(document.documentElement.dataset.expectedStoryTheme);

/**
 * Open the story at its declared viewport in the runner, and put the old one
 * back when the test finishes. Outside the runner the viewport global did it.
 */
export async function openAt(width: number, globals?: { viewport?: unknown }) {
  const viewport = (globals?.viewport as { value?: string } | undefined)?.value;
  await expect(viewport, `width ${width} opens at its own viewport`).toBe(consumerViewportKey(width));
  if (!inRunner()) return;
  const { page } = await import("vitest/browser");
  const { onTestFinished } = await import("vitest");
  const before = { width: innerWidth, height: innerHeight };
  onTestFinished(async () => {
    await page.viewport(before.width, before.height);
  });
  await page.viewport(width, 800);
  await waitFor(() => expect(innerWidth).toBe(width));
}

/** A card in the shape #4549 composes: title, the now line, and the tier switch kept outside the chart. */
export function HistoryCard({ tier = 0, title = "Available space · Data volume", children }: { tier?: number; title?: string; children: React.ReactNode }) {
  const tiers = ["Recent", "Daily", "Weekly"].map((label) => ({ label, onClick: () => {} }));
  return (
    <section
      aria-label={title}
      style={{
        boxSizing: "border-box",
        width: "100%",
        minWidth: 0,
        display: "flex",
        flexDirection: "column",
        gap: 12,
        padding: 16,
        borderRadius: 12,
        background: color.surface,
        boxShadow: `inset 0 0 0 1px ${color.line}`,
      }}
    >
      <div style={{ display: "flex", flexWrap: "wrap", gap: "8px 16px", alignItems: "flex-start", justifyContent: "space-between" }}>
        <div style={{ font: `600 15px/1.3 ${font.body}`, color: color.ink, minWidth: 0 }}>{title}</div>
        <div style={{ maxWidth: "100%" }}>
          <FilterRow items={tiers} active={tier} mono={false} />
        </div>
      </div>
      {children}
    </section>
  );
}

/* ── Shared assertions ────────────────────────────────────────────────────── */

export const svgOf = (root: HTMLElement) => root.querySelector<SVGSVGElement>('svg[data-part="history-svg"]');

/** Wait for the chart to lay out at the expected mode for its width. */
export async function laidOut(root: HTMLElement, width: number) {
  const mode = width - 24 >= 600 ? "gutter" : "caption";
  await waitFor(() => expect(svgOf(root)?.dataset.layout).toBe(mode));
  return svgOf(root)!;
}

/**
 * What every chart story must hold, measured in the browser:
 *
 * - nothing escapes the chart, and nothing scrolls the page sideways;
 * - every label is an SVG `<text>` with words in it, inside the drawing: the
 *   rev 1 export lost its axis, threshold and scenario labels, and a label
 *   drawn as HTML over the SVG, or past its edge, is lost the same way;
 * - no filled shape reaches past now except the future zone and the bands:
 *   there is no cone between scenario lines (#4537 D9), and every scenario is
 *   an unfilled `<line>`;
 * - x tick labels sit at least 48px apart.
 */
export async function chartHolds(root: HTMLElement) {
  const svg = svgOf(root)!;
  // The chart, not the card: the tier strip around it scrolls by design.
  await expect(overflowing(root.querySelector<HTMLElement>('[data-part="history-chart"]')!), "nothing escapes the chart").toEqual([]);
  await expect(document.documentElement.scrollWidth, "no horizontal page scroll").toBeLessThanOrEqual(document.documentElement.clientWidth);

  await everyMarkInside(svg);
  await noTextOverlaps(svg);

  const now = svg.querySelector('[data-part="now-rule"]')!.getBoundingClientRect().left;
  for (const shape of svg.querySelectorAll<SVGGraphicsElement>("path, polygon, rect, circle, ellipse")) {
    if (shape.closest("defs, clipPath, pattern")) continue;
    const part = shape.getAttribute("data-part") ?? shape.parentElement?.getAttribute("data-part") ?? "";
    if (part === "future" || part.startsWith("band-") || part === "gap" || part === "event-box" || part === "point" || part === "latest" || part === "dot") continue;
    const fill = getComputedStyle(shape).fill;
    if (fill === "none" || fill === "transparent" || fill === "rgba(0, 0, 0, 0)") continue;
    await expect(shape.getBoundingClientRect().right, `a filled <${shape.tagName}> (${part}) stops at now`).toBeLessThanOrEqual(now + 1);
  }
  for (const line of svg.querySelectorAll('[data-part="scenario"]')) {
    await expect(line.tagName.toLowerCase(), "a scenario is a line").toBe("line");
  }

  const ticks = [...svg.querySelectorAll('[data-part="x-tick"]')].map((t) => Number(t.getAttribute("x")));
  for (let i = 1; i < ticks.length; i += 1) await expect(ticks[i]! - ticks[i - 1]!, "x ticks 48px apart").toBeGreaterThanOrEqual(48);
}

/**
 * The table fallback says what the chart drew: one row per point in order,
 * each measured row matching a drawn point at the same instant with the same
 * value, and each unobserved row matching no point at all.
 */
export async function tableMatchesPoints(root: HTMLElement, user: { click: (el: Element) => Promise<void> }) {
  const svg = svgOf(root)!;
  const button = [...root.querySelectorAll("button")].find((b) => b.textContent?.includes("View as table"))!;
  await expect(button.getBoundingClientRect().height, "View as table reaches 44px").toBeGreaterThanOrEqual(44);
  await expect(button.getAttribute("aria-expanded")).toBe("false");
  await user.click(button);
  await expect(button.getAttribute("aria-expanded")).toBe("true");
  const table = root.querySelector<HTMLTableElement>('table[data-part="history-table"]')!;
  await expect(table).not.toBeNull();
  const rows = [...table.querySelectorAll<HTMLTableRowElement>("tbody tr[data-at]")];
  const drawn = [...svg.querySelectorAll<SVGCircleElement>('circle[data-part="point"]')];
  const measured = rows.filter((r) => r.dataset.state !== "? no observation");
  await expect(drawn.length, "one drawn point per measured row").toBe(measured.length);
  for (const row of rows) {
    const point = drawn.find((c) => c.dataset.at === row.dataset.at);
    if (row.dataset.state === "? no observation") {
      await expect(point, `no point drawn for the gap at ${row.cells[0]!.textContent}`).toBeUndefined();
      await expect(row.cells[1]!.textContent).toBe("?");
      continue;
    }
    await expect(point, `a point is drawn for ${row.cells[0]!.textContent}`).toBeDefined();
    await expect(point!.querySelector("title")!.textContent).toContain(row.cells[1]!.textContent!);
    await expect(point!.querySelector("title")!.textContent).toContain(row.cells[0]!.textContent!);
  }
  // Drawn y follows value: a larger value is never drawn lower.
  const byValue = drawn.map((c) => ({ v: Number(c.dataset.value), y: Number(c.getAttribute("cy")) })).sort((a, b) => a.v - b.v);
  for (let i = 1; i < byValue.length; i += 1) await expect(byValue[i]!.y).toBeLessThanOrEqual(byValue[i - 1]!.y + 1e-6);
  await user.click(button);
  await expect(button.getAttribute("aria-expanded")).toBe("false");
  button.blur();
}

/**
 * The one invariant for every chart at every width: each rendered text and
 * each painted shape (rects, lines, polylines, paths, circles) lies inside the
 * SVG, so nothing is clipped on a phone or lost in an export, and every label
 * has words in it. Definitions (patterns, clip paths) are not painted and are
 * skipped. A 1px tolerance absorbs sub-pixel rounding.
 */
export async function everyMarkInside(svg: SVGSVGElement, what = "") {
  const box = svg.getBoundingClientRect();
  const marks = [...svg.querySelectorAll<SVGGraphicsElement>("text, rect, line, polyline, path, circle")].filter((el) => !el.closest("defs, clipPath, pattern"));
  await expect(marks.filter((m) => m.tagName === "text").length, `${what} the chart's labels are SVG text`).toBeGreaterThan(2);
  // Collected, then asserted once: the list names every offender, and a
  // hundred charts do not cost thousands of awaited assertions.
  const out: string[] = [];
  for (const el of marks) {
    const name = el.tagName === "text" ? `"${el.textContent}"` : `<${el.tagName}> ${el.getAttribute("data-part") ?? el.parentElement?.getAttribute("data-part") ?? ""}`;
    if (el.tagName === "text" && !(el.textContent ?? "").trim()) out.push(`${what} an empty label`);
    const r = el.getBoundingClientRect();
    if (!(r.left >= box.left - 1 && r.right <= box.right + 1 && r.top >= box.top - 1 && r.bottom <= box.bottom + 1)) {
      out.push(`${what} ${name} leaves the drawing (${Math.round(r.left - box.left)}..${Math.round(r.right - box.left)} x ${Math.round(r.top - box.top)}..${Math.round(r.bottom - box.top)} in ${Math.round(box.width)} x ${Math.round(box.height)})`);
    }
  }
  await expect(out, "every text and shape sits inside the drawing").toEqual([]);
}

/**
 * No two rendered labels intersect: every pair of `<text>` boxes in the SVG,
 * measured as the browser laid them out. Run beside {@link everyMarkInside}
 * in every chart story and at every width in `EveryWidth`.
 */
export async function noTextOverlaps(svg: SVGSVGElement, what = "") {
  const texts = [...svg.querySelectorAll<SVGTextElement>("text")].map((t) => ({ t, r: t.getBoundingClientRect() }));
  const out: string[] = [];
  for (let i = 0; i < texts.length; i += 1) {
    for (let j = i + 1; j < texts.length; j += 1) {
      const a = texts[i]!.r;
      const b = texts[j]!.r;
      if (a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5) {
        out.push(`${what} "${texts[i]!.t.textContent}" and "${texts[j]!.t.textContent}" overlap`);
      }
    }
  }
  await expect(out, "no two labels overlap").toEqual([]);
}
