import preview from "#.storybook/preview";
import { expect, waitFor } from "storybook/test";

import {
  CLUSTERED_EVENTS,
  HISTORY_BASE,
  LONG_FINITE,
  LONG_GAP,
  LONG_NONE,
  LONG_SCOPE,
  LONG_SHORT_HISTORY,
  SHORT_FINITE,
  SHORT_FLAT,
  SHORT_GAP,
  SHORT_NONE,
  SHORT_SCOPE,
  SHORT_VERY_LOW,
  allUnknown,
  singlePoint,
  sixHourGap,
  scopeChanged,
  scopeChangedAtNow,
  sixHourTrailingGap,
  SHORT_SOON,
  LONG_SOON,
  sixHourNotANumber,
  veryLowNow,
  weeklyThree,
} from "../../fixtures/storage-history.js";
import { HistoryChart, type HistoryChartProps } from "../../src/storage/HistoryChart.js";
import { DESKTOP, HistoryCard, PHONE, chartHolds, desktop, frame, laidOut, openAt, phone, svgOf, tableMatchesPoints } from "./_history.js";

const DAY = 86_400_000;

/**
 * `HistoryChart` (#4543): available space over time for one volume, in the
 * card #4549 composes, with the tier switch (`FilterRow`) outside the chart.
 *
 * Every state is drawn at 320px (a 296px chart, scenario labels in the
 * caption) and at desktop (an 880px chart, labels in the right gutter). The
 * two Storybook projects run each one in dark and on paper; `Greyscale*`
 * draws every state without colour. Fixtures are the Odysseus data volume,
 * measured every six hours up to 12 Jul 04:40.
 */
const meta = preview.meta({
  title: "Storage/HistoryChart",
  component: HistoryChart,
  decorators: [frame],
  args: HISTORY_BASE,
  render: (args, { parameters }) => (
    <HistoryCard tier={(parameters.tier as number | undefined) ?? 0}>
      <HistoryChart {...args} />
    </HistoryCard>
  ),
});

type Ctx = { canvasElement: HTMLElement; globals: { viewport?: unknown }; parameters: { viewportWidth?: number } };

/** Open at the story's width, wait for the layout that width calls for, and run the shared checks. */
async function open({ canvasElement, globals, parameters }: Ctx) {
  const width = parameters.viewportWidth ?? PHONE;
  await openAt(width, globals);
  const svg = await laidOut(canvasElement, width);
  await chartHolds(canvasElement);
  return { svg, wide: width === DESKTOP };
}

const parts = (svg: SVGSVGElement, part: string) => [...svg.querySelectorAll(`[data-part="${part}"]`)];
const caption = (root: HTMLElement) => [...root.querySelectorAll("p")].map((p) => p.textContent ?? "");

/* ── The full six-hour tier ─────────────────────────────────────────────────── */

/**
 * Sixty-four six-hour points, two qualified windows and three events (the
 * last two merge into one `2–3` box on a phone, never in the list).
 */
