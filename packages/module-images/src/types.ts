/**
 * The provider seam.
 *
 * Every provider speaks plain `fetch` against a documented REST endpoint — no
 * vendor SDKs. That is a deployment constraint, not a preference: the brain-ui
 * container has bun and nothing else (no node, no npm, no python, no uv), so
 * anything that needs an SDK or an interpreter cannot run where the agent
 * actually lives.
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
  /** OpenAI-style quality tier. */
  quality?: "low" | "medium" | "high" | "auto";
  format?: "png" | "jpeg" | "webp";
  /** Transparent background. Only some models support it; routing enforces that. */
  transparent?: boolean;
  /** Reference images for an edit or a composition. */
  references?: ImageInput[];
  /** Alpha mask — transparent pixels mark the editable region. OpenAI only. */
  mask?: ImageInput;
  n?: number;
}

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
  /**
   * Arbitrary WxH rather than a fixed set. Verified live: gpt-image-2 takes
   * custom sizes, gpt-image-1.5 rejects them with `invalid_value` and accepts
   * only the presets below.
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
  /** Vendor documents text rendering as a strength. */
  strongTextRendering: boolean;
  /** Output carries a provider watermark (Gemini: SynthID, no documented opt-out). */
  watermarked: boolean;
  /**
   * Formats the API will actually return. Verified against the live endpoints,
   * not the docs: every Gemini image model rejects `image/png` on the
   * Interactions API and serves JPEG only, which the published docs do not say.
   */
  outputFormats: ("png" | "jpeg" | "webp")[];
  defaultFormat: "png" | "jpeg" | "webp";
  /** Approximate USD for one image at ~1K, for cost reporting and tie-breaks. */
  approxCostUsd1K: number;
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
