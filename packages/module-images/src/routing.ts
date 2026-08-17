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

import { isGeminiAspect } from "./shape.js";
import type { ImageRequest, ModelCapabilities, ProviderId } from "./types.js";

export interface RoutingInput {
  request: ImageRequest;
  /** Models whose provider has an API key present. */
  available: ModelCapabilities[];
  /** Caller pinned a provider or model explicitly. */
  pinnedProvider?: ProviderId;
  pinnedModel?: string;
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
    return b.approxCostUsd1K - a.approxCostUsd1K; // pricier ≈ stronger tier within a family
  });
}

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

  if (input.pinnedModel) {
    const picked = pool.find((m) => m.id === input.pinnedModel);
    if (!picked) {
      return {
        kind: "impossible",
        reason: `Model "${input.pinnedModel}" is not available. Available: ${pool.map((m) => m.id).join(", ")}`,
      };
    }
    return { kind: "resolved", model: picked, reason: "pinned by the caller" };
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
          "A transparent background needs gpt-image-1.5 — gpt-image-2 rejects it outright and " +
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
          (m.arbitraryDimensions && Math.max(w, h) <= m.maxEdgePx && w * h <= m.maxTotalPixels)
      );
      if (fits.length === 0) {
        return {
          kind: "impossible",
          reason:
            `No available model takes an exact ${req.size}. Gemini only offers fixed aspect ` +
            `ratios and 1K/2K/4K buckets; gpt-image-1.5 only takes 1024x1024, 1536x1024 and ` +
            `1024x1536; gpt-image-2 takes arbitrary sizes up to 3840px per edge and 8.3MP, on ` +
            `a 16px grid.`,
        };
      }
      pool = fits;
    }
  }

  // An aspect ratio outside Gemini's fixed list can only be served by a model
  // that takes exact pixels, where the ratio becomes a width and a height.
  if (req.aspect && !isGeminiAspect(req.aspect)) {
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

  if (intent.characterConsistency) {
    const consistent = byCapability(pool, (m) => m.characterConsistency > 0);
    if (consistent.length > 0) {
      const best = strongestFirst(consistent)[0];
      return {
        kind: "resolved",
        model: best,
        reason: `documents consistency for up to ${best.characterConsistency} characters; no OpenAI image model makes that claim`,
      };
    }
  }

  if (intent.textInImage) {
    const texty = byCapability(pool, (m) => m.strongTextRendering);
    if (texty.length > 0) {
      const best = strongestFirst(texty)[0];
      return {
        kind: "resolved",
        model: best,
        reason: "vendor documents legible in-image text as a strength; OpenAI makes no such claim",
      };
    }
  }

  if (req.mask) {
    const best = strongestFirst(pool)[0];
    return { kind: "resolved", model: best, reason: "only OpenAI image models accept an alpha mask" };
  }
  if (req.transparent) {
    const best = strongestFirst(pool)[0];
    return { kind: "resolved", model: best, reason: "only gpt-image-1.5 supports a transparent background" };
  }

  if (intent.draft) {
    const cheapest = [...pool].sort((a, b) => a.approxCostUsd1K - b.approxCostUsd1K)[0];
    return {
      kind: "resolved",
      model: cheapest,
      reason: `draft requested — cheapest available at about $${cheapest.approxCostUsd1K.toFixed(3)} per image`,
    };
  }

  // Exactly one model survived the filters: that IS the answer.
  if (pool.length === 1) {
    return { kind: "resolved", model: pool[0], reason: "the only available model that fits the request" };
  }

  // One provider left, several of its models: take its strongest.
  const providers = new Set(pool.map((m) => m.provider));
  if (providers.size === 1) {
    const best = strongestFirst(pool)[0];
    return { kind: "resolved", model: best, reason: `strongest available ${best.provider} model` };
  }

  // Genuinely a preference call across providers. There is no published
  // benchmark that settles "which makes the nicer picture", so do not pretend.
  return {
    kind: "ambiguous",
    candidates: strongestFirst(pool),
    reason:
      "Nothing in the request favours one model on capability grounds, and no vendor benchmark " +
      "settles general image quality. Ask which to use.",
  };
}
