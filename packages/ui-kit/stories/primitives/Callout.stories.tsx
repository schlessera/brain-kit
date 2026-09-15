import preview from "#.storybook/preview";

import { Callout } from "../../src/primitives/Callout.js";
import type { CalloutVariant, Tone } from "../../src/types.js";
import { Row, stage, wide } from "../_stage.js";

const VARIANTS: CalloutVariant[] = ["accent", "boxed", "banner", "plain"];
const TONES: Tone[] = ["amber", "teal", "red", "gold", "purple", "blue", "neutral"];

const meta = preview.meta({
  title: "Primitives/Callout",
  component: Callout,
  decorators: [stage],
  args: {
    text: "Circe warned that Scylla takes six of the crew and Charybdis takes the ship.",
    tone: "amber",
    variant: "accent",
    icon: "deadline",
    italic: true,
  },
  argTypes: {
    variant: { control: "select", options: VARIANTS },
    tone: { control: "select", options: TONES },
    icon: { control: "text" },
  },
});

/** An editorial aside inside prose. */
export const Default = meta.story({});

/** A standing notice. `boxed` centres its icon rather than top-aligning it. */
export const Notice = Default.extend({
  args: {
    variant: "boxed",
    tone: "teal",
    icon: "suggestion",
    italic: false,
    text: "A following wind opens tomorrow and holds for three days.",
  },
});

/**
 * A provenance statement. `mono` switches the text to the tone colour as well
 * as the family — that is the banner look, and the design's rule is that it is
 * never used inside model prose.
 */
export const Provenance = Default.extend({
  args: {
    variant: "banner",
    tone: "purple",
    icon: "unverified",
    mono: true,
    italic: false,
    text: "source: an oracle at Aeaea · unverified · not corroborated",
  },
});

/** `trailing` pins a small mono chip to the right edge. */
export const WithTrailing = Default.extend({
  args: {
    variant: "boxed",
    tone: "red",
    icon: "failed",
    italic: false,
    text: "Poseidon has not been appeased since the Cyclops.",
    trailing: "20y",
  },
});

export const Wide = Default.extend({ parameters: wide });

export const VariantsByTone = meta.story({
  parameters: { stageWidth: "none" },
  render: () => (
    <div style={{ display: "flex", flexDirection: "column", gap: 14, width: "100%" }}>
      {VARIANTS.map((variant) => (
        <Row key={variant} caption={variant}>
          <div style={{ flex: 1, minWidth: 220, display: "flex", flexDirection: "column", gap: 8 }}>
            {TONES.map((tone) => (
              <Callout
                key={tone}
                variant={variant}
                tone={tone}
                icon="fyi"
                italic={false}
                text={`${variant} · ${tone}`}
              />
            ))}
          </div>
        </Row>
      ))}
    </div>
  ),
});
