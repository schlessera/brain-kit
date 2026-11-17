/**
 * Markup-guided edits (#3785): the checks a markup layer must pass before any
 * provider is paid, read from file headers only.
 *
 * OpenAI's image-generation guide (checked 2026-11-11) says the layer is a
 * separate transparent PNG, sent as `markup` on `/v1/images/edits` to the GPT
 * Image 2.5 and 2.6 models. It applies to the first input image, must match
 * that image's width and height after orientation, and may not be combined
 * with `mask`. The first image and the layer each hold at most 16,777,216
 * pixels, and the layer file at most 50 MB.
 *   https://developers.openai.com/api/docs/guides/image-generation
 */

import { imageHeader, isPng } from "@schlessera/brain-common/internal/image-header";

import type { ImageInput } from "./types.js";

// The header reader is shared with the chat server's markup application (#3975).
export { imageHeader, isPng, type ImageHeader } from "@schlessera/brain-common/internal/image-header";

export const MARKUP_LIMITS = { maxPixels: 16_777_216, maxBytes: 50 * 1024 * 1024 } as const;

/**
 * Why a markup layer cannot go with this first reference image, or null when
 * it can. Called before routing and again by the provider, so neither a CLI
 * caller nor a direct one pays for a request the API would refuse.
 */
export function markupProblem(markup: ImageInput, first: ImageInput | undefined): string | null {
  const name = markup.label ?? "the markup layer";
  if (!first) return "--markup annotates the first --ref image; add one with --ref.";
  if (markup.data.byteLength > MARKUP_LIMITS.maxBytes) {
    return `${name} is ${markup.data.byteLength} bytes; a markup layer may be at most 50 MB.`;
  }
  if (!isPng(markup.data)) return `${name} is not a PNG; a markup layer must be a transparent PNG.`;
  const layer = imageHeader(markup.data);
  if (!layer) return `${name} has no readable PNG header.`;
  if (!layer.alpha) {
    return `${name} has no alpha channel; draw the markup on a transparent PNG, not flattened onto the image.`;
  }
  const refName = first.label ?? "the first --ref image";
  const base = imageHeader(first.data);
  if (!base) return `Cannot read the width and height of ${refName}; markup needs a PNG, JPEG or WebP first --ref.`;
  for (const [what, h] of [[refName, base], [name, layer]] as const) {
    if (h.width * h.height > MARKUP_LIMITS.maxPixels) {
      return `${what} is ${h.width}x${h.height}, over the 16,777,216-pixel limit for markup edits.`;
    }
  }
  if (layer.width !== base.width || layer.height !== base.height) {
    return `${name} is ${layer.width}x${layer.height} but ${refName} is ${base.width}x${base.height}; the markup layer must match the first --ref exactly.`;
  }
  return null;
}
