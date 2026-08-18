/**
 * Client-side image optimization, used only for the "share optimized" action.
 *
 * Nothing in this file runs unless the reader asks for it. A generated image is
 * stored and displayed at full quality — the server's 10 MB cap is the only
 * hard limit — and this exists so that sending one through a messaging app is a
 * separate, deliberate choice rather than a silent downgrade of the original.
 *
 * JPEG, not WebP: the destination is an OS share sheet, and some messaging apps
 * treat a WebP as a sticker rather than a photo. Alpha is composited onto white
 * first, so a transparent PNG does not come out with black edges.
 */

/** What "optimized" means: long-edge ceiling and a byte target to land under. */
export interface OptimizeTarget {
  maxEdge: number;
  maxBytes: number;
}

/**
 * Comfortable for messaging: still sharp on a phone screen at full zoom, and
 * small enough to send on mobile data. Not a limit imposed anywhere else in the
 * app — only this action's definition of "lighter".
 */
export const SHARE_OPTIMIZED: OptimizeTarget = {
  maxEdge: 2048,
  // 1 MiB, matching the binary units `formatBytes` reports in — a decimal
  // 1,000,000 renders as the nonsense "under 977 KB".
  maxBytes: 1_048_576,
};

export interface OptimizeStep {
  width: number;
  height: number;
  quality: number;
}

/** Quality ladder walked at each size before giving up edge resolution. */
const QUALITY_LADDER = [0.85, 0.72, 0.6];
/** Each extra pass halves the long edge; two are enough to cross any real gap. */
const SHRINK_PASSES = 2;

/**
 * The ordered list of (size, quality) attempts, most faithful first.
 *
 * Pure and deterministic so the policy is testable without a canvas: the async
 * encoder below just walks this and stops at the first result under the byte
 * target.
 */
export function optimizationLadder(
  width: number,
  height: number,
  target: OptimizeTarget = SHARE_OPTIMIZED
): OptimizeStep[] {
  const longEdge = Math.max(width, height);
  const fit = longEdge > target.maxEdge ? target.maxEdge / longEdge : 1;
  const steps: OptimizeStep[] = [];
  for (let pass = 0; pass <= SHRINK_PASSES; pass++) {
    const scale = fit / 2 ** pass;
    const w = Math.max(1, Math.round(width * scale));
    const h = Math.max(1, Math.round(height * scale));
    for (const quality of QUALITY_LADDER) {
      steps.push({ width: w, height: h, quality });
    }
    // Below this the image stops being worth sending at all; stop shrinking.
    if (Math.max(w, h) <= 320) break;
  }
  return steps;
}

/**
 * True when a blob is already within the target and re-encoding would only
 * throw away quality for nothing.
 */
export function alreadyWithinTarget(
  bytes: number,
  width: number,
  height: number,
  target: OptimizeTarget = SHARE_OPTIMIZED
): boolean {
  return bytes <= target.maxBytes && Math.max(width, height) <= target.maxEdge;
}

interface Decoded {
  width: number;
  height: number;
  draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void;
  release: () => void;
}

/**
 * Decode a blob to something drawable. Prefers `createImageBitmap` (honors EXIF
 * orientation) and falls back to an `<img>` decode when it rejects.
 */
async function decode(blob: Blob): Promise<Decoded | null> {
  try {
    const bitmap = await createImageBitmap(blob, { imageOrientation: "from-image" });
    return {
      width: bitmap.width,
      height: bitmap.height,
      draw: (ctx, w, h) => ctx.drawImage(bitmap, 0, 0, w, h),
      release: () => bitmap.close(),
    };
  } catch {
    const url = URL.createObjectURL(blob);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      return {
        width: img.naturalWidth,
        height: img.naturalHeight,
        draw: (ctx, w, h) => ctx.drawImage(img, 0, 0, w, h),
        release: () => URL.revokeObjectURL(url),
      };
    } catch {
      URL.revokeObjectURL(url);
      return null;
    }
  }
}

function encode(canvas: HTMLCanvasElement, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
}

export interface OptimizeResult {
  blob: Blob;
  width: number;
  height: number;
  /** True when the target was met; false when even the last step overshot. */
  metTarget: boolean;
}

/**
 * Re-encode an image down toward `target`.
 *
 * Returns `null` when the source is already within the target (share the
 * original instead — there is nothing to gain) or cannot be decoded. Otherwise
 * returns the first ladder step that lands under the byte target, or the
 * smallest step tried with `metTarget: false` if none does.
 */
export async function optimizeImage(
  source: Blob,
  target: OptimizeTarget = SHARE_OPTIMIZED
): Promise<OptimizeResult | null> {
  const decoded = await decode(source);
  if (!decoded || !decoded.width || !decoded.height) return null;

  try {
    if (alreadyWithinTarget(source.size, decoded.width, decoded.height, target)) {
      return null;
    }

    const canvas = document.createElement("canvas");
    const steps = optimizationLadder(decoded.width, decoded.height, target);
    let last: OptimizeResult | null = null;

    for (const step of steps) {
      canvas.width = step.width;
      canvas.height = step.height;
      const ctx = canvas.getContext("2d");
      if (!ctx) return null;
      // JPEG has no alpha: paint the sheet white first so transparency reads as
      // page white rather than as the black an unpainted canvas decodes to.
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, step.width, step.height);
      decoded.draw(ctx, step.width, step.height);

      const blob = await encode(canvas, step.quality);
      if (!blob) continue;
      last = { blob, width: step.width, height: step.height, metTarget: false };
      if (blob.size <= target.maxBytes) {
        return { ...last, metTarget: true };
      }
    }

    return last;
  } finally {
    decoded.release();
  }
}

/** `photo.png` -> `photo.jpg`; anything without a known extension just gains one. */
export function optimizedFilename(filename: string): string {
  const base = filename.replace(/\.(png|jpe?g|webp|gif|avif|bmp|tiff?)$/i, "");
  return `${base}.jpg`;
}

/** Human-readable byte count for share hints. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
