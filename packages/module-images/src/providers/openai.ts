/**
 * OpenAI image models over the documented REST endpoints.
 *
 * - generate: POST /v1/images/generations (JSON)
 * - edit:     POST /v1/images/edits (multipart/form-data)
 *
 * GPT-image models always return base64 in `data[].b64_json`; there is no
 * `url` response mode for them, so the bytes come back inline and can be large.
 */

import {
  aspectToOpenAiSize,
  nearestPresetSize,
  OPENAI_LIMITS,
  OPENAI_PRESET_SIZES as PRESETS,
  isValidOpenAiSize,
  type Resolution,
} from "../shape.js";
import { resolveEnv } from "../config/env.js";
import { isRetiredModel, retiredModelMessage } from "../retired.js";
import {
  ImageProviderError,
  type ImageRequest,
  type ImageResult,
  type ModelCapabilities,
  type Provider,
} from "../types.js";

/**
 * The GPT Image 2.5 pair (#586). Sunburst is the default; Flare is chosen by
 * name. Both take `background: "transparent"` on png or webp, masks, custom
 * sizes and the `xhigh`/`max` quality tiers, per OpenAI's model pages and
 * image-generation guide (checked 2026-09-29):
 *   https://developers.openai.com/api/docs/models/gpt-image-2.5-sunburst
 *   https://developers.openai.com/api/docs/models/gpt-image-2.5-flare
 *   https://developers.openai.com/api/docs/guides/image-generation
 *
 * gpt-image-2 and gpt-image-1.5 are retired (`../retired.ts`) and must not be
 * re-added as a fallback.
 */
const GPT_IMAGE_25 = {
  provider: "openai",
  transparentBackground: true,
  maskInpainting: true,
  arbitraryDimensions: true,
  presetSizes: PRESETS,
  maxEdgePx: OPENAI_LIMITS.maxEdge,
  maxTotalPixels: OPENAI_LIMITS.maxTotalPixels,
  // OpenAI documents no reference-image ceiling for 2.5; this is the ceiling
  // the edits endpoint has held for GPT-image models, not a 2.5 measurement.
  maxReferenceImages: 16,
  characterConsistency: 0,
  // No independent measurement of either 2.5 model exists yet. The arena
  // text-rendering lead in evidence.ts was measured on gpt-image-2 and does
  // not transfer by name.
  strongTextRendering: false,
  watermarked: false,
  outputFormats: ["png", "jpeg", "webp"],
  defaultFormat: "png",
  // Billed per token, and the default quality is `auto`, which the API
  // resolves per image: there is no single per-image figure to show. A dry run
  // with a stated quality and size is priced by `estimateOpenAiOutputCost`.
  approxCostUsd1K: null,
} satisfies Omit<ModelCapabilities, "id" | "summary">;

const MODELS: ModelCapabilities[] = [
  {
    id: "gpt-image-2.5-sunburst",
    summary:
      "OpenAI's most capable image model — the default; transparency on png/webp, masks, custom sizes, xhigh/max quality, no watermark",
    ...GPT_IMAGE_25,
  },
  {
    id: "gpt-image-2.5-flare",
    summary:
      "OpenAI's fastest high-quality model — chosen by --model; same transparency, masks, sizes and quality tiers as Sunburst",
    ...GPT_IMAGE_25,
  },
];

/**
 * USD per 1M tokens, from each model's page (checked 2026-09-29). The two
 * rows are equal today; that makes neither a per-image price, because the
 * models do not spend the same number of tokens on the same image.
 */
const TOKEN_RATES: Record<string, { textIn: number; imageIn: number; imageOut: number }> = {
  "gpt-image-2.5-sunburst": { textIn: 5, imageIn: 8, imageOut: 30 },
  "gpt-image-2.5-flare": { textIn: 5, imageIn: 8, imageOut: 30 },
};

/**
 * What a call cost, from the token counts the API reported and the published
 * token rates. `undefined` when the response carries no usable usage (the
 * reference documents `usage` without promising it for every model) or the
 * model has no rate here: an unknown cost stays unknown. List price, before
 * any cached-input discount, so it errs high.
 */
