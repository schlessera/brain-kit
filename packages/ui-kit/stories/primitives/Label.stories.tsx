import preview from "#.storybook/preview";

import { Label } from "../../src/primitives/Label.js";
import type { LabelTone } from "../../src/types.js";
import { Row, stage, wide } from "../_stage.js";

const TONES: LabelTone[] = ["neutral", "amber", "teal", "red", "gold", "purple", "blue", "ink"];

const meta = preview.meta({
  title: "Primitives/Label",
  component: Label,
  decorators: [stage],
  args: { text: "Open loops", caps: true, size: 9.5 },
  argTypes: {
    tone: { control: "select", options: TONES },
    size: { control: { type: "number", min: 9, max: 13, step: 0.5 } },
    icon: { control: "text" },
  },
});

/** The specimen: 9.5px / 600 / .09em, uppercase, mono, ink-mute. */
export const Default = meta.story({});

/** `meta` is pushed to the far right of the row, which is why Label is a flex
 * container and not a span. */
export const WithMeta = Default.extend({ args: { text: "Open loops", meta: "4 unresolved" } });

export const WithIcon = Default.extend({ args: { text: "Route home", icon: "graph", tone: "teal" } });

/** `caps: false` drops the tracking and the uppercase together. */
export const Sentence = Default.extend({
  args: { text: "Day 2,914 away from home", caps: false, size: 11 },
});

export const Wide = WithMeta.extend({ parameters: wide });

export const Tones = meta.story({
  render: () => (
    <>
      {TONES.map((tone) => (
        <Row key={tone} caption={tone}>
          <Label text="Open loops" tone={tone} meta="4" />
        </Row>
      ))}
    </>
  ),
});
