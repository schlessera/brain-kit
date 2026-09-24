/**
 * The non-colour cue each tone carries (#309).
 *
 * Several answer blocks said something in ink colour alone — a red cell is
 * overdue, a gold value is one to watch — and a grayscale print, or a reader
 * who cannot tell the hues apart, lost it (D46, known limits). D20's first
 * rule is that a monochrome screenshot must still parse, so each meaning a
 * tone carries now also draws a glyph from the kit's own icon vocabulary.
 *
 * The cue is DERIVED FROM `tone`: no payload field, no prop, no token and no
 * icon key is added, so a payload means exactly what it meant before and
 * simply draws one more mark. A glyph rather than a word, a weight or a
 * pattern, because an inline SVG needs no web font (the print path cannot
 * load one), costs 11-14px where a word costs 40-70 at a phone width, and
 * adds no border or wash for the print theme to flatten.
 *
 * Only tones that ask something of the reader get one. Teal ("ok") is the
 * default reading of any unmarked value, and a tick on every teal cell would
 * bury the red ones. Blue is a category the text already names. `neutral`
 * is the grey accent (D33): it prints as grey, and grey is its meaning.
 * `ink` and `dim` are inks, not tones.
 *
 * `tests/tone-cue.test.ts` pins every entry and checks each glyph key
 * resolves, the way `icon-map.test.ts` does for the icon map itself.
 */

import type { IconName } from "../primitives/Icon.js";
import type { Tone, ValueTone } from "../types.js";

/**
 * A value that is judged: a `StatTiles` value, a `DataTable` or
 * `ComparisonTable` cell, a `Receipt` row, a `ContactCard` fact, a
 * `TrendChart` delta. One meaning everywhere, so one table.
 *
 * Three silhouettes (triangle, circle, hand) plus a question mark stay
 * distinct at 11px in grayscale, and none of them resembles the tick
 * `StepList` draws for done.
 */
export const VALUE_CUE: Record<ValueTone, IconName | null> = {
  red: "failed", // failed, overdue, bad
  gold: "fyi", // caution, watch it
  amber: "hand", // your approval or action needed
  purple: "unverified", // untrusted origin
  teal: null,
  blue: null,
  neutral: null,
  ink: null,
  dim: null,
};

/**
 * A `TimelineList` tone names a KIND of event rather than a judgement:
 * teal decided, amber the agent acted, red failed, purple came from
 * outside. `neutral` is "noted", and a grey dot is the absence of a claim.
 */
export const TIMELINE_CUE: Record<Tone, IconName | null> = {
  teal: "confirm",
  amber: "agent",
  red: "failed",
  purple: "unverified",
  gold: "fyi",
  blue: null,
  neutral: null,
};

/**
 * A `ScheduleList` tone is the item's claim on you: red a deadline, amber a
 * commitment of yours, teal something the agent will handle. Where the
 * meanings agree with the value map the glyph agrees too: the hand is
 * "yours", the bot is the agent's.
 */
export const SCHEDULE_CUE: Record<Tone, IconName | null> = {
  red: "deadline",
  amber: "hand",
  teal: "agent",
  gold: "fyi",
  purple: "unverified",
  blue: null,
  neutral: null,
};
