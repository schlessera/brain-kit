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
import { providerRelayFetch } from "@schlessera/brain-common/internal/provider-relay";
import { isRetiredModel, retiredModelMessage } from "../retired.js";
import { staticSvgProblem } from "../svg.js";
import {
  formatMime,
  ImageProviderError,
  type ImageRequest,
  type ImageResult,
  type ModelCapabilities,
  type Provider,
} from "../types.js";

/**
 * The GPT Image 2.6 and 2.5 pairs. 2.6 Sunburst is the default (#3782); the
 * other three are chosen by name. All four take `background: "transparent"`
 * on png or webp, masks, custom sizes and the `xhigh`/`max` quality tiers, per
 * OpenAI's model pages and image-generation guide (2.5 checked 2026-09-29,
 * 2.6 checked 2026-11-09):
 *   https://developers.openai.com/api/docs/models/gpt-image-2.6-sunburst
 *   https://developers.openai.com/api/docs/models/gpt-image-2.6-flare
 *   https://developers.openai.com/api/docs/models/gpt-image-2.5-sunburst
 *   https://developers.openai.com/api/docs/models/gpt-image-2.5-flare
 *   https://developers.openai.com/api/docs/guides/image-generation
 *
 * Only the 2.6 pair takes `complexity` (low|medium|high, default high, no
 * separate fee) and returns animated GIFs (`output_format: "gif"`, #3783),
 * which need GIF preview access on the OpenAI organization, and author static
 * SVG on generations (`output_format: "svg"`, `n` 1, #3784). The 2.5 pair is not deprecated upstream and stays
 * selectable. gpt-image-2 and gpt-image-1.5 are retired (`../retired.ts`) and
 * must not be re-added as a fallback.
 */
const GPT_IMAGE = {
  provider: "openai",
  transparentBackground: true,
  maskInpainting: true,
  arbitraryDimensions: true,
  presetSizes: PRESETS,
  maxEdgePx: OPENAI_LIMITS.maxEdge,
  maxTotalPixels: OPENAI_LIMITS.maxTotalPixels,
  // OpenAI documents no reference-image ceiling for 2.5 or 2.6; this is the
  // ceiling the edits endpoint has held for GPT-image models, not a measurement.
  maxReferenceImages: 16,
  characterConsistency: 0,
  // No independent measurement of any 2.5 or 2.6 model exists yet. The arena
  // text-rendering lead in evidence.ts was measured on gpt-image-2 and does
  // not transfer by name.
  strongTextRendering: false,
  watermarked: false,
  outputFormats: ["png", "jpeg", "webp"] as ModelCapabilities["outputFormats"],
  defaultFormat: "png",
  // Billed per token, so there is no single per-image figure to show. A dry
  // run with a quality and a size is priced by `estimateOpenAiOutputCost`.
  approxCostUsd1K: null,
} satisfies Omit<ModelCapabilities, "id" | "summary" | "complexityControl">;

/** The 2.6 pair adds animated GIF (#3783) and authored SVG (#3784) to the shared formats. */
const GPT_IMAGE_26_FORMATS: ModelCapabilities["outputFormats"] = [...GPT_IMAGE.outputFormats, "gif", "svg"];

const MODELS: ModelCapabilities[] = [
  {
    id: "gpt-image-2.6-sunburst",
    summary:
      "OpenAI's most capable image model — the default; complexity control, transparency on png/webp, masks, custom sizes, xhigh/max quality, no watermark",
    ...GPT_IMAGE,
    complexityControl: true,
    outputFormats: GPT_IMAGE_26_FORMATS,
  },
  {
    id: "gpt-image-2.6-flare",
    summary:
      "OpenAI's fastest 2.6 model — chosen by --model; same complexity control, transparency, masks, sizes and quality tiers as Sunburst",
    ...GPT_IMAGE,
    complexityControl: true,
    outputFormats: GPT_IMAGE_26_FORMATS,
  },
  {
    id: "gpt-image-2.5-sunburst",
    summary: "The previous Sunburst — chosen by --model; no complexity control, otherwise as 2.6",
    ...GPT_IMAGE,
    complexityControl: false,
  },
  {
    id: "gpt-image-2.5-flare",
    summary: "The previous Flare — chosen by --model; no complexity control, otherwise as 2.6",
    ...GPT_IMAGE,
    complexityControl: false,
  },
];

