import preview from "#.storybook/preview";

import { overnight } from "../../fixtures/events.js";
import { searchTimeline } from "../../fixtures/search.js";
import { TimelineList } from "../../src/blocks/TimelineList.js";
import { stage, wide } from "../_stage.js";

const meta = preview.meta({
  title: "Blocks/TimelineList",
  component: TimelineList,
  decorators: [stage],
  args: { items: overnight },
  argTypes: { timeWidth: { control: { type: "number", min: 40, max: 110, step: 1 } } },
});

/**
 * Overnight, as the record has it. The dot's tone says what KIND of event it
 * was — purple an outside message, red a failure, teal something filed — and
 * the one still in flight is the only one that breathes.
 */
export const Default = meta.story({});

/** The same component on a voyage-day axis rather than a clock. The time
 * column is mono and fixed-width precisely so both read as a column. */
export const ByDay = Default.extend({ args: { items: searchTimeline, timeWidth: 44 } });

/** A wider time column, for an axis carrying full dates. */
export const WideTimeColumn = Default.extend({ args: { timeWidth: 92 } });

export const Wide = Default.extend({ parameters: wide });
