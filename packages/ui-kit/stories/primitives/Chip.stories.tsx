import preview from "#.storybook/preview";

import { Chip } from "../../src/primitives/Chip.js";
import type { ChipVariant, Tone } from "../../src/types.js";
import { knownContrastGap, Row, stage } from "../_stage.js";

const VARIANTS: ChipVariant[] = [
  "outline",
  "soft",
  "solid",
  "pill",
  "kv",
  "effect",
  "mono",
  "count",
  "ghost",
];
const TONES: Tone[] = ["amber", "teal", "red", "gold", "purple", "blue", "neutral"];

const meta = preview.meta({
  title: "Primitives/Chip",
  component: Chip,
  decorators: [stage],
  args: { label: "untrusted · oracle", variant: "outline", tone: "purple" },
  argTypes: {
    variant: { control: "select", options: VARIANTS },
    tone: { control: "select", options: TONES },
    icon: { control: "text" },
  },
});

export const Default = meta.story({});

/** Provenance: purple is untrusted origin. */
export const Provenance = Default.extend({ args: { label: "untrusted · oracle", tone: "purple" } });

/** A filter pill, selected. Selection swaps the border to the full accent and
 * fills with the tint. */
export const SelectedFilter = Default.extend({
  args: { label: "danger", variant: "pill", tone: "red", selected: true, icon: "policy" },
});

/** Frontmatter, rendered as it is stored. */
export const KeyValue = Default.extend({ args: { label: "place: aeaea", variant: "kv", tone: "teal" } });

/** An effect chip: the mono name of what a tap will actually do. */
export const Effect = Default.extend({ args: { label: "write_policy", variant: "effect", tone: "amber" } });

/** The one chip that paints white on a solid fill — 2.77:1 at 9px, the widest
 * miss in the kit. Every fill in this palette was chosen to glow against
 * near-black, so white on one of them is the wrong way round. See
 * design-feedback §6. */
export const Count = Default.extend({
  args: { label: "12", variant: "count", tone: "red" },
  parameters: knownContrastGap(
    "variant=count paints --bk-chip-count-ink (white) on the solid tone fill: 2.77:1 at 9px. See design-feedback §6.",
  ),
});

export const Caps = Default.extend({ args: { label: "hostile", variant: "soft", tone: "red", caps: true } });

/**
 * Every variant against every tone. Shape comes from `variant`, meaning from
 * `tone`, and this is the story that proves the two axes are independent.
 */
export const VariantsByTone = meta.story({
  parameters: { stageWidth: "none" },
  render: () => (
    <>
      {VARIANTS.map((variant) => (
        <Row key={variant} caption={variant}>
          {TONES.map((tone) => (
            <Chip key={tone} variant={variant} tone={tone} label={variant === "count" ? "7" : tone} />
          ))}
        </Row>
      ))}
    </>
  ),
});

/** With a glyph, which inherits the chip's own colour. */
export const WithIcons = meta.story({
  render: () => (
    <Row caption="icons">
      <Chip label="crew" icon="files" tone="teal" variant="soft" />
      <Chip label="Poseidon" icon="policy" tone="red" variant="outline" />
      <Chip label="Athena" icon="trust" tone="blue" variant="soft" />
      <Chip label="sirens" icon="deadline" tone="gold" variant="pill" />
    </Row>
  ),
});
