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
 * The routing policy, in three named cases and a fallback chain.
 *
 *   precision and quality  → gpt-image-2
 *   transparency           → gpt-image-1.5   (enforced as a capability rule)
 *   quick throwaway work   → gemini-3.1-flash-lite-image  (`--draft`)
 *
 * Everything else is fallback: reached only when one of those is unavailable,
 * never chosen in preference to them.
 *
 * The quality slot is measured rather than assumed. gpt-image-2 leads
 * arena.ai's overall text-to-image board (1381 vs 1246 for gemini-3-pro-image),
 * leads Artificial Analysis's (1370 vs 1298), wins all five pillars of
 * Alibaba's Qwen-Image-Bench, and beats Google's own flagship on 7 of 10 rows
 * in Google's own model card — at gpt-image-2's CHEAPEST quality tier. Four
 * parties with different incentives pointing the same way.
 *
 * The fallback order below follows the same arenas, with one deliberate
 * departure: flash-lite sits last despite outscoring both Pro and gpt-image-1.5
 * on the text-to-image board, because its role here is the throwaway tier. When
 * it is wanted, it is asked for by name or by `--draft`, not arrived at while
 * looking for quality.
 */
export const DEFAULT_PREFERENCE = [
  "gpt-image-2",
  "gemini-3.1-flash-image",
  "gemini-3-pro-image",
  "gpt-image-1.5",
  "gemini-3.1-flash-lite-image",
];

/**
 * The quick-illustration tier: a throwaway picture where fidelity is not the
 * point and ~$0.03 is. Selected by `--draft`, by name, or never.
 */
export const DRAFT_MODEL = "gemini-3.1-flash-lite-image";

/**
 * There is one measured case where gemini-3-pro-image beats gpt-image-2:
 * stylization, in Google's own evaluation, 1054 vs 1030 — a 24-point margin on
 * a vendor's own board.
 *
 * It is deliberately NOT encoded. The policy above makes Pro a fallback model,
 * and a 24-point edge on one row of one vendor's self-published table is not
 * enough to override a stated preference. Recorded here so the finding is not
 * lost, and so re-adding it is a decision rather than a rediscovery.
 */
export const UNENCODED_EXCEPTIONS = {
  stylization: { winner: "gemini-3-pro-image", over: "gpt-image-2", margin: "1054 vs 1030" },
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
