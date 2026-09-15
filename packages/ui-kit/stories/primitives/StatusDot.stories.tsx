import preview from "#.storybook/preview";

import { StatusDot } from "../../src/primitives/StatusDot.js";
import type { Tone } from "../../src/types.js";
import { Row, stage } from "../_stage.js";

const TONES: Tone[] = ["amber", "teal", "red", "gold", "purple", "blue", "neutral"];

const meta = preview.meta({
  title: "Primitives/StatusDot",
  component: StatusDot,
  decorators: [stage],
  args: { tone: "amber", size: 7 },
  argTypes: {
    tone: { control: "select", options: TONES },
    size: { control: { type: "number", min: 4, max: 14, step: 1 } },
  },
});

/**
 * Unset, a dot does NOT breathe. `data-props` seeds the editor control at
 * `true`, but `renderVals()` reads `p.pulse` bare — and a dot that breathes
 * when nobody asked says an agent is working.
 */
export const Default = meta.story({});

/** Amber and breathing: the agent is acting, or wants your approval. */
export const Acting = Default.extend({ args: { pulse: true } });

export const Large = Default.extend({ args: { size: 14, tone: "teal" } });

/** The full semantic set. */
export const Tones = meta.story({
  render: () => (
    <>
      {TONES.map((tone) => (
        <Row key={tone} caption={tone}>
          <StatusDot tone={tone} />
          <StatusDot tone={tone} pulse />
          <StatusDot tone={tone} size={12} />
        </Row>
      ))}
    </>
  ),
});
