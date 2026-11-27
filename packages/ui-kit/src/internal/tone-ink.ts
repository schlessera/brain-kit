import { accent, color } from "../tokens.js";
import type { ValueTone } from "../types.js";

/** Every accent's ink, plus the two inks that are not accents. */
const VALUE_INKS: Record<ValueTone, string> = {
  amber: accent.amber.ink,
  gold: accent.gold.ink,
  teal: accent.teal.ink,
  purple: accent.purple.ink,
  blue: accent.blue.ink,
  red: accent.red.ink,
  neutral: accent.neutral.ink,
  ink: color.ink,
  dim: color.inkDim,
};

/**
 * The ink of a value tone. Kit props are typed, not validated: a tone outside
 * the union reads as the site's own `fallback` rather than throwing.
 */
export function valueInk(tone: ValueTone, fallback: ValueTone): string {
  return VALUE_INKS[tone] || VALUE_INKS[fallback];
}
