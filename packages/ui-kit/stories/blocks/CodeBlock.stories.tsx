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

/** Several lines, wrapped. Wrapping is on by default because a chat column is
 * narrow and a horizontally scrolling code block inside a transcript is a
 * scroll container nobody finds. */
export const Multiline = Default.extend({
  args: {
    code: "brain index --path omens/ --force\nbrain search 'scylla' --json\nbrain doctor",
    caption: "three commands, in order",
  },
});

/** `wrap: false` clips rather than scrolls, which is the source's behaviour and
 * worth seeing before choosing it. */
export const NoWrap = Default.extend({
  args: {
    wrap: false,
    code: "brain index --path omens/ --force --reembed --model text-embedding-3-large",
  },
});

export const Wide = Default.extend({ parameters: wide });
