import preview from "#.storybook/preview";

import { PathRef } from "../../src/primitives/PathRef.js";
import type { Tone } from "../../src/types.js";
import { Row, stage } from "../_stage.js";

const VARIANTS = ["chip", "inline", "link", "plain"] as const;
const TONES: Tone[] = ["teal", "blue", "purple", "amber", "gold", "red", "neutral"];

const meta = preview.meta({
  title: "Primitives/PathRef",
  component: PathRef,
  decorators: [stage],
  args: { text: "voyage/scylla-vs-charybdis.md", tone: "teal", variant: "chip", icon: "file" },
  argTypes: {
    variant: { control: "select", options: VARIANTS },
    tone: { control: "select", options: TONES },
    icon: { control: "text" },
    fontSize: { control: { type: "number", min: 9, max: 13, step: 0.5 } },
  },
});

/** Teal is a file or a person. */
export const Default = meta.story({});

/** Purple is a project. */
export const Project = Default.extend({
  args: { text: "projects/get-home-after-troy", tone: "purple", icon: "folder" },
});

/** Amber is the thing currently in focus. */
export const InFocus = Default.extend({
  args: { text: "notes/do-not-name-myself-to-polyphemus.md", tone: "amber", icon: "edit" },
});

/** `meta` is the dimmer suffix — a line, a size, a timestamp. */
export const WithMeta = Default.extend({
  args: { text: "people/penelope.md", meta: ":24", tone: "teal", icon: "file" },
});

/** `inline` breaks anywhere, which is what lets a long path sit inside prose
 * without forcing its container wider. The proof is the narrow stage. */
export const InlineInProse = meta.story({
  parameters: { stageWidth: 190 },
  args: {
    variant: "inline",
    icon: undefined,
    text: "journal/2026/day-2914-still-on-ogygia-waiting-for-a-following-wind.md",
  },
});

export const VariantsByTone = meta.story({
  parameters: { stageWidth: "none" },
  render: () => (
    <>
      {VARIANTS.map((variant) => (
        <Row key={variant} caption={variant}>
          {TONES.map((tone) => (
            <PathRef key={tone} variant={variant} tone={tone} text={`corpus/${tone}.md`} icon="file" />
          ))}
        </Row>
      ))}
    </>
  ),
});
