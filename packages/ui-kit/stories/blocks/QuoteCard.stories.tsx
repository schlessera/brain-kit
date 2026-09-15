import preview from "#.storybook/preview";

import { forecastQuote, nameQuote } from "../../fixtures/notes.js";
import { QuoteCard } from "../../src/blocks/QuoteCard.js";
import { stage, wide } from "../_stage.js";

const meta = preview.meta({
  title: "Blocks/QuoteCard",
  component: QuoteCard,
  decorators: [stage],
  args: forecastQuote,
});

/**
 * Verbatim evidence with its citation attached. The path and the locator are
 * real, so the reader can go and check the sentence rather than trust it.
 */
export const Default = meta.story({});

/** A second quote, and the reason the tone set has no red: the rail says where
 * the words came from, not how badly it went. */
export const OwnWords = Default.extend({ args: nameQuote });

/** Display serif, for a quote that is doing the work of a pull quote. */
export const Serif = Default.extend({ args: { serif: true } });

/** Upright, for a quote long enough that italic becomes hard to read. */
export const Upright = Default.extend({ args: { italic: false } });

/** No note. The card is then evidence with no argument attached, which is what
 * a Files-screen quote is. */
export const NoNote = Default.extend({ args: { note: "" } });

export const Wide = Default.extend({ parameters: wide });
