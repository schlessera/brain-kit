import preview from "#.storybook/preview";
import { expect } from "storybook/test";

import { crewBars, estateBars, estateFootnote, weekSpend } from "../../fixtures/money.js";
import { BarList, type BarListRow } from "../../src/evidence/BarList.js";
import { overflowing, stage, wide } from "../_stage.js";

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

/**
 * A label is the record, so it wraps rather than ellipsizing
 * (`docs/decisions/design-feedback.md`, "where truncation is allowed"; #174).
 * Configured taxonomy names are arbitrary: a phrase with spaces, a hyphenated
 * slug, and one camelCase word with no break opportunity at all, at
 * Storybook's own 320px "Small mobile" viewport with the widths a transcript
 * gives the breakdown.
 *
 * Three things have to hold: every label is on screen in full, nothing
 * reaches past the list, and each row's bar and figure stay on its label's
 * first line, so a continuation line can only belong to the row above it.
 */
const counts: [string, number][] = [
  ["sea-routes-and-navigation", 142],
  ["omens, prophecies and dreams at sea", 88],
  ["hospitality-obligations-xenia-and-guest-gifts", 61],
  ["trojanWarVeteranCorrespondenceArchive", 44],
  ["suitors", 31],
  ["35 other types", 146],
];
const total = counts.reduce((a, [, n]) => a + n, 0);
const longTaxonomy: BarListRow[] = counts.map(([label, n], i) => ({
  label,
  pct: Math.round((n / total) * 100),
  value: String(n),
  tone: i === counts.length - 1 ? "neutral" : "teal",
}));

export const LongTaxonomyWraps = meta.story({
  args: { rows: longTaxonomy, barWidth: 56, valueWidth: 40 },
  // The box a block gets in the chat on a 320px phone: 320 - 2 x 16 of the
  // message list's padding (`tests/visual/receipt-value-budget.visual.tsx`).
  parameters: { stageWidth: 288 },
  globals: { viewport: { value: "mobile1", isRotated: false } },
  play: async ({ canvas, canvasElement }) => {
    const list = canvasElement.firstElementChild!.firstElementChild as HTMLElement;
    // The box, not the window: the visual project renders this story at its
    // own viewport, and the stage pins the width either way.
    await expect(Math.round(list.getBoundingClientRect().width)).toBe(288);
    await expect(list.children.length).toBe(counts.length);
    await expect(overflowing(list)).toEqual([]);

    let wrapped = 0;
    for (const [name] of counts) {
      const label = canvas.getByText(name);
      // In full: nothing clipped inside its own box.
      await expect(label.scrollWidth).toBeLessThanOrEqual(label.clientWidth + 1);
      const lineHeight = parseFloat(getComputedStyle(label).lineHeight);
      const top = label.getBoundingClientRect().top;
      if (label.getBoundingClientRect().height > lineHeight * 1.5) wrapped++;

      // Bar and figure centred on the label's FIRST line, wherever it ends.
      const [track, value] = [label.nextElementSibling!, label.nextElementSibling!.nextElementSibling!];
      const trackBox = track.getBoundingClientRect();
      const valueBox = value.getBoundingClientRect();
      const firstLine = top + lineHeight / 2;
      await expect(Math.abs(trackBox.top + trackBox.height / 2 - firstLine)).toBeLessThanOrEqual(1);
      await expect(Math.abs(valueBox.top + valueBox.height / 2 - firstLine)).toBeLessThanOrEqual(1);
    }
    // The fixture is only proof if it actually made labels wrap: a phrase, a
    // slug and one unbroken word, long enough to wrap under the visual
    // project's narrower fallback face too.
    await expect(wrapped).toBeGreaterThanOrEqual(3);

    const doc = document.documentElement;
    await expect(doc.scrollWidth).toBeLessThanOrEqual(doc.clientWidth);
  },
});
