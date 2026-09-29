/**
 * Provider routing.
 *
 * The rules below are capability rules, not taste. Each one exists because a
 * model either *cannot* do the thing (the API rejects it) or because the vendor
 * documents a guarantee the other side does not make. Where neither is true —
 * "draw me a nice picture" — there is no defensible automatic answer, so the
 * router says so and the caller asks the user rather than quietly spending
 * their money on a coin flip.
 *
 * Quality is the default bias: when a rule admits several models, the most
 * capable one wins, not the cheapest. Cost is reported, never optimised for
 * behind the user's back.
 */

import { DEFAULT_PREFERENCE, DRAFT_MODEL, POLICY_PREFERENCE } from "./evidence.js";
import { isRetiredModel, retiredModelMessage } from "./retired.js";
import { isGeminiAspect, isValidOpenAiSize, OPENAI_LIMITS, parseAspect } from "./shape.js";
import type { ImageRequest, ModelCapabilities, ProviderId } from "./types.js";

export interface RoutingInput {
  request: ImageRequest;
  /** Models whose provider has an API key present. */
  available: ModelCapabilities[];
  /** Caller pinned a provider or model explicitly. */
  pinnedProvider?: ProviderId;
  pinnedModel?: string;
  /** Configured tie-break order; wins over the evidence-based default. */
  preferredModels?: string[];
  /** Hints the caller extracted from the user's intent. */
  intent?: {
    /** The image is mostly type — a poster, a diagram, a menu. */
    textInImage?: boolean;
    /** Recurring characters must look the same across images. */
    characterConsistency?: boolean;
    /** Output must not carry a provider watermark. */
    noWatermark?: boolean;
    /** A draft; cost matters more than fidelity. */
    draft?: boolean;
  };
}

export type RoutingDecision =
  | { kind: "resolved"; model: ModelCapabilities; reason: string }
  | { kind: "ambiguous"; candidates: ModelCapabilities[]; reason: string }
  | { kind: "impossible"; reason: string };

function byCapability(models: ModelCapabilities[], pred: (m: ModelCapabilities) => boolean) {
  return models.filter(pred);
}

/** Most capable first: documented guarantees, then price as the tie-break. */
function strongestFirst(models: ModelCapabilities[]): ModelCapabilities[] {
  return [...models].sort((a, b) => {
    const score = (m: ModelCapabilities) =>
      (m.characterConsistency > 0 ? 2 : 0) + (m.strongTextRendering ? 1 : 0);
    const diff = score(b) - score(a);
    if (diff !== 0) return diff;
    // Pricier ≈ stronger tier within a family; an unknown price ranks as neither.
    return (b.approxCostUsd1K ?? 0) - (a.approxCostUsd1K ?? 0);
  });
}

/**
 * The pool in the order a free choice takes it: the configured preference,
 * then the default policy, then anything neither names. Every branch that
 * picks from a pool of several goes through this, so a mask or a transparent
 * background still lands on the default model rather than on whichever model
 * a capability filter happened to leave first.
 */
function inPreferenceOrder(pool: ModelCapabilities[], preferred: readonly string[]): ModelCapabilities[] {
  const order = [...preferred, ...DEFAULT_PREFERENCE];
  const rank = (m: ModelCapabilities) => {
    const i = order.indexOf(m.id);
    return i === -1 ? order.length : i;
  };
  const unranked = strongestFirst(pool.filter((m) => rank(m) === order.length));
  return [...pool.filter((m) => rank(m) < order.length).sort((a, b) => rank(a) - rank(b)), ...unranked];
}

const money = (usd: number | null) => (usd === null ? "an unpublished per-image price" : `about $${usd.toFixed(3)}`);

