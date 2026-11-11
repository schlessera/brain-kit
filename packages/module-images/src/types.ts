/**
 * The provider seam.
 *
 * Every provider speaks plain `fetch` against a documented REST endpoint — no
 * vendor SDKs. That is a deployment constraint, not a preference: a hosted
 * container may have bun and nothing else (no node, no npm, no python, no uv),
 * so anything that needs an SDK or an interpreter cannot be relied on where
 * the agent actually lives.
 */

/** What the caller wants. Provider-neutral; each provider maps it to its own API. */
export interface ImageRequest {
  prompt: string;
  /** Explicit pixel size, e.g. "1024x1024". OpenAI takes arbitrary sizes; Gemini does not. */
  size?: string;
  /** Gemini-style aspect ratio, e.g. "16:9". */
  aspect?: string;
  /** Gemini-style resolution bucket. */
  resolution?: "512px" | "1K" | "2K" | "4K";
  /**
   * OpenAI-style quality tier. `xhigh` and `max` are GPT Image 2.5 and 2.6
   * tiers; they are forwarded as given, never mapped down to `high`. Unset,
   * an OpenAI request sends `max` (#3782).
   */
  quality?: ImageQuality;
  /**
   * GPT Image 2.6 planning effort, independent of quality. Only models with
   * `complexityControl` take it; routing refuses it anywhere else.
   */
  complexity?: ImageComplexity;
  format?: ImageFormat;
  /**
   * Animated GIF frame count (`format: "gif"` only). Unset, nothing is sent
   * and the API applies its own default of 9.
   */
  frames?: number;
  /**
   * Milliseconds each GIF frame shows (`format: "gif"` only). Unset, nothing
   * is sent and the API applies its own default of 200.
   */
  frameDurationMs?: number;
  /** Transparent background (png or webp only). Only some models support it; routing enforces that. */
  transparent?: boolean;
  /** Reference images for an edit or a composition. */
  references?: ImageInput[];
  /** Alpha mask — transparent pixels mark the editable region. OpenAI only. */
  mask?: ImageInput;
  n?: number;
}

/** Every quality tier the CLI accepts. Anything else is refused before routing. */
export const IMAGE_QUALITIES = ["low", "medium", "high", "xhigh", "max", "auto"] as const;
export type ImageQuality = (typeof IMAGE_QUALITIES)[number];

/**
 * Output formats any model may return. `gif` is an animated GIF and `svg` an
 * authored static SVG; only the GPT Image 2.6 models produce either (#3783,
 * #3784).
 */
export const IMAGE_FORMATS = ["png", "jpeg", "webp", "gif", "svg"] as const;
export type ImageFormat = (typeof IMAGE_FORMATS)[number];

/** The mime type of a format: `image/<format>`, except SVG. */
export function formatMime(format: ImageFormat): string {
  return format === "svg" ? "image/svg+xml" : `image/${format}`;
}

/** The file extension for a mime type: the inverse of `formatMime`. */
export function mimeExtension(mime: string): string {
  return mime === "image/svg+xml" ? "svg" : mime.replace("image/", "").replace("jpg", "jpeg");
}

/**
 * GPT Image 2.6 GIF limits from the API reference (checked 2026-11-09):
 * `frame_count` 2-16 and `frame_duration_ms` 20-2000. The guide once said 64
 * frames; the API enforces 16.
 */
export const GIF_FRAME_COUNT = { min: 2, max: 16 } as const;
export const GIF_FRAME_DURATION_MS = { min: 20, max: 2000 } as const;

/** GPT Image 2.6 `complexity` values. Anything else is refused before routing. */
export const IMAGE_COMPLEXITIES = ["low", "medium", "high"] as const;
export type ImageComplexity = (typeof IMAGE_COMPLEXITIES)[number];

export interface ImageInput {
  data: Uint8Array;
  mime: string;
  /** Repo-relative path, for error messages. */
  label?: string;
}

export interface GeneratedImage {
  data: Uint8Array;
  mime: string;
}

export interface ImageResult {
  images: GeneratedImage[];
  provider: ProviderId;
  model: string;
  /** Reported by the API when it says; otherwise the estimate that drove routing. */
  costUsd?: number;
  costIsEstimate: boolean;
  usage?: Record<string, unknown>;
  /** Anything the provider said in words — Gemini returns text alongside the image. */
  note?: string;
}

export type ProviderId = "openai" | "gemini";

/**
 * What a model can actually do. These are the inputs to routing, and every
 * field here traces to vendor documentation rather than taste — see the
 * `image-gen` skill for the citations and the reasoning.
 */
export interface ModelCapabilities {
  id: string;
  provider: ProviderId;
  /** Human-facing one-liner used when the router has to ask. */
  summary: string;
  transparentBackground: boolean;
  /** Pixel-scoped inpainting with an alpha mask. */
  maskInpainting: boolean;
  /** Takes OpenAI's `complexity` (planning effort) parameter: GPT Image 2.6. */
  complexityControl: boolean;
  /**
   * Arbitrary WxH rather than a fixed set, within OpenAI's published
   * custom-size rules (`OPENAI_LIMITS` in `shape.ts`).
   */
  arbitraryDimensions: boolean;
  /** Exact sizes the model accepts regardless of `arbitraryDimensions`. */
  presetSizes: string[];
  maxEdgePx: number;
  maxTotalPixels: number;
  /** Reference images accepted in one request. */
  maxReferenceImages: number;
  /** Vendor documents a character-consistency guarantee. */
  characterConsistency: number;
  /**
   * Measured lead on text inside the image, not a vendor claim. This field was
   * originally set from vendor documentation, which put it exactly backwards —
   * see the retracted-claims list in `evidence.ts` before changing a value.
   */
  strongTextRendering: boolean;
  /** Output carries a provider watermark (Gemini: SynthID, no documented opt-out). */
  watermarked: boolean;
  /**
   * Formats the API will actually return. Verified against the live endpoints,
   * not the docs: every Gemini image model rejects `image/png` on the
   * Interactions API and serves JPEG only, which the published docs do not say.
   */
  outputFormats: ImageFormat[];
  defaultFormat: ImageFormat;
  /**
   * Approximate USD for one image at ~1K, for cost reporting and tie-breaks.
   * `null` when no verified per-image price exists: the GPT Image 2.5 and 2.6
   * models are billed per token, and OpenAI states its calculator does not estimate
   * their token consumption. An unknown cost is reported as unknown, never as
   * a borrowed figure.
   */
  approxCostUsd1K: number | null;
}

export interface Provider {
  id: ProviderId;
  /** Env var that must be set for this provider to be usable. */
  apiKeyEnv: string;
  models: ModelCapabilities[];
  generate(model: string, req: ImageRequest, apiKey: string): Promise<ImageResult>;
}

/** Raised for a provider-side failure that has a useful explanation attached. */
export class ImageProviderError extends Error {
  constructor(
    message: string,
    readonly opts: { retryable: boolean; status?: number; code?: string } = { retryable: false }
  ) {
    super(message);
    this.name = "ImageProviderError";
  }
}
