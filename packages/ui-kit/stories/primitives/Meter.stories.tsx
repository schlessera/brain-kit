import preview from "#.storybook/preview";

import { Meter } from "../../src/primitives/Meter.js";
import type { Tone } from "../../src/types.js";
import { Row, stage, wide } from "../_stage.js";

const TONES: Tone[] = ["teal", "amber", "red", "gold", "purple", "blue", "neutral"];

const meta = preview.meta({
  title: "Primitives/Meter",
  component: Meter,
  decorators: [stage],
  args: { value: 38, tone: "teal", variant: "row", label: "supplies", valueText: "9 days / 20", height: 5 },
  argTypes: {
    value: { control: { type: "range", min: 0, max: 100, step: 1 } },
    reserve: { control: { type: "range", min: 0, max: 100, step: 1 } },
    tone: { control: "select", options: TONES },
    variant: { control: "select", options: ["bar", "row"] },
    height: { control: { type: "number", min: 3, max: 10, step: 1 } },
  },
});

/** Read-only by design: nothing in the kit lets the user drag a meter. */
export const Default = meta.story({});

/** `bar` stacks the label above the track instead of putting it on the left. */
export const Stacked = Default.extend({
  args: { variant: "bar", label: "crew remaining", valueText: "6 of 12", value: 50, tone: "red" },
});

/** The reserve segment is drawn in red after the fill — the part of a budget
 * that is committed but not yet spent. */
export const WithReserve = Default.extend({
  args: { label: "water", value: 42, reserve: 18, valueText: "42% + 18% held", tone: "amber" },
});

export const Full = Default.extend({ args: { value: 100, label: "days at Troy", valueText: "10 of 10" } });

/** The value is clamped to 0-100, so a caller that computes 140% still draws a
 * full track rather than overflowing it. */
export const Overflowing = Default.extend({
  args: { value: 140, label: "years away", valueText: "20 of 10", tone: "red" },
});

export const Gradient = Default.extend({ args: { gradient: true, value: 72, label: "route" } });

export const Wide = Default.extend({ parameters: wide });

export const Tones = meta.story({
  render: () => (
    <>
      {TONES.map((tone) => (
        <Row key={tone} caption={tone}>
          <div style={{ flex: 1, minWidth: 160 }}>
            <Meter tone={tone} value={62} label="progress" valueText="62%" />
          </div>
        </Row>
      ))}
    </>
  ),
});