export function openAiCostFromUsage(model: string, usage: unknown): number | undefined {
  const rates = TOKEN_RATES[model];
  if (!rates || typeof usage !== "object" || usage === null) return undefined;
  const u = usage as {
    output_tokens?: unknown;
    input_tokens_details?: { text_tokens?: unknown; image_tokens?: unknown };
  };
  const textIn = u.input_tokens_details?.text_tokens;
  const imageIn = u.input_tokens_details?.image_tokens;
  const out = u.output_tokens;
  if (typeof textIn !== "number" || typeof imageIn !== "number" || typeof out !== "number") {
    return undefined;
  }
  return (textIn * rates.textIn + imageIn * rates.imageIn + out * rates.imageOut) / 1_000_000;
}

/**
 * Output tokens per image for both GPT Image 2.5 models, from the calculator
 * in OpenAI's image-generation guide ("GPT Image 2.5 and GPT Image 2 output
 * tokens", checked 2026-09-29). That calculator is a separate one from the
 * GPT Image 2 calculator the model pages say does not cover 2.5, and it has
 * one table for Sunburst and Flare. The long edge gets the tier's base count,
 * the short edge that base over the aspect ratio (rounded half to even), and
 * the grid scales with the pixel count. It reproduces the guide's own
 * example: low at 1024x1024 is 196 tokens, $0.00588.
 */
const OUTPUT_TOKEN_BASE: Readonly<Record<string, number>> = { low: 16, medium: 24, high: 48, xhigh: 64, max: 96 };

/**
 * Estimated USD for one image's output tokens, before the call, or
 * `undefined` when it cannot be known: `auto` quality or an unstated size is
 * picked by the API per image. Prompt and reference-image input tokens are
 * not included, so it errs low; the result's `costUsd` is the real figure.
 */
export function estimateOpenAiOutputCost(
  model: string,
  quality: string | undefined,
  size: string | undefined
): number | undefined {
  const rate = TOKEN_RATES[model]?.imageOut;
  const base = quality ? OUTPUT_TOKEN_BASE[quality] : undefined;
  const dims = size ? /^(\d+)x(\d+)$/.exec(size) : null;
  if (rate === undefined || base === undefined || !dims) return undefined;
  const [w, h] = [Number(dims[1]), Number(dims[2])];
  if (!PRESETS.includes(size!) && !isValidOpenAiSize(w, h)) return undefined;
  const short = base / (Math.max(w, h) / Math.min(w, h));
  const floor = Math.floor(short);
  const rounded = short - floor === 0.5 ? floor + (floor % 2) : Math.round(short);
  const tokens = Math.ceil((base * rounded * (2_000_000 + w * h)) / 4_000_000);
  return (tokens * rate) / 1_000_000;
}

/** The size a request sends: explicit, or an aspect ratio turned into pixels. */
export function openAiRequestSize(req: ImageRequest, model: string): string | undefined {
  // OpenAI has no aspect-ratio parameter: a ratio is expressed as exact
  // pixels, so translate rather than dropping the caller's request.
  const caps = MODELS.find((m) => m.id === model);
  return (
    req.size ??
    (req.aspect
      ? (caps?.arbitraryDimensions
          ? aspectToOpenAiSize(req.aspect, req.resolution as Resolution)
          : nearestPresetSize(req.aspect, caps?.presetSizes)) ?? undefined
      : undefined)
  );
}

async function readError(res: Response): Promise<never> {
  let code: string | undefined;
  let message = `${res.status} ${res.statusText}`;
  let moderation: string | undefined;
  try {
    const body = (await res.json()) as {
      error?: { message?: string; code?: string; type?: string; moderation_details?: unknown };
    };
    code = body.error?.code ?? body.error?.type;
    if (body.error?.message) message = body.error.message;
    if (body.error?.moderation_details) {
      moderation = JSON.stringify(body.error.moderation_details);
    }
  } catch {
    /* non-JSON error body */
  }

  // A 429 means two very different things here, and only one is worth retrying.
  const billing = new Set([
    "credit_balance_exhausted",
    "organization_spend_limit_exceeded",
    "project_spend_limit_exceeded",
    "organization_usage_limit_exceeded",
    "insufficient_quota",
  ]);
  const retryable = res.status >= 500 || (res.status === 429 && !(code && billing.has(code)));

  const hints: string[] = [];
  if (code === "moderation_blocked") {
    hints.push(`refused by moderation${moderation ? ` — ${moderation}` : ""}`);
  }
  if (res.status === 403) hints.push("region not supported, or the org is not verified");
  if (res.status === 400 && /model/i.test(message)) {
    hints.push("GPT-image models require API Organization Verification");
  }
  if (code && billing.has(code)) hints.push("billing limit — retrying will not help");
  if (res.status === 401) hints.push("check OPENAI_API_KEY");

  throw new ImageProviderError(
    `OpenAI: ${message}${hints.length ? ` (${hints.join("; ")})` : ""}`,
    { retryable, status: res.status, code }
  );
}