export const Full = meta.story({
  ...phone,
  play: async (ctx) => {
    const { svg, wide } = await open(ctx);
    await expect(parts(svg, "segment")).toHaveLength(1);
    await expect(parts(svg, "scenario")).toHaveLength(2);
    await expect(parts(svg, "gap")).toHaveLength(0);
    // The rules stay one per event; the list lists all three.
    await expect(parts(svg, "event-rule")).toHaveLength(3);
    await expect(ctx.canvasElement.querySelectorAll('[data-part="event-list"] li')).toHaveLength(3);
    // Thresholds, now and the window labels are words, not colours.
    const text = svg.textContent ?? "";
    await expect(text).toContain("△ Low < 16.1 GB");
    await expect(text).toContain("▲ Very low < 8.05 GB");
    await expect(text).toContain("now");
    await expect(svg.querySelector('[data-part="now-value"]')!.textContent).toBe("16.4 GB");
    if (wide) {
      await expect(parts(svg, "scenario-label").map((l) => l.textContent)).toEqual(
        expect.arrayContaining(["7-day rateempty ~20 Jul", "30-day rateempty ~28 Jul"]),
      );
    } else {
      await expect(parts(svg, "scenario-label")).toHaveLength(0);
      await expect(caption(ctx.canvasElement)).toEqual(expect.arrayContaining(["╌ 7-day rate · empty ~20 Jul", "┄ 30-day rate · empty ~28 Jul"]));
    }
    // The two windows are told apart by dash, which greyscale keeps.
    const dashes = parts(svg, "scenario").map((l) => l.getAttribute("stroke-dasharray"));
    await expect(new Set(dashes).size).toBe(2);
    await expect(svg.getAttribute("aria-label")).toBe(
      "Available space, Data volume, last 16 days. Now 16.4 GB, Low. 7-day rate: empty about 20 Jul. 30-day rate: empty about 28 Jul. 3 events.",
    );
    await tableMatchesPoints(ctx.canvasElement, ctx.userEvent);
  },
});
export const FullDesktop = Full.extend({ ...desktop });

/* ── A gap ──────────────────────────────────────────────────────────────────── */

/**
 * Nothing was observed on 2 Jul at 06:00 and 12:00. The line and its area
 * break, the span is hatched, and it is never drawn as zero: two subpaths, no
 * point for either bucket, `?` in the table.
 */
export const Gap = meta.story({
  ...phone,
  args: { points: sixHourGap },
  play: async (ctx) => {
    const { svg, wide } = await open(ctx);
    const lines = parts(svg, "line").map((l) => l.getAttribute("d") ?? "");
    await expect(lines, "two subpaths around the gap").toHaveLength(2);
    for (const d of lines) await expect((d.match(/M/g) ?? []).length).toBe(1);
    const hatch = parts(svg, "gap")[0]!.getBoundingClientRect();
    for (const path of [...parts(svg, "line"), ...parts(svg, "area")]) {
      const r = path.getBoundingClientRect();
      await expect(r.right <= hatch.left + 1 || r.left >= hatch.right - 1, "no line or area crosses the hatch").toBe(true);
    }
    if (wide) {
      await expect(svg.querySelector('[data-part="gap-label"]')!.textContent).toBe("? no observation · not zero");
    } else {
      await expect(svg.querySelector('[data-part="gap-label"]')!.textContent).toBe("?");
      await expect(caption(ctx.canvasElement)).toContain("▨ ? 2 Jul 06:00–12:00 · no observation · not zero");
    }
    await expect(svg.getAttribute("aria-label")).toContain("1 gap.");
    await tableMatchesPoints(ctx.canvasElement, ctx.userEvent);
  },
});
export const GapDesktop = Gap.extend({ ...desktop });

/* ── Projection: none, one window, two windows, not running out ─────────────── */

/** No qualified window: no line, and the caption says why, from the short window. */
export const NoProjection = meta.story({
  ...phone,
  args: { points: sixHourGap, scenarios: [SHORT_GAP, LONG_GAP] },
  play: async (ctx) => {
    const { svg } = await open(ctx);
    await expect(parts(svg, "scenario")).toHaveLength(0);
    await expect(parts(svg, "scenario-label")).toHaveLength(0);
    await expect(caption(ctx.canvasElement)).toContain("No projection · gap inside the 7-day window");
    await expect(svg.getAttribute("aria-label")).toContain("No projection, gap inside the 7-day window.");
  },
});
export const NoProjectionDesktop = NoProjection.extend({ ...desktop });

/** One qualified window: one labelled line; the other window says why it has none. */
export const OneWindow = meta.story({
  ...phone,
  args: { points: sixHourGap, scenarios: [SHORT_FINITE, LONG_SHORT_HISTORY] },
  play: async (ctx) => {
    const { svg, wide } = await open(ctx);
    await expect(parts(svg, "scenario")).toHaveLength(1);
    await expect(parts(svg, "scenario")[0]!.getAttribute("data-window")).toBe("short");
    await expect(parts(svg, "scenario-label")).toHaveLength(wide ? 1 : 0);
    await expect(caption(ctx.canvasElement)).toContain("30-day: no projection · under 30 days of history");
    if (!wide) await expect(caption(ctx.canvasElement)).toContain("╌ 7-day rate · empty ~20 Jul");
  },
});
export const OneWindowDesktop = OneWindow.extend({ ...desktop });