/** What an OpenAI request sends when the caller states no quality (#3782). */
export const DEFAULT_OPENAI_QUALITY = "max" as const;
/** What a complexity-capable model gets when the caller states none (#3782). */
export const DEFAULT_OPENAI_COMPLEXITY = "high" as const;

/** The quality an OpenAI request actually sends: the stated one, or the default. */
export function openAiRequestQuality(req: ImageRequest): string {
  return req.quality ?? DEFAULT_OPENAI_QUALITY;
}

/**
 * The complexity an OpenAI request sends: the stated one or the default on a
 * model that takes it, nothing on one that does not. Routing has already
 * refused a stated complexity for such a model.
 */
export function openAiRequestComplexity(req: ImageRequest, model: string): string | undefined {
  if (!MODELS.find((m) => m.id === model)?.complexityControl) return undefined;
  return req.complexity ?? DEFAULT_OPENAI_COMPLEXITY;
}

/**
 * USD per 1M tokens, from each model's page (2.5 checked 2026-09-29, 2.6
 * checked 2026-11-09). The rows are equal today; that makes none of them a
 * per-image price, because the models do not spend the same number of tokens
 * on the same image.
 */
const TOKEN_RATES: Record<string, { textIn: number; imageIn: number; imageOut: number }> = {
  "gpt-image-2.6-sunburst": { textIn: 5, imageIn: 8, imageOut: 30 },
  "gpt-image-2.6-flare": { textIn: 5, imageIn: 8, imageOut: 30 },
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
 * Output tokens per image for the GPT Image 2.5 and 2.6 models, from the
 * calculator in OpenAI's image-generation guide (checked 2026-09-29 for 2.5;
 * on 2026-11-09 the guide states the same calculator covers 2.6 and 2.5
 * Sunburst/Flare). It has one table for all four models. The long edge gets the tier's base count,
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

