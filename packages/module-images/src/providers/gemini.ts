/**
 * Google's image models ("Nano Banana") over the Interactions API.
 *
 * POST /v1beta/interactions is what Google's image documentation now teaches;
 * the older `models/{id}:generateContent` path still works but has a live bug
 * where `imageConfig.imageSize` is ignored.
 *
 * Two things here come from calling the endpoint rather than reading the docs:
 * every one of these models rejects `image/png` and serves JPEG only, and the
 * bytes arrive inside `steps[].content[]` rather than in the flat
 * `output_image` the API reference describes.
 *
 * Auth is the `x-goog-api-key` header, not a query parameter — a key in a URL
 * ends up in logs and proxy history.
 */

import { ImageProviderError, type ModelCapabilities, type Provider } from "../types.js";

const BASE =
  process.env.GEMINI_BASE_URL?.trim() || "https://generativelanguage.googleapis.com/v1beta";

const MODELS: ModelCapabilities[] = [
  {
    id: "gemini-3-pro-image",
    provider: "gemini",
    summary: "Nano Banana Pro — strongest text rendering, 5-character consistency, 4K",
    transparentBackground: false,
    maskInpainting: false,
    arbitraryDimensions: false,
    presetSizes: [],
    maxEdgePx: 3840,
    maxTotalPixels: 8_294_400,
    maxReferenceImages: 6,
    characterConsistency: 5,
    strongTextRendering: true,
    watermarked: true,
    outputFormats: ["jpeg"],
    defaultFormat: "jpeg",
    approxCostUsd1K: 0.134,
  },
  {
    id: "gemini-3.1-flash-image",
    provider: "gemini",
    summary: "Nano Banana 2 — the workhorse; 10 references, 4 characters, up to 4K",
    transparentBackground: false,
    maskInpainting: false,
    arbitraryDimensions: false,
    presetSizes: [],
    maxEdgePx: 3840,
    maxTotalPixels: 8_294_400,
    maxReferenceImages: 10,
    characterConsistency: 4,
    strongTextRendering: true,
    watermarked: true,
    outputFormats: ["jpeg"],
    defaultFormat: "jpeg",
    approxCostUsd1K: 0.067,
  },
  {
    id: "gemini-3.1-flash-lite-image",
    provider: "gemini",
    summary: "Nano Banana 2 Lite — cheapest; 1K only, 14 references",
    transparentBackground: false,
    maskInpainting: false,
    arbitraryDimensions: false,
    presetSizes: [],
    maxEdgePx: 1024,
    maxTotalPixels: 1024 * 1024,
    maxReferenceImages: 14,
    characterConsistency: 0,
    strongTextRendering: true,
    watermarked: true,
    outputFormats: ["jpeg"],
    defaultFormat: "jpeg",
    approxCostUsd1K: 0.0336,
  },
];

/** Per-image price by model and resolution bucket, from Google's pricing page. */
const PRICE: Record<string, Partial<Record<string, number>>> = {
  "gemini-3-pro-image": { "1K": 0.134, "2K": 0.134, "4K": 0.24 },
  "gemini-3.1-flash-image": { "512px": 0.045, "1K": 0.067, "2K": 0.101, "4K": 0.151 },
  "gemini-3.1-flash-lite-image": { "1K": 0.0336 },
};

export function estimateGeminiCost(model: string, resolution: string | undefined): number | undefined {
  return PRICE[model]?.[resolution ?? "1K"] ?? PRICE[model]?.["1K"];
}

interface InteractionContent {
  type?: string;
  data?: string;
  mime_type?: string;
  text?: string;
}

interface InteractionResponse {
  status?: string;
  /** Documented in the API reference; not populated by the live endpoint. */
  output_image?: { data?: string; mime_type?: string };
  output_text?: string;
  /** What the endpoint really returns: a `thought` step, then `model_output`. */
  steps?: { type?: string; content?: InteractionContent[] }[];
  usage?: Record<string, unknown>;
  errors?: { code?: string; message?: string }[];
}

/**
 * Pull the image and any commentary out of a response.
 *
 * The API reference documents a flat `output_image`, but the live endpoint
 * returns the bytes as an `image` content part inside the `model_output` step
 * instead, alongside a `thought` step whose `signature` runs to hundreds of
 * kilobytes. Both shapes are handled — the documented one first, in case it
 * ever starts appearing, then the one that actually arrives.
 */
function extract(body: InteractionResponse): { image?: InteractionContent; text?: string } {
  if (body.output_image?.data) {
    return {
      image: { data: body.output_image.data, mime_type: body.output_image.mime_type },
      text: body.output_text,
    };
  }
  const parts = (body.steps ?? [])
    .filter((s) => s.type !== "thought")
    .flatMap((s) => s.content ?? []);
  const text =
    body.output_text ||
    parts
      .filter((c) => c.type === "text" && c.text)
      .map((c) => c.text)
      .join(" ") ||
    undefined;
  return { image: parts.find((c) => c.type === "image" && c.data), text };
}

export const geminiProvider: Provider = {
  id: "gemini",
  apiKeyEnv: "GEMINI_API_KEY",
  models: MODELS,

  async generate(model, req, apiKey) {
    const input: Record<string, unknown>[] = [{ type: "text", text: req.prompt }];
    // Editing is the same call with image parts alongside the text. There is no
    // mask concept in this API — routing sends masked work to OpenAI.
    for (const ref of req.references ?? []) {
      input.push({
        type: "image",
        mime_type: ref.mime,
        data: Buffer.from(ref.data).toString("base64"),
      });
    }

    const responseFormat: Record<string, unknown> = { type: "image" };
    if (req.format) responseFormat.mime_type = `image/${req.format}`;
    if (req.aspect) responseFormat.aspect_ratio = req.aspect;
    if (req.resolution) responseFormat.image_size = req.resolution;

    const res = await fetch(`${BASE}/interactions`, {
      method: "POST",
      headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ model, input, response_format: responseFormat }),
    });

    if (!res.ok) {
      let message = `${res.status} ${res.statusText}`;
      try {
        const body = (await res.json()) as { error?: { message?: string; status?: string } };
        if (body.error?.message) message = body.error.message;
      } catch {
        /* non-JSON error body */
      }
      throw new ImageProviderError(
        `Gemini: ${message}${res.status === 429 ? " (rate limit or quota — RESOURCE_EXHAUSTED)" : ""}`,
        { retryable: res.status === 429 || res.status >= 500, status: res.status }
      );
    }

    const body = (await res.json()) as InteractionResponse;
    const { image, text } = extract(body);

    // A refusal comes back as HTTP 200 with no image part, so a status-code
    // check alone silently yields nothing.
    if (!image?.data) {
      const why = body.errors?.map((e) => e.message ?? e.code).filter(Boolean).join("; ");
      throw new ImageProviderError(
        `Gemini returned no image${body.status ? ` (status: ${body.status})` : ""}` +
          `${why ? ` — ${why}` : ""}${text ? ` — model said: ${text}` : ""}`,
        { retryable: false }
      );
    }

    return {
      images: [
        {
          data: Uint8Array.from(Buffer.from(image.data, "base64")),
          mime: image.mime_type ?? "image/jpeg",
        },
      ],
      provider: "gemini",
      model,
      costUsd: estimateGeminiCost(model, req.resolution),
      costIsEstimate: true,
      usage: body.usage,
      note: text,
    };
  },
};
