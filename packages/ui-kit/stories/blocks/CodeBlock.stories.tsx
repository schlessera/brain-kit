import { expect, waitFor } from "storybook/test";

import preview from "#.storybook/preview";

import { reindexCommand } from "../../fixtures/notes.js";
import { CodeBlock } from "../../src/blocks/CodeBlock.js";
import { stage, wide } from "../_stage.js";

const meta = preview.meta({
  title: "Blocks/CodeBlock",
  component: CodeBlock,
  decorators: [stage],
  args: reindexCommand,
  argTypes: { fontSize: { control: { type: "number", min: 9, max: 13, step: 0.5 } } },
});

/**
 * Something to run or paste. Deliberately not syntax-highlighted: mono type
 * already means "machine" in this app, and colour is reserved for decisions.
 * The copy glyph is decorative — `ui-kit` has no browser globals to copy with.
 */
export const Default = meta.story({});

/** Head off, for a block already introduced by its surrounding prose. */
export const NoHead = Default.extend({ args: { head: false } });

/** Several lines, wrapped by default to fit a narrow chat column. */
export const Multiline = Default.extend({
  args: {
    code: "brain index --path omens/ --force\nbrain search 'scylla' --json\nbrain doctor",
    caption: "three commands, in order",
  },
});

/** `wrap: false` preserves lines with native horizontal scrolling;
 * worth seeing before choosing it. */
export const NoWrap = Default.extend({
  args: {
    wrap: false,
    code: "brain index --path omens/ --force --reembed --model text-embedding-3-large",
  },
  play: async ({ canvasElement, userEvent }) => {
    const pre = canvasElement.querySelector("pre")!;
    await userEvent.tab();
    await expect(pre).toHaveFocus();
    pre.scrollLeft = pre.scrollWidth;
    await waitFor(() => expect(Math.abs(pre.scrollWidth - pre.clientWidth - pre.scrollLeft)).toBeLessThanOrEqual(1));
  },
});

export const Wide = Default.extend({ parameters: wide });