async function readError(res: Response, req: ImageRequest): Promise<never> {
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
  // GIF output is a preview feature: an organization without access gets a
  // 4xx about it, and neither retrying nor the generic hints below help.
  const gifAccess =
    req.format === "gif" && (res.status === 400 || res.status === 403) && /\bgif\b|preview/i.test(message);
  if (gifAccess) {
    hints.push("GIF output needs GIF preview access for this model on the OpenAI organization; ask without --format gif meanwhile");
  }
  if (code === "moderation_blocked") {
    hints.push(`refused by moderation${moderation ? ` — ${moderation}` : ""}`);
  }
  // The host's provider relay refused before contacting OpenAI (#3431): its
  // message says why, and the account hint would point the agent elsewhere.
  const relayRefusal = code === "brain_provider_refused" || code === "budget_exceeded";
  if (res.status === 403 && !relayRefusal && !gifAccess) hints.push("region not supported, or the org is not verified");
  if (res.status === 400 && /model/i.test(message) && !gifAccess) {
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
      mime: formatMime(req.format ?? "png"),
    }));
  if (images.length === 0) {
    throw new ImageProviderError("OpenAI returned no image data", { retryable: false });
  }
  if (req.format === "svg") {
    // The API's "static" is a claim; the bytes are checked before anyone
    // writes them (#3784). The call has been paid for either way.
    for (const image of images) {
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(image.data);
      } catch {
        throw new ImageProviderError("OpenAI returned an SVG that is not UTF-8; nothing was written.", { retryable: false });
      }
      const problem = staticSvgProblem(text);
      if (problem) {
        throw new ImageProviderError(
          `OpenAI returned an SVG that is not static (${problem}); nothing was written. Ask again, or ask for png.`,
          { retryable: false }
        );
      }
    }
  }
  return {
    images,
    provider: "openai",
    model,
    // SVG authoring tokens (`svg_usage`) are billed at the authoring model's
    // rate, which is not published here, so an SVG's cost stays unknown.
    costUsd: req.format === "svg" ? undefined : openAiCostFromUsage(model, body.usage),
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
    // Highest quality and complexity unless the caller said otherwise (#3782).
    const quality = openAiRequestQuality(req);
    const complexity = openAiRequestComplexity(req, model);
    if (req.complexity && !complexity) {
      throw new ImageProviderError(`${model} does not take complexity; the GPT Image 2.6 models do.`, {
        retryable: false,
      });
    }
    const gif = req.format === "gif";
    if (gif && !MODELS.find((m) => m.id === model)?.outputFormats.includes("gif")) {
      throw new ImageProviderError(`${model} does not return GIF; the GPT Image 2.6 models do.`, { retryable: false });
    }
    if (gif && (req.mask || req.transparent)) {
      throw new ImageProviderError("GIF output takes no mask and no transparent background.", { retryable: false });
    }
    if (req.format === "svg" && !MODELS.find((m) => m.id === model)?.outputFormats.includes("svg")) {
      throw new ImageProviderError(`${model} does not author SVG; the GPT Image 2.6 models do.`, { retryable: false });
    }
    if (req.format === "svg" && (isEdit || req.transparent || (req.n ?? 1) > 1)) {
      throw new ImageProviderError("SVG is a single new image: no references, mask, transparent background or n above 1.", {
        retryable: false,
      });
    }
    if (!gif && (req.frames !== undefined || req.frameDurationMs !== undefined)) {
      throw new ImageProviderError("Frame count and frame duration apply to GIF output only.", { retryable: false });
    }
    const headers = { Authorization: `Bearer ${apiKey}` };
    // Without the key, the host's metered relay adds it (#1673).
    const send = providerRelayFetch("openai", "OPENAI_API_KEY") ?? fetch;

    if (!isEdit) {
      const payload: Record<string, unknown> = { model, prompt: req.prompt };
      if (size && size !== "auto") payload.size = size;
      payload.quality = quality;
      if (complexity) payload.complexity = complexity;
      // Alpha needs a format that can carry it; the API's default is png, but
      // be explicit so a caller-set default cannot flatten the transparency.
      if (req.format) payload.output_format = req.format;
      else if (req.transparent) payload.output_format = "png";
      // Unset frame settings stay unsent: the API's defaults (9, 200 ms) apply.
      if (req.frames !== undefined) payload.frame_count = req.frames;
      if (req.frameDurationMs !== undefined) payload.frame_duration_ms = req.frameDurationMs;
      if (req.n && req.n > 1) payload.n = req.n;
      // `transparent` is only legal on models that support it; routing guarantees that.
      if (req.transparent) payload.background = "transparent";

      const res = await send(`${resolveEnv().openaiBaseUrl}/images/generations`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) await readError(res, req);
      return decode((await res.json()) as OpenAiImageResponse, model, req);
    }

    // Edits are multipart. Reference images repeat as `image[]`; the mask is a
    // PNG whose fully transparent pixels mark what may change, and it applies
    // to the FIRST image only.
    const form = new FormData();
    form.append("model", model);
    form.append("prompt", req.prompt);
    if (size && size !== "auto") form.append("size", size);
    form.append("quality", quality);
    if (complexity) form.append("complexity", complexity);
    if (req.format) form.append("output_format", req.format);
    else if (req.transparent) form.append("output_format", "png");
    if (req.transparent) form.append("background", "transparent");
    if (req.frames !== undefined) form.append("frame_count", String(req.frames));
    if (req.frameDurationMs !== undefined) form.append("frame_duration_ms", String(req.frameDurationMs));
    for (const [i, ref] of (req.references ?? []).entries()) {
      form.append("image[]", new Blob([ref.data as BlobPart], { type: ref.mime }), ref.label ?? `image-${i}.png`);
    }
    if (req.mask) {
      form.append("mask", new Blob([req.mask.data as BlobPart], { type: "image/png" }), "mask.png");
    }

    const res = await send(`${resolveEnv().openaiBaseUrl}/images/edits`, { method: "POST", headers, body: form });
    if (!res.ok) await readError(res, req);
    return decode((await res.json()) as OpenAiImageResponse, model, req);
  },
};
