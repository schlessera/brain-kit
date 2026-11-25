/**
 * Storage history baselines (#4543): `HistoryChart` in every state at a 320px
 * phone and at desktop, the paper theme for four of them, and the greyscale
 * galleries; `EventList` and `Sparkline` beside it.
 *
 * The stories' play functions are the proof of what the chart MEANS (gaps
 * break, no cone, labels are text inside the drawing, the table matches the
 * points). These baselines are for what an assertion cannot see: a band in
 * the wrong tint, a dash that collapsed, a label drawn over a line. Each
 * story runs through CSF Next's `run()`, so the baseline is the story itself.
 *
 * The viewport is set before the story renders, because the chart measures
 * its container: a phone story is a 320px viewport and a 296px chart, a
 * desktop story a 1280px viewport and an 880px chart with its label gutter.
 * Generated and compared only inside the pinned Playwright image
 * (`scripts/visual.mjs`), like every other baseline here.
 */
/// <reference types="@vitest/browser/matchers" />
import { commands, page } from "vitest/browser";
import { expect, test } from "vitest";

import * as chart from "../../stories/storage/HistoryChart.stories.js";
import * as events from "../../stories/storage/EventList.stories.js";
import * as spark from "../../stories/storage/Sparkline.stories.js";
import { viewportAt } from "../../stories/_viewports.js";

interface ComposedStory {
  run: (context?: { globals?: Record<string, unknown> }) => Promise<void>;
}

/** The subjects suite's tolerance and its reasoning (`subjects.visual.tsx`). */
const TOLERANCE = { comparatorOptions: { threshold: 0.01, allowedMismatchedPixelRatio: 0.001 } } as const;

const STATES: Array<[string, unknown, unknown]> = [
  ["full", chart.Full, chart.FullDesktop],
  ["gap", chart.Gap, chart.GapDesktop],
  ["no-projection", chart.NoProjection, chart.NoProjectionDesktop],
  ["one-window", chart.OneWindow, chart.OneWindowDesktop],
  ["two-windows", chart.TwoWindows, chart.TwoWindowsDesktop],
  ["non-depleting", chart.NonDepleting, chart.NonDepletingDesktop],
  ["weekly-three", chart.WeeklyThreePoints, chart.WeeklyThreePointsDesktop],
  ["single-point", chart.SinglePoint, chart.SinglePointDesktop],
  ["scope-change", chart.ScopeChange, chart.ScopeChangeDesktop],
  ["all-unknown", chart.AllUnknown, chart.AllUnknownDesktop],
  ["event-cluster", chart.EventCluster, chart.EventClusterDesktop],
  ["very-low-now", chart.VeryLowNow, chart.VeryLowNowDesktop],
];
const ON_PAPER = new Set(["full", "gap", "scope-change", "all-unknown"]);

async function capture(story: unknown, name: string, width: 320 | 1280, theme: "dark" | "light") {
  const before = { width: innerWidth, height: innerHeight };
  const outer = await commands.formViewport(width, 900);
  await page.viewport(width, 900);
  try {
    // `globals` replaces the story's own, so the viewport goes back in beside the theme.
    await (story as ComposedStory).run({ globals: { theme, ...viewportAt(width) } });
    expect(document.documentElement.dataset.theme).toBe(theme);
    const svg = document.querySelector<SVGSVGElement>('svg[data-part="history-svg"], [data-part="sparkline"] svg');
    if (svg?.dataset.layout) expect(svg.dataset.layout).toBe(width === 1280 ? "gutter" : "caption");
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(document.documentElement.clientWidth);
    await expect(document.body).toMatchScreenshot(`${name}${theme === "light" ? "-light" : ""}`, TOLERANCE);
  } finally {
    await page.viewport(before.width, before.height);
    await commands.formViewport(outer.width - 100, outer.height - 120);
  }
}

for (const [name, phone, desktop] of STATES) {
  test(`history chart, ${name}, 320`, async () => {
    await capture(phone, `history-${name}-320`, 320, "dark");
  });
  test(`history chart, ${name}, desktop`, async () => {
    await capture(desktop, `history-${name}-desktop`, 1280, "dark");
  });
  if (ON_PAPER.has(name)) {
    test(`history chart, ${name}, 320, paper`, async () => {
      await capture(phone, `history-${name}-320`, 320, "light");
    });
    test(`history chart, ${name}, desktop, paper`, async () => {
      await capture(desktop, `history-${name}-desktop`, 1280, "light");
    });
  }
}

test("history chart, every state in greyscale, 320", async () => {
  await capture(chart.Greyscale, "history-greyscale-320", 320, "dark");
});

test("history chart, every state in greyscale, desktop", async () => {
  await capture(chart.GreyscaleDesktop, "history-greyscale-desktop", 1280, "dark");
});

test("event list, four events, 320", async () => {
  await capture(events.Clustered, "event-list-clustered-320", 320, "dark");
});

test("sparkline, rising, gap and unknown, greyscale", async () => {
  await capture(spark.Greyscale, "sparkline-greyscale-320", 320, "dark");
});