/** Two qualified windows: two lines from the now point, and nothing filled between them. */
export const TwoWindows = meta.story({
  ...phone,
  args: { points: sixHourGap, scenarios: [SHORT_FINITE, LONG_FINITE] },
  play: async (ctx) => {
    const { svg, wide } = await open(ctx);
    const lines = parts(svg, "scenario");
    await expect(lines).toHaveLength(2);
    const latest = svg.querySelector('[data-part="latest"]')!;
    for (const l of lines) {
      await expect(Number(l.getAttribute("x1"))).toBeCloseTo(Number(latest.getAttribute("cx")), 3);
      await expect(Number(l.getAttribute("y1"))).toBeCloseTo(Number(latest.getAttribute("cy")), 3);
      await expect(getComputedStyle(l).fill === "none" || l.getAttribute("fill") === "none").toBe(true);
    }
    if (wide) {
      const ys = parts(svg, "scenario-label").map((g) => (g.querySelector("text")!.getBoundingClientRect().top));
      await expect(Math.abs(ys[0]! - ys[1]!), "gutter labels 28px apart").toBeGreaterThanOrEqual(27.5);
    }
  },
});
export const TwoWindowsDesktop = TwoWindows.extend({ ...desktop });

/** A window whose rate does not run the volume out: drawn flat, labelled "not running out". */
export const NonDepleting = meta.story({
  ...phone,
  args: { scenarios: [SHORT_FLAT, LONG_FINITE] },
  play: async (ctx) => {
    const { svg, wide } = await open(ctx);
    const flat = parts(svg, "scenario").find((l) => l.getAttribute("data-window") === "short")!;
    await expect(Number(flat.getAttribute("y2"))).toBeLessThanOrEqual(Number(flat.getAttribute("y1")));
    if (wide) await expect(svg.textContent).toContain("not running out");
    else await expect(caption(ctx.canvasElement)).toContain("╌ 7-day rate · not running out");
  },
});
export const NonDepletingDesktop = NonDepleting.extend({ ...desktop });

/* ── Short series ───────────────────────────────────────────────────────────── */

/** Weekly, three points: countable dots, each dated on the axis; only the last is hollow. */
export const WeeklyThreePoints = meta.story({
  ...phone,
  parameters: { tier: 2 },
  args: {
    label: "Available space, Data volume, last 2 weeks",
    points: weeklyThree,
    intervalMs: 7 * DAY,
    intervalLabel: "1 week",
    markers: [],
    scenarios: [SHORT_FINITE, LONG_SHORT_HISTORY],
    notes: ["Weekly history starts 28 Jun · 3 points so far"],
  },
  play: async (ctx) => {
    const { svg } = await open(ctx);
    await expect(parts(svg, "dot"), "two filled dots and a hollow latest").toHaveLength(2);
    await expect(svg.querySelector('[data-part="latest"]')!.getAttribute("data-provisional")).toBe("true");
    await expect(parts(svg, "x-tick").map((t) => t.textContent)).toEqual(["28 Jun", "5 Jul", "now"]);
    await expect(caption(ctx.canvasElement)).toContain("Weekly history starts 28 Jun · 3 points so far");
    // The first dot clears the y axis: the range starts half a week early.
    const first = parts(svg, "dot")[0]!.getBoundingClientRect();
    const axis = svg.querySelector('[data-part="y-tick"] line')!.getBoundingClientRect();
    await expect(first.left - axis.left).toBeGreaterThan(8);
    await tableMatchesPoints(ctx.canvasElement, ctx.userEvent);
  },
});
export const WeeklyThreePointsDesktop = WeeklyThreePoints.extend({ ...desktop });

