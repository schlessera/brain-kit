import preview from "#.storybook/preview";

import { DiffBlock } from "../../src/primitives/DiffBlock.js";
import { stage, wide } from "../_stage.js";

const meta = preview.meta({
  title: "Primitives/DiffBlock",
  component: DiffBlock,
  decorators: [stage],
  args: { text: "- crew: 12\n+ crew: 6", variant: "boxed", fontSize: 10.5, pad: 10 },
  argTypes: {
    variant: { control: "select", options: ["inset", "boxed"] },
    fontSize: { control: { type: "number", min: 9, max: 12, step: 0.5 } },
    pad: { control: { type: "number", min: 6, max: 16, step: 1 } },
  },
});

/** Monochrome on purpose: the +/- markers carry the meaning, and colour is
 * reserved for whether a human still has to decide something. */
export const Default = meta.story({});

/** `inset` drops the border and darkens, for a diff living inside another card. */
export const Inset = Default.extend({
  args: {
    variant: "inset",
    text: "  route: strait of messina\n- pass: charybdis\n+ pass: scylla\n  note: six lost, ship kept",
  },
});

/** Long lines wrap rather than scroll (`white-space: pre-wrap`), so a diff
 * never forces its container wider. */
export const LongLines = Default.extend({
  parameters: { stageWidth: 200 },
  args: {
    text: "- warning: the sirens sing to whoever hears them, and no one who hears them returns\n+ warning: stop the crew's ears with wax; tie me to the mast",
  },
});

export const Wide = Default.extend({ parameters: wide });
