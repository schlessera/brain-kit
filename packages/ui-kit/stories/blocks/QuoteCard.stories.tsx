import preview from "#.storybook/preview";
import { expect } from "storybook/test";

import { forecastQuote, nameQuote } from "../../fixtures/notes.js";
import { QuoteCard } from "../../src/blocks/QuoteCard.js";
import { overflowing, stage, wide } from "../_stage.js";

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

/**
 * A quote the model pulled out of a fetched page is as likely to be a URL as a
 * sentence, and a URL has no break opportunity in it. The quote and the note
 * are the card's two prose slots (the source row already ellipsises), so both
 * carry an unbroken run here, at Storybook's own 320px "Small mobile" viewport.
 * Two things have to hold: nothing reaches past the card, and nothing is
 * clipped — a quote is the record, so it wraps rather than truncating.
 *
 * `overflowing()` sees the card; the document-level check sees what the card
 * does to the page, which is the symptom the transcript column shows.
 */
const longUrl = "https://winds.example.invalid/omens/TheCattleOfHeliosAreNotToBeTouchedByAnyManOfThisCrewOnPainOfTheShipAndEveryManOnItTheCattleOfHeliosAreNotToBeTouchedByAnyManOfThisCrewOnPainOfTheShipAndEveryManOnIt";
const longNote = "run_7f3a9c1e7f3a9c1e7f3a9c1e7f3a9c1e7f3a9c1e7f3a9c1e7f3a9c1e7f3a9c1e7f3a9c1e7f3a9c1e7f3a9c1e7f3a9c1e7f3a9c1e7f3a9c1e7f3a9c1e7f3a9c1e7f3a9c1e7f3a9c1e7f3a9c1e7f3a9c1e7f3a9c1e7f3a9c1e7f3a9c1e7f3a9c1e7f3a";

export const LongUnbrokenRunWraps = meta.story({
  args: { quote: longUrl, note: longNote },
  globals: { viewport: { value: "mobile1", isRotated: false } },
  play: async ({ canvas, canvasElement }) => {
    await expect(longUrl.length).toBe(200);
    await expect(longNote.length).toBe(200);
    await expect(/\s/.test(longUrl + longNote)).toBe(false);
    await expect(window.innerWidth).toBe(320);

    const quote = canvas.getByText(longUrl);
    const card = quote.parentElement!;
    await expect(card).toBe(canvasElement.firstElementChild!.firstElementChild);
    await expect(overflowing(card)).toEqual([]);
    for (const el of [quote, canvas.getByText(longNote)]) {
      await expect(el.scrollWidth).toBeLessThanOrEqual(el.clientWidth + 1);
      // Wrapped, so the block is taller than one line.
      await expect(el.getBoundingClientRect().height).toBeGreaterThan(40);
    }
    const doc = document.documentElement;
    await expect(doc.scrollWidth).toBeLessThanOrEqual(doc.clientWidth);
  },
});