export function route(input: RoutingInput): RoutingDecision {
  const { request: req, available, intent = {} } = input;

  if (available.length === 0) {
    return {
      kind: "impossible",
      reason:
        "No image provider is configured. Set OPENAI_API_KEY or GEMINI_API_KEY " +
        "(both are optional; each unlocks its own models).",
    };
  }

  let pool = available;
  const preferred = input.preferredModels ?? [];

  // A retired model named anywhere is a migration error, never a silent
  // substitute: the caller chose it on purpose and should choose again.
  if (input.pinnedModel && isRetiredModel(input.pinnedModel)) {
    return { kind: "impossible", reason: retiredModelMessage(input.pinnedModel, "--model") };
  }
  const retiredPreference = preferred.find(isRetiredModel);
  if (retiredPreference) {
    return { kind: "impossible", reason: retiredModelMessage(retiredPreference, "preferredModels") };
  }

  if (input.pinnedModel) {
    const picked = pool.find((m) => m.id === input.pinnedModel);
    if (!picked) {
      return {
        kind: "impossible",
        reason: `Model "${input.pinnedModel}" is not available. Available: ${pool.map((m) => m.id).join(", ")}`,
      };
    }
    // A pin chooses the model; it does not exempt the request from what the
    // model can do. The hard filters below still run on the one-model pool, so
    // a pinned model with an impossible request fails here, not at the API.
    pool = [picked];
  }
  if (input.pinnedProvider) {
    pool = pool.filter((m) => m.provider === input.pinnedProvider);
    if (pool.length === 0) {
      return {
        kind: "impossible",
        reason: `Provider "${input.pinnedProvider}" has no API key set.`,
      };
    }
  }

  // --- Hard capability filters. Each removes models that would fail outright.

  if (req.mask) {
    const masked = byCapability(pool, (m) => m.maskInpainting);
    if (masked.length === 0) {
      return {
        kind: "impossible",
        reason:
          "Masked inpainting needs an OpenAI image model — Google's image API has no mask " +
          "concept, only prompt-described edits. Set OPENAI_API_KEY, or drop the mask and " +
          "describe the change in words.",
      };
    }
    pool = masked;
  }

  if (req.transparent && req.format === "jpeg") {
    return {
      kind: "impossible",
      reason: "JPEG has no alpha channel — ask for png or webp with --transparent.",
    };
  }

  if (req.transparent) {
    const transparent = byCapability(pool, (m) => m.transparentBackground);
    if (transparent.length === 0) {
      return {
        kind: "impossible",
        reason:
          "A transparent background needs an OpenAI GPT Image 2.5 model (Sunburst or Flare) — " +
          "Gemini does not document transparency at all. Set OPENAI_API_KEY, or render on a " +
          "solid background and cut it out afterwards.",
      };
    }
    pool = transparent;
  }

  if (req.format) {
    const supported = byCapability(pool, (m) => m.outputFormats.includes(req.format!));
    if (supported.length === 0) {
      return {
        kind: "impossible",
        reason:
          `No available model returns ${req.format.toUpperCase()}. Every Gemini image model ` +
          `serves JPEG only; OpenAI covers png, jpeg and webp. Ask for JPEG, or set ` +
          `OPENAI_API_KEY.`,
      };
    }
    pool = supported;
  }

  const refCount = req.references?.length ?? 0;
  if (refCount > 0) {
    const enough = byCapability(pool, (m) => m.maxReferenceImages >= refCount);
    if (enough.length === 0) {
      const best = Math.max(...pool.map((m) => m.maxReferenceImages));
      return {
        kind: "impossible",
        reason: `${refCount} reference images exceeds every available model (best takes ${best}).`,
      };
    }
    pool = enough;
  }

  if (req.size) {
    const dims = /^(\d+)x(\d+)$/.exec(req.size);
    if (dims) {
      const [w, h] = [Number(dims[1]), Number(dims[2])];
      const fits = byCapability(
        pool,
        (m) =>
          m.presetSizes.includes(req.size!) ||
          (m.arbitraryDimensions &&
            isValidOpenAiSize(w, h) &&
            Math.max(w, h) <= m.maxEdgePx &&
            w * h <= m.maxTotalPixels)
      );
      if (fits.length === 0) {
        return {
          kind: "impossible",
          reason:
            `No available model takes an exact ${req.size}. Gemini only offers fixed aspect ` +
            `ratios and 1K/2K/4K buckets; OpenAI's GPT Image 2.5 models take custom sizes ` +
            `with both edges multiples of 16, neither over 3840px, a ratio no wider than 3:1, ` +
            `and 0.65-8.3MP in total.`,
        };
      }
      pool = fits;
    }
  }

  // An aspect ratio outside Gemini's fixed list can only be served by a model
  // that takes exact pixels, where the ratio becomes a width and a height.
  if (req.aspect && !isGeminiAspect(req.aspect)) {
    const ratio = parseAspect(req.aspect);
    const wide = ratio ? Math.max(ratio.w, ratio.h) / Math.min(ratio.w, ratio.h) : Infinity;
    if (wide > OPENAI_LIMITS.maxAspectRatio) {
      return {
        kind: "impossible",
        reason:
          `Aspect ratio ${req.aspect} is not one Gemini accepts, and OpenAI's custom sizes stop ` +
          `at 3:1 (or 1:3). Pick a narrower ratio.`,
      };
    }
    const flexible = byCapability(pool, (m) => m.arbitraryDimensions);
    if (flexible.length === 0) {
      return {
        kind: "impossible",
        reason:
          `Aspect ratio ${req.aspect} is not one Gemini accepts (1:1 2:3 3:2 3:4 4:3 4:5 5:4 ` +
          `9:16 16:9 21:9), and no model that takes exact pixels is available. Pick one of ` +
          `those ratios, or set OPENAI_API_KEY.`,
      };
    }
    pool = flexible;
  }

  if (req.resolution && req.resolution !== "512px") {
    const needed = req.resolution === "4K" ? 3840 : req.resolution === "2K" ? 2048 : 1024;
    const fits = byCapability(pool, (m) => m.maxEdgePx >= needed);
    if (fits.length === 0) {
      return {
        kind: "impossible",
        reason: `No available model reaches ${req.resolution}.`,
      };
    }
    pool = fits;
  }

  // --- Documented-strength preferences. These narrow, they never empty the pool.

  if (intent.noWatermark) {
    const clean = byCapability(pool, (m) => !m.watermarked);
    if (clean.length === 0) {
      return {
        kind: "impossible",
        reason:
          "Watermark-free output needs an OpenAI model — every Gemini image carries SynthID " +
          "with no documented opt-out.",
      };
    }
    pool = clean;
  }

  if (input.pinnedModel) return { kind: "resolved", model: pool[0], reason: "pinned by the caller" };

  // Character consistency intentionally does NOT pick a winner: no independent
  // benchmark for identity preservation exists, and Google's own card scores
  // character editing as a tie inside the error bars. It only narrows to models
  // that document the capability at all, and lets the default order decide.
  if (intent.characterConsistency) {
    const consistent = byCapability(pool, (m) => m.characterConsistency > 0);
    if (consistent.length > 0) pool = consistent;
  }

  // `textInImage` used to route to Gemini, reasoning from vendor documentation.
  // That was backwards: arena.ai's dedicated text-rendering board put
  // gpt-image-2 ~130 Elo clear, its widest margin of any category. There is
  // nothing to special-case — the default order already leads with OpenAI.

  // A mask or a transparent background narrows the pool; it does not choose
  // within it. The preference order does, so an explicit Flare preference
  // stays Flare and everything else stays on the default.
  const ordered = inPreferenceOrder(pool, preferred);
  if (req.mask) {
    return { kind: "resolved", model: ordered[0], reason: "only OpenAI image models accept an alpha mask" };
  }
  if (req.transparent) {
    return {
      kind: "resolved",
      model: ordered[0],
      reason: `a transparent background needs a model that returns alpha — ${ordered[0].id} does, on png or webp`,
    };
  }

  // A throwaway illustration has a named model rather than a price search: the
  // cheapest thing that survived the capability filters might be cheap for
  // reasons that have nothing to do with being a good quick sketch.
  if (intent.draft) {
    const lite = pool.find((m) => m.id === DRAFT_MODEL);
    // Cheapest KNOWN price; a model with no published per-image price is not
    // cheap by default. With no known price left, the preference order decides.
    const priced = pool
      .filter((m) => m.approxCostUsd1K !== null)
      .sort((a, b) => a.approxCostUsd1K! - b.approxCostUsd1K!);
    const pick = lite ?? priced[0] ?? ordered[0];
    return {
      kind: "resolved",
      model: pick,
      reason: lite
        ? `quick illustration — ${money(pick.approxCostUsd1K)} per image`
        : `quick illustration — ${DRAFT_MODEL} unavailable, ${priced[0] ? "cheapest that fits" : "first in preference order"} at ${money(pick.approxCostUsd1K)}`,
    };
  }

  // Exactly one model survived the filters: that IS the answer.
  if (pool.length === 1) {
    return { kind: "resolved", model: pool[0], reason: "the only available model that fits the request" };
  }

  // Nothing measurable decides between what is left. A stated preference wins;
  // otherwise fall back to what the public arenas measure. Both sit ABOVE the
  // strongest-model shortcut — someone who prefers the cheap workhorse should
  // get it, not the flagship of whichever provider happened to survive — and
  // BELOW every capability rule, because preference cannot make a model do
  // something it cannot do.
  const byPreference = (order: readonly string[], why: string): RoutingDecision | null => {
    for (const id of order) {
      const match = pool.find((m) => m.id === id);
      if (match) return { kind: "resolved", model: match, reason: why };
    }
    return null;
  };

  const configured = byPreference(
    preferred,
    "no capability signal either way — using the configured preference"
  );
  if (configured) return configured;

  const policy = byPreference(
    POLICY_PREFERENCE,
    "the default image model (override with --model or `preferredModels`)"
  );
  if (policy) return policy;

  const measured = byPreference(
    DEFAULT_PREFERENCE,
    "no OpenAI model available — highest-ranked available model in the public preference " +
      "arenas (as of 2026-08-17; override with `preferredModels`)"
  );
  if (measured) return measured;

  // Only reachable if the pool holds a model this file has never heard of.
  const providers = new Set(pool.map((m) => m.provider));
  if (providers.size === 1) {
    const best = strongestFirst(pool)[0];
    return { kind: "resolved", model: best, reason: `strongest available ${best.provider} model` };
  }

  return {
    kind: "ambiguous",
    candidates: strongestFirst(pool),
    reason:
      "Nothing in the request favours one model on capability grounds, and no ranking covers " +
      "the models available here. Ask which to use.",
  };
}
