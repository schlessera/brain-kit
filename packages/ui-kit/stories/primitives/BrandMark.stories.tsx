import preview from "#.storybook/preview";

import { BrandMark } from "../../src/primitives/BrandMark.js";
import { Row, stage } from "../_stage.js";

const meta = preview.meta({
  title: "Primitives/BrandMark",
  component: BrandMark,
  decorators: [stage],
  args: { variant: "mark", size: 32 },
  argTypes: {
    variant: { control: "inline-radio", options: ["mark", "lockup"] },
    size: { control: { type: "number", min: 16, max: 160, step: 1 } },
    label: { control: "text" },
  },
});

/** The master mark. Ink and amber follow the theme's tokens. */
export const Mark = meta.story({});

/** Below 24px the small-size master takes over: a wider fissure, a larger tail. */
export const MarkSmall = Mark.extend({ args: { size: 16 } });

/** Mark and the outlined `brain-kit` wordmark. */
export const Lockup = meta.story({ args: { variant: "lockup", size: 40 } });

/** At its 20px minimum the lockup still uses the master mark. */
export const LockupMinimum = Lockup.extend({ args: { size: 20 } });

/** Standing alone as a link or heading, the logo carries a name. */
export const Labelled = Lockup.extend({ args: { label: "brain-kit" } });

/** Every size the spec renders, on the current theme's canvas. */
export const Sizes = meta.story({
  parameters: { stageWidth: "none" },
  render: () => (
    <>
      <Row caption="mark">
        {[16, 20, 23, 24, 32, 48, 64].map((size) => (
          <BrandMark key={size} size={size} />
        ))}
      </Row>
      <Row caption="lockup">
        {[20, 32, 48].map((size) => (
          <BrandMark key={size} variant="lockup" size={size} />
        ))}
      </Row>
    </>
  ),
});