/** One measurement: a hollow point at now, no line, no area, no ticks but now. */
export const SinglePoint = meta.story({
  ...phone,
  args: { label: "Available space, Data volume, since 12 Jul", points: singlePoint, markers: [], scenarios: [SHORT_NONE, LONG_NONE] },
  play: async (ctx) => {
    const { svg } = await open(ctx);
    await expect(parts(svg, "line")).toHaveLength(0);
    await expect(parts(svg, "area")).toHaveLength(0);
    await expect(parts(svg, "x-tick").map((t) => t.textContent)).toEqual(["now"]);
    await expect(svg.querySelector('[data-part="latest"]')!.getAttribute("data-provisional")).toBe("true");
    await expect(caption(ctx.canvasElement)).toEqual(
      expect.arrayContaining(["No projection · one measurement so far", "The line starts with the next measurement (~6 h)"]),
    );
    // Four days of empty plot before the point: it does not sit on the y axis.
    const latest = svg.querySelector('[data-part="latest"]')!.getBoundingClientRect();
    const axis = svg.querySelector('[data-part="y-tick"] line')!.getBoundingClientRect();
    await expect(latest.left - axis.left).toBeGreaterThan(100);
  },
});
export const SinglePointDesktop = SinglePoint.extend({ ...desktop });

/* ── Scope change ───────────────────────────────────────────────────────────── */

/**
 * The volume was replaced on 4 Jul. A solid rule marks the change, earlier
 * points are a mute dotted "other volume" series, and the two are never
 * joined. The 30-day window spans the change, so it has no projection.
 */
export const ScopeChange = meta.story({
  ...phone,
  args: { points: scopeChanged, markers: [], scenarios: [SHORT_FINITE, LONG_SCOPE] },
  play: async (ctx) => {
    const { svg } = await open(ctx);
    const segments = parts(svg, "segment");
    await expect(segments.map((s) => s.getAttribute("data-kind"))).toEqual(["other", "current"]);
    await expect(parts(svg, "scope-break")).toHaveLength(1);
    const rule = parts(svg, "scope-break")[0]!.getBoundingClientRect();
    const [other, current] = segments.map((s) => s.querySelector('[data-part="line"]')!.getBoundingClientRect());
    await expect(other!.right).toBeLessThanOrEqual(rule.left + 1);
    await expect(current!.left).toBeGreaterThanOrEqual(rule.right - 1);
    await expect(svg.textContent).toContain("↺ scope changed");
    await expect(caption(ctx.canvasElement)).toContain("30-day: no projection · volume changed in the window");
    await expect(svg.getAttribute("aria-label")).toContain("Scope changed.");
    await tableMatchesPoints(ctx.canvasElement, ctx.userEvent);
    const toggle = [...ctx.canvasElement.querySelectorAll("button")].find((b) => b.textContent?.includes("View as table"))!;
    await ctx.userEvent.click(toggle);
    const states = [...ctx.canvasElement.querySelectorAll<HTMLTableRowElement>("tbody tr[data-at]")].map((r) => r.dataset.state);
    await expect(states).toContain("↺ other volume");
    await ctx.userEvent.click(toggle);
    toggle.blur();
  },
});
export const ScopeChangeDesktop = ScopeChange.extend({ ...desktop });

/**
 * The volume changed just before now (#4559 review, F2): the change sits a
 * few pixels from the plot's right edge, so `↺ scope changed` cannot sit to
 * the rule's right. It moves left of the rule, or to the caption, and never
 * past the drawing's edge.
 */
export const ScopeChangeAtNow = meta.story({
  ...phone,
  args: { points: scopeChangedAtNow, markers: [], scenarios: [SHORT_SCOPE, LONG_SCOPE] },
  play: async (ctx) => {
    const { svg } = await open(ctx);
    await expect(parts(svg, "scope-break")).toHaveLength(1);
    const said = (svg.textContent ?? "") + caption(ctx.canvasElement).join(" ");
    await expect(said).toContain("\u21ba scope changed");
    await expect(caption(ctx.canvasElement)).toContain("No projection \u00b7 volume changed in the window");
  },
});
export const ScopeChangeAtNowDesktop = ScopeChangeAtNow.extend({ ...desktop });

