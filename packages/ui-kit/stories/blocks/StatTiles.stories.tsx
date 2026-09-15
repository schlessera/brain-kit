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
 * Four numbers that answer a question at a glance. Display serif, so they read
 * as an answer rather than as a dashboard, and only the numbers that imply
 * something to do about them are coloured.
 */
export const Default = meta.story({});

/** Three, above a structured answer. Three is the shape at a phone width; D22
 * allows a fourth past 1100px. */
export const Three = Default.extend({ args: { tiles: answerStats } });

export const Two = Default.extend({ args: { tiles: digestStats.slice(0, 2) } });

/**
 * `neutral` is the INK ramp here, not the neutral accent — an unremarkable
 * number is still a number you read. Side by side with an amber tile, the
 * difference is the whole reason the component reads as prose.
 */
export const NeutralIsInk = Default.extend({
  args: {
    tiles: [
      { label: "days out", value: "3,652", icon: "history", tone: "neutral" },
      { label: "waiting on you", value: "3", icon: "approval", tone: "amber" },
    ],
  },
});

/** A wider basis packs fewer per row; `wide` shows all four on one line. */
export const Wide = Default.extend({ parameters: wide });