interface OpenAiImageResponse {
  data?: { b64_json?: string }[];
  usage?: Record<string, unknown>;
  quality?: string;
  size?: string;
}

function decode(body: OpenAiImageResponse, model: string, req: ImageRequest): ImageResult {
  const images = (body.data ?? [])
    .map((d) => d.b64_json)
    .filter((b): b is string => typeof b === "string" && b.length > 0)
    .map((b64) => ({
      data: Uint8Array.from(Buffer.from(b64, "base64")),
      mime: `image/${req.format ?? "png"}`,
    }));
  if (images.length === 0) {
    throw new ImageProviderError("OpenAI returned no image data", { retryable: false });
  }
  return {
    images,
    provider: "openai",
    model,
    costUsd: openAiCostFromUsage(model, body.usage),
    costIsEstimate: true,
    usage: body.usage,
  };
}

export const openaiProvider: Provider = {
  id: "openai",
  apiKeyEnv: "OPENAI_API_KEY",
  models: MODELS,

  async generate(model, req, apiKey) {
    // Routing already refuses these; this keeps a direct caller from paying
    // for a model the module no longer stands behind.
    if (isRetiredModel(model)) {
      throw new ImageProviderError(retiredModelMessage(model, "requested model"), { retryable: false });
    }
    if (req.transparent && req.format === "jpeg") {
      throw new ImageProviderError("JPEG has no alpha channel — a transparent background needs png or webp.", {
        retryable: false,
      });
    }
    const isEdit = (req.references?.length ?? 0) > 0 || !!req.mask;
    const size = openAiRequestSize(req, model);
    const headers = { Authorization: `Bearer ${apiKey}` };

    if (!isEdit) {
      const payload: Record<string, unknown> = { model, prompt: req.prompt };
      if (size && size !== "auto") payload.size = size;
      if (req.quality) payload.quality = req.quality;
      // Alpha needs a format that can carry it; the API's default is png, but
      // be explicit so a caller-set default cannot flatten the transparency.
      if (req.format) payload.output_format = req.format;
      else if (req.transparent) payload.output_format = "png";
      if (req.n && req.n > 1) payload.n = req.n;
      // `transparent` is only legal on models that support it; routing guarantees that.
      if (req.transparent) payload.background = "transparent";

      const res = await fetch(`${resolveEnv().openaiBaseUrl}/images/generations`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) await readError(res);
      return decode((await res.json()) as OpenAiImageResponse, model, req);
    }

    // Edits are multipart. Reference images repeat as `image[]`; the mask is a
    // PNG whose fully transparent pixels mark what may change, and it applies
    // to the FIRST image only.
    const form = new FormData();
    form.append("model", model);
    form.append("prompt", req.prompt);
    if (size && size !== "auto") form.append("size", size);
    if (req.quality) form.append("quality", req.quality);
    if (req.format) form.append("output_format", req.format);
    else if (req.transparent) form.append("output_format", "png");
    if (req.transparent) form.append("background", "transparent");
    for (const [i, ref] of (req.references ?? []).entries()) {
      form.append("image[]", new Blob([ref.data as BlobPart], { type: ref.mime }), ref.label ?? `image-${i}.png`);
    }
    if (req.mask) {
      form.append("mask", new Blob([req.mask.data as BlobPart], { type: "image/png" }), "mask.png");
    }

    const res = await fetch(`${resolveEnv().openaiBaseUrl}/images/edits`, { method: "POST", headers, body: form });
    if (!res.ok) await readError(res);
    return decode((await res.json()) as OpenAiImageResponse, model, req);
  },
};
