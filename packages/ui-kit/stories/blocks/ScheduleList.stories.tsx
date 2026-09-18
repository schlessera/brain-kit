import preview from "#.storybook/preview";

import { today } from "../../fixtures/events.js";
import { ScheduleList } from "../../src/blocks/ScheduleList.js";
import { stage, wide } from "../_stage.js";

const meta = preview.meta({
  title: "Blocks/ScheduleList",
  component: ScheduleList,
  decorators: [stage],
  args: { groups: today },
  argTypes: { timeWidth: { control: { type: "number", min: 36, max: 90, step: 1 } } },
});

/**
 * Today and the day at the end of it. The left rail is the item's claim on
 * you: amber a commitment, teal something handled for you, red a deadline.
 */
export const Default = meta.story({});

/**
 * `neutral` draws the `edge` HAIRLINE rather than a grey bar — the source's own
 * table, and the reason an FYI reads as a rule instead of as a fourth colour.
 * Every other component in the kit resolves `neutral` to the ink ramp.
 */
export const NeutralIsAHairline = Default.extend({
  args: {
    groups: [
      {
        day: "Tomorrow",
        items: [
          { time: "—", title: "Wind holds, per the forecast" },
          { time: "—", title: "Wind holds, per the forecast", tone: "teal" },
        ],
      },
    ],
  },
});

/** `tag: "conflict"` forces the pill gold whatever the rail says, because a
 * clash is a clash however you were planning to spend the hour. */
export const Conflict = Default.extend({
  args: {
    groups: [
      {
        day: "Wednesday",
        meta: "2 items",
        items: [
          { time: "06:00", title: "Scheria, if the forecast holds", tone: "teal", tag: "conflict" },
          { time: "06:00", title: "Water runs out", tone: "red", tag: "hard" },
        ],
      },
    ],
  },
});

export const Wide = Default.extend({ parameters: wide });