/**
 * A non-number from the collector (#4559 review, F4) is a gap exactly as
 * `null` is: the line breaks, and the table says `?` and "no observation",
 * never "NaN GB" or "measured".
 */
export const NotANumberIsAGap = meta.story({
  ...phone,
  args: { points: sixHourNotANumber },
  play: async (ctx) => {
    const { svg } = await open(ctx);
    await expect(parts(svg, "line")).toHaveLength(2);
    await tableMatchesPoints(ctx.canvasElement, ctx.userEvent);
    const toggle = [...ctx.canvasElement.querySelectorAll("button")].find((b) => b.textContent?.includes("View as table"))!;
    await ctx.userEvent.click(toggle);
    await expect(ctx.canvasElement.querySelector("table")!.textContent).not.toContain("NaN");
    await ctx.userEvent.click(toggle);
    toggle.blur();
  },
});

/**
 * Nothing observed for the current bucket (#4559 review, F5). The last
 * measurement is not "now": the chart marks now `?`, the name says now is
 * not measured and names the last measurement with its time, and the table's
 * current row reads `?`.
 */
export const NowNotMeasured = meta.story({
  ...phone,
  args: { points: sixHourTrailingGap, nowState: undefined },
  play: async (ctx) => {
    const { svg } = await open(ctx);
    const name = svg.getAttribute("aria-label") ?? "";
    await expect(name).toContain("Now not measured. Last measured ");
    await expect(name).toContain(" at 12 Jul 00:00");
    await expect(name).not.toMatch(/Now \d/);
    await expect(svg.querySelector('[data-part="now-value"]')!.textContent).toBe("?");
    await expect(svg.querySelector('[data-part="latest"]')!.getAttribute("data-provisional")).toBe("false");
    await tableMatchesPoints(ctx.canvasElement, ctx.userEvent);
  },
});
export const NowNotMeasuredDesktop = NowNotMeasured.extend({ ...desktop });

/**
 * Both windows reach zero inside the future zone and there are no events
 * (#4559 review, F6): both two-line gutter labels sit at the baseline and
 * must stay whole inside the drawing, second line included.
 */
export const BothWindowsReachZero = meta.story({
  ...phone,
  args: { markers: [], scenarios: [SHORT_SOON, LONG_SOON] },
  play: async (ctx) => {
    const { svg, wide } = await open(ctx);
    const baseline = Number(svg.querySelector('[data-part="y-tick"] line')!.getAttribute("y1"));
    for (const l of parts(svg, "scenario")) await expect(Number(l.getAttribute("y2"))).toBeCloseTo(baseline, 3);
    await expect(parts(svg, "scenario-label")).toHaveLength(wide ? 2 : 0);
  },
});
export const BothWindowsReachZeroDesktop = BothWindowsReachZero.extend({ ...desktop });

/* ── Unknown, crowded, very low ─────────────────────────────────────────────── */

/** Nothing measured in the range: bands only, no series, no point, and `?` everywhere a number would be. */
export const AllUnknown = meta.story({
  ...phone,
  args: { points: allUnknown, markers: [], scenarios: [SHORT_NONE, LONG_NONE], unmeasuredReason: "no measurements yet", nowState: undefined },
  play: async (ctx) => {
    const { svg } = await open(ctx);
    await expect(parts(svg, "segment")).toHaveLength(0);
    await expect(svg.querySelector('[data-part="latest"]')).toBeNull();
    await expect(parts(svg, "band-low")).toHaveLength(1);
    await expect(caption(ctx.canvasElement)).toContain("? not measured · no measurements yet");
    await expect(svg.getAttribute("aria-label")).toContain("No measurements in this range.");
    await tableMatchesPoints(ctx.canvasElement, ctx.userEvent);
  },
});
export const AllUnknownDesktop = AllUnknown.extend({ ...desktop });

