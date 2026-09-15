import preview from "#.storybook/preview";
import { expect } from "storybook/test";

import { laneLegend, laneTicks, lanes } from "../../fixtures/runs.js";
import { HATCH_GLYPH, LaneChart } from "../../src/agents/LaneChart.js";
import { overflowing, stage, wide } from "../_stage.js";

const meta = preview.meta({
  title: "Agents/LaneChart",
  component: LaneChart,
  decorators: [stage],
  args: { lanes, ticks: laneTicks, legend: laneLegend, labelWidth: 88 },
  argTypes: { labelWidth: { control: { type: "range", min: 60, max: 140, step: 2 } } },
});

/**
 * The same four runs as `AgentOrbit`, on a real time axis. Two of them are
 * hatched, which is the only thing this chart says that the orbit cannot: those
 * runs are not slow, they are stopped, waiting on a person.
 */
export const Default = meta.story({});

/** A run with no known end fades out to the right rather than stopping at a
 * line it cannot justify. */
export const StillRunning = Default.extend({
  args: { lanes: [{ name: "researcher", tone: "amber", segments: [{ start: 2, width: 90, fade: true }] }] },
});

/** The gutter narrows for short names and widens for long ones — it is a prop
 * because a lane name is content and content is not one width. */
export const NarrowLabels = Default.extend({ args: { labelWidth: 60 } });

export const Wide = Default.extend({ parameters: wide });

/** No lanes at all still draws the axis and the key, because an activity screen
 * with nothing running is a true statement rather than a broken chart. */
export const Quiet = Default.extend({ args: { lanes: [] } });

/**
 * **Hatched means waiting on a person, and the legend has to agree with the
 * chart.** The source keys the half-alpha swatch off the glyph STRING, so a
 * legend row that spells it any other way silently draws the solid swatch and
 * says "running" where the chart says "stopped". `HATCH_GLYPH` is exported for
 * exactly that reason, and `fixtures/runs.ts` uses it.
 */
export const LegendMatchesTheChart = meta.story({
  play: async ({ canvas }) => {
    const hatched = await canvas.findByText(HATCH_GLYPH);
    const solid = (await canvas.findAllByText("■"))[0];
    // The half-alpha swatch is a different colour from the solid one, which is
    // the whole visual claim.
    await expect(getComputedStyle(hatched).color).not.toBe(getComputedStyle(solid).color);
    // And it really is a fraction of the same hue, not a second colour.
    await expect(getComputedStyle(hatched).color.startsWith("rgba(")).toBe(true);
  },
});

/** Segments are positioned as percentages of the lane, so the chart is fluid
 * and nothing escapes the track however narrow the column gets. */
export const SegmentsStayInTheTrack = meta.story({
  play: async ({ canvasElement }) => {
    const root = canvasElement.querySelector<HTMLElement>("div > div")!;
    await expect(overflowing(root)).toEqual([]);
    for (const track of root.querySelectorAll<HTMLElement>('span[style*="overflow: hidden"]')) {
      await expect(overflowing(track)).toEqual([]);
    }
  },
});

/** A lane chart is a picture, not a control: no roles, no tab stops, no hover
 * classes anywhere in it. */
export const Static = meta.story({
  play: async ({ canvasElement }) => {
    await expect(canvasElement.querySelector("[role]")).toBeNull();
    await expect(canvasElement.querySelector("[tabindex]")).toBeNull();
  },
});
