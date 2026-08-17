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
  OPENAI_PRESET_SIZES as PRESETS,
  type Resolution,
} from "../shape.js";
import {
  ImageProviderError,
  type ImageRequest,
  type ImageResult,
  type ModelCapabilities,
  type Provider,
} from "../types.js";

const BASE = process.env.OPENAI_BASE_URL?.trim() || "https://api.openai.com/v1";

/**
 * gpt-image-2 is the current flagship. gpt-image-1.5 is kept for exactly one
 * reason: gpt-image-2 rejects `background: "transparent"`, and 1.5 does not —
 * a logo or overlay has to route somewhere.
 */
const MODELS: ModelCapabilities[] = [
  {
    id: "gpt-image-2",
    provider: "openai",
    summary: "OpenAI flagship — arbitrary dimensions, mask inpainting, no watermark",
    transparentBackground: false,
    maskInpainting: true,
    arbitraryDimensions: true,
    presetSizes: PRESETS,
    maxEdgePx: 3840,
    maxTotalPixels: 8_294_400,
    maxReferenceImages: 16,
    characterConsistency: 0,
    strongTextRendering: false,
    watermarked: false,
    outputFormats: ["png", "jpeg", "webp"],
    defaultFormat: "png",
    approxCostUsd1K: 0.211, // high quality, 1024x1024
  },
  {
    id: "gpt-image-1.5",
    provider: "openai",
    summary: "OpenAI, one generation back — the transparent-background option",
    transparentBackground: true,
    maskInpainting: true,
    // Verified live: a custom size is rejected with
    // "Invalid size '1360x768'. Supported sizes are 1024x1024, 1024x1536,
    // 1536x1024, and auto."
    arbitraryDimensions: false,
    presetSizes: PRESETS,
    maxEdgePx: 1536,
    maxTotalPixels: 1536 * 1024,
    maxReferenceImages: 16,
    characterConsistency: 0,
    strongTextRendering: false,
    watermarked: false,
    outputFormats: ["png", "jpeg", "webp"],
    defaultFormat: "png",
    approxCostUsd1K: 0.133,
  },
];

/** Per-image price by quality and size, from OpenAI's published cost table. */
const PRICE: Record<string, Record<string, number>> = {
  low: { "1024x1024": 0.006, "1024x1536": 0.005, "1536x1024": 0.005 },
  medium: { "1024x1024": 0.053, "1024x1536": 0.041, "1536x1024": 0.041 },
  high: { "1024x1024": 0.211, "1024x1536": 0.165, "1536x1024": 0.165 },
};

export function estimateOpenAiCost(quality: string | undefined, size: string | undefined): number | undefined {
  const q = quality && quality !== "auto" ? quality : "high"; // `auto` bills as what it picks; assume the worst
  return PRICE[q]?.[size ?? "1024x1024"] ?? PRICE[q]?.["1024x1024"];
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
    costUsd: estimateOpenAiCost(body.quality ?? req.quality, body.size ?? req.size),
    costIsEstimate: true,
    usage: body.usage,
  };
}

export const openaiProvider: Provider = {
  id: "openai",
  apiKeyEnv: "OPENAI_API_KEY",
  models: MODELS,

  async generate(model, req, apiKey) {
    const isEdit = (req.references?.length ?? 0) > 0 || !!req.mask;
    // OpenAI has no aspect-ratio parameter: a ratio is expressed as exact
    // pixels, so translate rather than dropping the caller's request.
    const caps = MODELS.find((m) => m.id === model);
    const size =
      req.size ??
      (req.aspect
        ? (caps?.arbitraryDimensions
            ? aspectToOpenAiSize(req.aspect, req.resolution as Resolution)
            : nearestPresetSize(req.aspect, caps?.presetSizes)) ?? undefined
        : undefined);
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

      const res = await fetch(`${BASE}/images/generations`, {
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
    if (req.transparent) form.append("background", "transparent");
    for (const [i, ref] of (req.references ?? []).entries()) {
      form.append("image[]", new Blob([ref.data as BlobPart], { type: ref.mime }), ref.label ?? `image-${i}.png`);
    }
    if (req.mask) {
      form.append("mask", new Blob([req.mask.data as BlobPart], { type: "image/png" }), "mask.png");
    }

    const res = await fetch(`${BASE}/images/edits`, { method: "POST", headers, body: form });
    if (!res.ok) await readError(res);
    return decode((await res.json()) as OpenAiImageResponse, model, req);
  },
};