/** Three events within six hours of each other: one `2–4` box, three rules, four list rows. */
export const EventCluster = meta.story({
  ...phone,
  args: { markers: CLUSTERED_EVENTS },
  play: async (ctx) => {
    const { svg } = await open(ctx);
    await expect(parts(svg, "event-rule")).toHaveLength(4);
    const boxes = parts(svg, "event-box");
    await expect(boxes.map((b) => b.textContent)).toEqual(["1", "2–4"]);
    const rects = boxes.map((b) => b.querySelector("rect")!.getBoundingClientRect());
    await expect(rects[1]!.left).toBeGreaterThanOrEqual(rects[0]!.right);
    await expect(ctx.canvasElement.querySelectorAll('[data-part="event-list"] li')).toHaveLength(4);
  },
});
export const EventClusterDesktop = EventCluster.extend({ ...desktop });

/** Very low now: the series is under the Very low level, and the 7-day line meets zero inside the plot. */
export const VeryLowNow = meta.story({
  ...phone,
  args: { points: veryLowNow, nowState: "Very low", scenarios: [SHORT_VERY_LOW, LONG_SHORT_HISTORY] },
  play: async (ctx) => {
    const { svg } = await open(ctx);
    const latest = svg.querySelector('[data-part="latest"]')!.getBoundingClientRect();
    const veryLow = svg.querySelector('[data-part="band-veryLow"] line')!.getBoundingClientRect();
    await expect(latest.top + latest.height / 2).toBeGreaterThan(veryLow.top);
    const line = parts(svg, "scenario")[0]!;
    const baseline = Number(svg.querySelector('[data-part="y-tick"] line')!.getAttribute("y1"));
    await expect(Number(line.getAttribute("y2"))).toBeCloseTo(baseline, 3);
    await expect(svg.getAttribute("aria-label")).toContain("Now 7.2 GB, Very low.");
  },
});
export const VeryLowNowDesktop = VeryLowNow.extend({ ...desktop });

/* ── Greyscale, zoom, motion ────────────────────────────────────────────────── */

const ALL_CASES: Array<[string, Partial<HistoryChartProps>, number?]> = [
  ["Full", {}],
  ["Gap", { points: sixHourGap }],
  ["No projection", { points: sixHourGap, scenarios: [SHORT_GAP, LONG_GAP] }],
  ["One window", { points: sixHourGap, scenarios: [SHORT_FINITE, LONG_SHORT_HISTORY] }],
  ["Non-depleting", { scenarios: [SHORT_FLAT, LONG_FINITE] }],
  ["Weekly, 3 points", { points: weeklyThree, intervalMs: 7 * DAY, markers: [], scenarios: [SHORT_FINITE, LONG_SHORT_HISTORY], notes: ["Weekly history starts 28 Jun · 3 points so far"] }, 2],
  ["Single point", { points: singlePoint, markers: [], scenarios: [SHORT_NONE, LONG_NONE] }],
  ["Scope change", { points: scopeChanged, markers: [], scenarios: [SHORT_FINITE, LONG_SCOPE] }],
  ["All unknown", { points: allUnknown, markers: [], scenarios: [SHORT_NONE, LONG_NONE], unmeasuredReason: "no measurements yet" }],
  ["Event cluster", { markers: CLUSTERED_EVENTS }],
  ["Very low now", { points: veryLowNow, nowState: "Very low", scenarios: [SHORT_VERY_LOW, LONG_SHORT_HISTORY] }],
];

/**
 * Every state with the colour taken away. `grayscale(1)` removes the one
 * channel no meaning may rest on, and the assertions are on what survives:
 * the threshold glyphs and words, `?` at each gap, the hollow provisional
 * point, the dash that tells the windows apart, `↺ scope changed`, and the
 * event numbers.
 */
