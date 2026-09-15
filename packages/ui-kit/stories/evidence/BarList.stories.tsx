import preview from "#.storybook/preview";

import { crewBars, estateBars, estateFootnote, weekSpend } from "../../fixtures/money.js";
import { BarList } from "../../src/evidence/BarList.js";
import { stage, wide } from "../_stage.js";

const meta = preview.meta({
  title: "Evidence/BarList",
  component: BarList,
  decorators: [stage],
  args: { rows: weekSpend, barWidth: 74 },
  argTypes: {
    barWidth: { control: { type: "number", min: 40, max: 140, step: 1 } },
    valueWidth: { control: { type: "number", min: 30, max: 90, step: 1 } },
  },
});

/**
 * Where the week's spend went, by agent. The bar colour identifies the CLASS of
 * work and is the same palette on the budget, activity and digest surfaces — it
 * is not a per-chart choice.
 */
export const Default = meta.story({});

/** The same ledger the `DataTable` story tabulates, as proportion rather than
 * detail. Both are derived from one fixture, so they cannot disagree. */
export const CrewLosses = Default.extend({ args: { rows: crewBars, valueWidth: 36 } });

/** What a hundred and eight guests have eaten in four years. The value column
 * carries a phrase rather than a figure, which is why it needs the width. */
export const Estate = Default.extend({
  args: { rows: estateBars, barWidth: 60, valueWidth: 88 },
  parameters: { docs: { description: { story: estateFootnote } } },
});

/** Percentages are clamped to 0-100: a bar longer than its own track would be a
 * chart lying about a fraction. */
export const Clamped = Default.extend({
  args: {
    rows: [
      { label: "over", pct: 140, value: "140%", tone: "red" },
      { label: "under", pct: -20, value: "0%", tone: "neutral" },
      { label: "exact", pct: 100, value: "100%", tone: "teal" },
    ],
  },
});

export const Wide = Default.extend({ parameters: wide });
