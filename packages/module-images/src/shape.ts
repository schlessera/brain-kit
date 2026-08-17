/**
 * One vocabulary for image shape, translated per provider.
 *
 * The two families disagree about how you ask for a shape. OpenAI takes exact
 * pixels (`1536x1024`) on a 16-pixel grid, within a total-pixel band. Gemini
 * takes a fixed aspect ratio from a list of ten, plus a resolution bucket
 * (512px/1K/2K/4K), and rejects anything else.
 *
 * Rather than leak that split into the CLI — where `--aspect` would silently do
 * nothing on OpenAI — a request states aspect and/or resolution, and each
 * provider gets it in its own terms.
 */

/** The ten ratios Gemini accepts. Anything else is a hard API rejection. */
export const GEMINI_ASPECTS = [
  "1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9",
] as const;

export type Resolution = "512px" | "1K" | "2K" | "4K";

/** Target pixel counts for each bucket, used to turn a ratio into exact pixels. */
const BUCKET_PIXELS: Record<Resolution, number> = {
  "512px": 512 * 512,
  "1K": 1024 * 1024,
  "2K": 2048 * 2048,
  "4K": 3840 * 2160,
};

/** OpenAI's published constraints for a custom size. */
export const OPENAI_LIMITS = {
  minTotalPixels: 655_360,
  maxTotalPixels: 8_294_400,
  maxEdge: 3840,
  grid: 16,
};

export function parseAspect(aspect: string): { w: number; h: number } | null {
  const m = /^(\d+):(\d+)$/.exec(aspect.trim());
  if (!m) return null;
  const [w, h] = [Number(m[1]), Number(m[2])];
  if (w <= 0 || h <= 0) return null;
  return { w, h };
}

const roundToGrid = (n: number) => Math.max(OPENAI_LIMITS.grid, Math.round(n / OPENAI_LIMITS.grid) * OPENAI_LIMITS.grid);

/**
 * Turn an aspect ratio and resolution bucket into exact pixels OpenAI accepts.
 *
 * Both edges land on the 16-pixel grid, neither exceeds 3840, and the total
 * stays inside the band — including the floor, which matters because a "512px"
 * request is *below* OpenAI's minimum and has to be scaled up rather than
 * rejected.
 */
export function aspectToOpenAiSize(aspect: string, resolution: Resolution = "1K"): string | null {
  const ratio = parseAspect(aspect);
  if (!ratio) return null;

  let target = BUCKET_PIXELS[resolution];
  target = Math.min(Math.max(target, OPENAI_LIMITS.minTotalPixels), OPENAI_LIMITS.maxTotalPixels);

  const scale = Math.sqrt(target / (ratio.w * ratio.h));
  let w = roundToGrid(ratio.w * scale);
  let h = roundToGrid(ratio.h * scale);

  // Clamp the long edge, preserving the ratio as closely as the grid allows.
  if (Math.max(w, h) > OPENAI_LIMITS.maxEdge) {
    const shrink = OPENAI_LIMITS.maxEdge / Math.max(w, h);
    w = roundToGrid(w * shrink);
    h = roundToGrid(h * shrink);
  }
  // Rounding can push the total under the floor; nudge the short edge up.
  while (w * h < OPENAI_LIMITS.minTotalPixels) {
    if (w <= h) w += OPENAI_LIMITS.grid;
    else h += OPENAI_LIMITS.grid;
  }
  while (w * h > OPENAI_LIMITS.maxTotalPixels) {
    if (w >= h) w -= OPENAI_LIMITS.grid;
    else h -= OPENAI_LIMITS.grid;
  }
  return `${w}x${h}`;
}

/** Nearest Gemini-legal ratio to an exact size, for reporting what was substituted. */
export function sizeToNearestGeminiAspect(size: string): string | null {
  const m = /^(\d+)x(\d+)$/.exec(size);
  if (!m) return null;
  const target = Number(m[1]) / Number(m[2]);
  let best: string | null = null;
  let bestDelta = Infinity;
  for (const a of GEMINI_ASPECTS) {
    const r = parseAspect(a)!;
    const delta = Math.abs(r.w / r.h - target);
    if (delta < bestDelta) {
      bestDelta = delta;
      best = a;
    }
  }
  return best;
}

/** The only sizes every GPT-image model accepts. */
export const OPENAI_PRESET_SIZES = ["1024x1024", "1536x1024", "1024x1536"];

/** Closest preset to a requested ratio, for models that reject custom sizes. */
export function nearestPresetSize(aspect: string, presets = OPENAI_PRESET_SIZES): string | null {
  const ratio = parseAspect(aspect);
  if (!ratio) return null;
  const want = ratio.w / ratio.h;
  let best: string | null = null;
  let bestDelta = Infinity;
  for (const preset of presets) {
    const [w, h] = preset.split("x").map(Number);
    const delta = Math.abs(w / h - want);
    if (delta < bestDelta) {
      bestDelta = delta;
      best = preset;
    }
  }
  return best;
}

export function isGeminiAspect(aspect: string): boolean {
  return (GEMINI_ASPECTS as readonly string[]).includes(aspect.trim());
}
