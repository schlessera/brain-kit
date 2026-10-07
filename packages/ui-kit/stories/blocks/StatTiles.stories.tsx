import preview from "#.storybook/preview";

import { digestStats } from "../../fixtures/events.js";
import { answerStats } from "../../fixtures/search.js";
import { StatTiles } from "../../src/blocks/StatTiles.js";
import { stage, wide } from "../_stage.js";

const meta = preview.meta({
  title: "Blocks/StatTiles",
  component: StatTiles,
  decorators: [stage],
  args: { tiles: digestStats },
  argTypes: { minTile: { control: { type: "number", min: 90, max: 220, step: 1 } } },
});

/**
 * Numbers that answer a question at a glance. Display serif, so they read
 * as an answer rather than as a dashboard, and only the numbers that imply
 * something to do about them are coloured.
 */
export const Default = meta.story({});

/** Exercise the component's no-props example, rather than the story args. */
export const Fallback = meta.story({ render: () => <StatTiles /> });

/** Three, above a structured answer. Three is the shape at a phone width; D22
 * allows a fourth past 1100px. */
export const Three = Default.extend({ args: { tiles: answerStats } });

export const Two = Default.extend({ args: { tiles: digestStats.slice(0, 2) } });

/**
 * An UNTONED value is primary ink — an unremarkable number is still a number
 * you read — and `neutral` is the grey accent, for a value that is machine
 * meta rather than an answer (D33). Side by side with an amber tile, the
 * difference is the whole reason the component reads as prose.
 */
export const UntonedIsInk = Default.extend({
  args: {
    tiles: [
      { label: "days out", value: "3,652", icon: "history" },
      { label: "run", value: "#4c1", icon: "activity", tone: "neutral" },
      { label: "waiting on you", value: "3", icon: "approval", tone: "amber" },
    ],
  },
});

/** The wider prose measure retains D22's three-column cap. */
export const Wide = Default.extend({ parameters: wide });

/** D22 allows all four fallback tiles on a row past 1100px. */
export const DesktopFallback = Fallback.extend({ parameters: { stageWidth: 1280 } });