export const Greyscale = meta.story({
  ...phone,
  render: (args) => (
    <div style={{ filter: "grayscale(1)", display: "flex", flexDirection: "column", gap: 16 }}>
      {ALL_CASES.map(([title, over, tier]) => (
        <HistoryCard key={title} title={title} tier={tier ?? 0}>
          <HistoryChart {...args} {...over} />
        </HistoryCard>
      ))}
    </div>
  ),
  play: async ({ canvasElement, globals, parameters }) => {
    const width = (parameters.viewportWidth as number | undefined) ?? PHONE;
    await openAt(width, globals);
    await waitFor(() => expect(canvasElement.querySelectorAll(`svg[data-layout="${width === DESKTOP ? "gutter" : "caption"}"]`)).toHaveLength(ALL_CASES.length));
    const charts = [...canvasElement.querySelectorAll<HTMLElement>('[data-part="history-chart"]')];
    const text = (i: number) => charts[i]!.textContent ?? "";
    for (let i = 0; i < charts.length; i += 1) {
      await expect(text(i)).toContain("△ Low");
      await expect(text(i)).toContain("▲ Very low");
    }
    await expect(text(1)).toContain("?");
    await expect(text(2)).toContain("No projection");
    await expect(text(7)).toContain("↺ scope changed");
    await expect(text(8)).toContain("? not measured");
    await expect([...charts[9]!.querySelectorAll('[data-part="event-box"]')].map((b) => b.textContent)).toEqual(["1", "2–4"]);
    // Hollow vs filled: the provisional point is painted in the surface, not the series ink.
    const latest = charts[0]!.querySelector('[data-part="latest"]')!;
    await expect(latest.getAttribute("fill")).not.toBe(latest.getAttribute("stroke"));
    // The windows differ by dash pattern, not by hue.
    const dashes = [...charts[0]!.querySelectorAll('[data-part="scenario"]')].map((l) => l.getAttribute("stroke-dasharray"));
    await expect(new Set(dashes).size).toBe(2);
    for (const line of charts[0]!.querySelectorAll('[data-part="scenario"]')) await expect(line.getAttribute("stroke")).toBe(charts[0]!.querySelector('[data-part="scenario"]')!.getAttribute("stroke"));
  },
});
export const GreyscaleDesktop = Greyscale.extend({ ...desktop });

/**
 * 200% zoom on a 320px phone: a 136px chart. Nothing scrolls sideways, the
 * captions and the table wrap, and View as table is still a 44px target.
 */
export const Zoom200 = meta.story({
  ...phone,
  args: { points: sixHourGap },
  play: async ({ canvasElement, globals, userEvent }) => {
    await openAt(PHONE, globals);
    const zoom = document.documentElement.style.zoom;
    document.documentElement.style.zoom = "2";
    try {
      // 320px at 200% lays out 160 CSS px: the chart gets what is left inside the gutters.
      await waitFor(() => expect(Number(svgOf(canvasElement)!.getAttribute("width"))).toBeLessThanOrEqual(136));
      await expect(svgOf(canvasElement)!.dataset.layout).toBe("caption");
      await chartHolds(canvasElement);
      await tableMatchesPoints(canvasElement, userEvent);
      const button = [...canvasElement.querySelectorAll("button")].find((b) => b.textContent?.includes("View as table"))!;
      await userEvent.click(button);
      await expect(document.documentElement.scrollWidth, "the open table wraps at 200%").toBeLessThanOrEqual(document.documentElement.clientWidth);
    } finally {
      document.documentElement.style.zoom = zoom;
    }
  },
});

/** Nothing animates, so there is no reduced-motion variant: no transition or animation anywhere in the chart. */
export const NoMotion = meta.story({
  ...phone,
  play: async (ctx) => {
    const { svg } = await open(ctx);
    for (const el of [svg, ...svg.querySelectorAll("*")]) {
      const s = getComputedStyle(el);
      await expect(s.animationName, "no animation").toBe("none");
      await expect(s.transitionDuration.split(",").every((d) => parseFloat(d) === 0), "no transition").toBe(true);
    }
  },
});
