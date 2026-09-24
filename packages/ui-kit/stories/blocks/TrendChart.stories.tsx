import preview from "#.storybook/preview";
import { expect } from "storybook/test";

import { spendTrend, weekDailyCents } from "../../fixtures/money.js";
import { TrendChart } from "../../src/blocks/TrendChart.js";
import { stage, wide } from "../_stage.js";

const meta = preview.meta({
  title: "Blocks/TrendChart",
  component: TrendChart,
  decorators: [stage],
  args: spendTrend,
  argTypes: { height: { control: { type: "number", min: 36, max: 140, step: 1 } } },
});

/**
 * A short series. Bars rather than a line, because every bar is a real bucket
 * the user can ask about, and the LAST bar is drawn at full strength since
 * "today" is what they meant.
 */
export const Default = meta.story({});

/** No delta pill: a series with nothing to compare against says nothing rather
 * than showing a zero. */
export const NoDelta = Default.extend({ args: { delta: "" } });

export const Improving = Default.extend({ args: { delta: "-31% vs prev", deltaTone: "teal" } });

export const Tall = Default.extend({ args: { height: 120 } });

/** All-zero. The `0.0001` floor on the max is what keeps this from dividing by
 * zero; every bar draws at the 2px minimum instead of at NaN. */
export const AllZero = Default.extend({
  args: { values: [0, 0, 0, 0, 0, 0, 0], value: "$0.00", delta: "" },
});

export const Wide = Default.extend({ parameters: wide });

/**
 * THE EMPTY TICKS ARE LOAD-BEARING. A sparse axis labels three of seven
 * buckets, and the four unlabelled slots each render a TRANSPARENT middot so
 * they still hold their grid cell. Delete the placeholder and the axis drifts
 * by half a bar per missing label — a chart whose labels are off by one, which
 * is exactly the kind of wrong that survives review.
 *
 * This asserts the count and the alignment rather than the appearance: seven
 * ticks for seven bars, and each visible label centred on its own bucket.
 */
export const SparseAxisHoldsItsSlots = meta.story({
  args: { values: weekDailyCents, ticks: ["Thu", "", "", "Sun", "", "", "Wed"] },
  play: async ({ canvasElement }) => {
    const rows = canvasElement.querySelectorAll(":scope div > div > div");
    const axis = rows[rows.length - 1];
    const ticks = [...axis.children] as HTMLElement[];
    await expect(ticks).toHaveLength(7);

    // Every slot renders SOMETHING — the four blanks are transparent middots.
    for (const t of ticks) await expect(t.textContent).not.toBe("");

    // The bars are the row above the axis, one track per bucket. Found by
    // position rather than by `span > span`: the delta pill holds a glyph in
    // a span of its own (#309), and a nesting query would count it as a bar.
    const bars = [...(axis.previousElementSibling as HTMLElement).children] as HTMLElement[];
    await expect(bars).toHaveLength(7);

    // Each visible label sits under the bucket it names, to within a pixel.
    for (const i of [0, 3, 6]) {
      const tick = ticks[i].getBoundingClientRect();
      const bar = bars[i].getBoundingClientRect();
      await expect(Math.abs((tick.left + tick.right) / 2 - (bar.left + bar.right) / 2)).toBeLessThan(1.5);
    }
  },
});
