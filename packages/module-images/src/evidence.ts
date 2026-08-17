/**
 * What the independent evidence says about relative image quality.
 *
 * The first version of this module refused to choose between providers on the
 * grounds that "no vendor publishes a head-to-head". That is true of vendors
 * and false of the field: there are public human-preference arenas with
 * millions of votes, and they agree more than they disagree.
 *
 * Everything encoded here is a preference ordering, not a capability. Nothing
 * in this file may override what a model can physically do — masks, formats,
 * transparency and dimensions are decided before any of this is consulted.
 *
 * ---------------------------------------------------------------------------
 * AS OF 2026-08-17. Re-check before trusting: this board moved materially in
 * the week before it was written (MAI-Image-2.6 entered at #2 on 2026-08-10).
 *
 * Sources:
 *   arena.ai text-to-image        https://arena.ai/leaderboard/text-to-image
 *   arena.ai text-rendering       https://arena.ai/leaderboard/text-to-image/text-rendering
 *   arena.ai image-edit           https://arena.ai/leaderboard/image-edit
 *   Artificial Analysis T2I       https://artificialanalysis.ai/image/leaderboard/text-to-image
 *   Artificial Analysis editing   https://artificialanalysis.ai/image/leaderboard/editing
 *   Gemini 3.1 Flash-Lite card    https://storage.googleapis.com/deepmind-media/Model-Cards/Gemini-3-1-Flash-Lite-Image-Model-Card.pdf
 *
 * Read the caveats before extending this: the three sources each measure a
 * DIFFERENT quality tier of gpt-image-2 (arena.ai medium, Artificial Analysis
 * high, Google's card low), arena.ai's Gemini entry runs with web search on,
 * and roughly 43% of arena prompts are photorealism, so the "overall" board is
 * substantially a photorealism board.
 */

/**
 * Default order for requests where capability does not decide.
 *
 * gpt-image-2 leads arena.ai's overall text-to-image board (1381 vs 1246 for
 * gemini-3-pro-image), leads Artificial Analysis's (1370 vs 1298), wins all
 * five pillars of Alibaba's Qwen-Image-Bench, and — most tellingly — beats
 * Google's own flagship on 7 of 10 rows in Google's own model card, at
 * gpt-image-2's CHEAPEST quality tier. Four parties with different incentives
 * pointing the same way is as settled as this gets.
 *
 * The Gemini slot is `gemini-3.1-flash-image`, NOT the Pro model: Flash
 * outranks Pro on both arenas (1264 vs 1246 text-to-image) at a fraction of
 * the price. Pro is the more expensive model, not the better-scoring one.
 */
export const DEFAULT_PREFERENCE = [
  "gpt-image-2",
  "gemini-3.1-flash-image",
  "gemini-3-pro-image",
  "gpt-image-1.5",
  "gemini-3.1-flash-lite-image",
];

/**
 * Cases where the default order is documented to flip.
 *
 * Deliberately short. The evidence supports a default plus a couple of
 * exceptions; a fine-grained per-use-case ranking would be invention.
 */
export const EXCEPTIONS = {
  /**
   * Stylization — restyling an image rather than reproducing it.
   * Google's own card: Gemini 3 Pro Image 1054 vs gpt-image-2 1030. The one
   * row where Google's flagship beats it outright.
   */
  stylize: ["gemini-3-pro-image", "gemini-3.1-flash-image"],
} as const;

/**
 * Claims that did NOT survive checking, kept so they are not re-introduced:
 *
 * - "Gemini is better at text inside images." This module shipped that rule,
 *   reasoning from vendor documentation: Google documents text rendering as a
 *   strength and OpenAI documents nothing. Vendor silence is not weakness —
 *   arena.ai has a dedicated text-rendering board and gpt-image-2 leads it by
 *   ~130-155 Elo, its LARGEST category margin. The rule was backwards.
 *   (The contrary figure circulating — "Nano Banana Pro 1198 beats GPT-Image
 *   1150" — is Google's own eval against GPT-Image **1**, five months before
 *   gpt-image-2 existed.)
 *
 * - "Gemini keeps characters consistent across edits." No independent
 *   benchmark for identity preservation exists. Google's own card puts
 *   character editing at 1054 / 1049 / 1044 — a tie inside the error bars.
 *   Only MULTI-character (up to 5) shows Pro ahead, 1135 vs 1122, and that is
 *   inside overlapping confidence intervals too. Not encoded as a winner.
 *
 * - "gpt-image-2 is best at editing." True on arena.ai (+74), NOT true on
 *   Artificial Analysis, which ranks Reve 2.1 first and puts gpt-image-2 13
 *   Elo over Nano Banana Pro. Two credible arenas, opposite verdicts: treated
 *   as roughly tied, which is why editing gets no exception entry.
 */
export const NOT_ENCODED = null;
