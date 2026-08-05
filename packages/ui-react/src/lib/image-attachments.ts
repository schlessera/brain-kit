import type { ChatImageAttachment } from "@schlessera/brain-ui-sdk/protocol";
import {
  DOWNSCALE_MAX_EDGE,
  MAX_IMAGES_PER_MESSAGE,
  MAX_IMAGE_BYTES,
  MAX_TOTAL_IMAGE_BYTES,
} from "@schlessera/brain-ui-sdk/protocol";

/**
 * The vision API silently drops images below a minimum pixel size (a 2x2 PNG
 * is stripped with a misleading "could not be processed" note; 64x64 is fine).
 * Reject anything smaller than this on either edge so the failure is explicit.
 */
const MIN_IMAGE_EDGE = 32;

/** A processed attachment plus a local object URL for the composer preview. */
export interface PendingAttachment {
  attachment: ChatImageAttachment;
  previewUrl: string;
  /** Decoded byte length (post-downscale) — used for total-size validation. */
  bytes: number;
  /** Original file name, for error messages. */
  name: string;
}

type FileToAttachmentResult =
  | { attachment: ChatImageAttachment; previewUrl: string; bytes: number }
  | { error: string };

/** base64 length → decoded byte count (accounts for `=` padding). */
function decodedBytesFromBase64(b64: string): number {
  const padding = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return Math.floor((b64.length * 3) / 4) - padding;
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      // Strip the `data:<mime>;base64,` prefix — protocol wants raw base64.
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error ?? new Error("read_failed"));
    reader.readAsDataURL(blob);
  });
}

/**
 * Decode a file to raw pixels. Prefers `createImageBitmap` (honors EXIF
 * orientation) and falls back to an `<img>` decode when it rejects (e.g.
 * older Safari, some codecs).
 */
async function decodeImage(
  file: File
): Promise<{ width: number; height: number; draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void } | null> {
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    return {
      width: bitmap.width,
      height: bitmap.height,
      draw: (ctx, w, h) => {
        ctx.drawImage(bitmap, 0, 0, w, h);
        bitmap.close();
      },
    };
  } catch {
    // Fallback: HTMLImageElement decode via an object URL.
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      const width = img.naturalWidth;
      const height = img.naturalHeight;
      return {
        width,
        height,
        draw: (ctx, w, h) => ctx.drawImage(img, 0, 0, w, h),
      };
    } catch {
      return null;
    } finally {
      URL.revokeObjectURL(url);
    }
  }
}

/**
 * Turn a picked/pasted image File into a wire-ready attachment plus a preview
 * URL. GIFs pass through un-re-encoded (size-checked only) so animation
 * survives; everything else is downscaled to `DOWNSCALE_MAX_EDGE` and
 * re-encoded to JPEG. Rejects (with a human message) on unsupported types,
 * decode failure, or oversize-after-downscale.
 */
export async function fileToAttachment(
  file: File
): Promise<FileToAttachmentResult> {
  const type = file.type || "";

  // GIF: keep the raw bytes (canvas would flatten the animation). Measure its
  // dimensions for the min-size guard without re-encoding, then size-check.
  if (type === "image/gif") {
    try {
      const bmp = await createImageBitmap(file);
      const tooSmall = bmp.width < MIN_IMAGE_EDGE || bmp.height < MIN_IMAGE_EDGE;
      bmp.close();
      if (tooSmall) {
        return {
          error: `${file.name}: image too small (min ${MIN_IMAGE_EDGE}px per edge)`,
        };
      }
    } catch {
      // Couldn't measure — fall through and let the size check gate it.
    }
    const data = await blobToBase64(file);
    const bytes = decodedBytesFromBase64(data);
    if (bytes > MAX_IMAGE_BYTES) {
      return { error: `${file.name}: GIF too large (max ${mb(MAX_IMAGE_BYTES)})` };
    }
    return {
      attachment: { data, mediaType: "image/gif" },
      previewUrl: URL.createObjectURL(file),
      bytes,
    };
  }

  if (!type.startsWith("image/")) {
    return { error: `${file.name}: not an image` };
  }

  const decoded = await decodeImage(file);
  if (!decoded) {
    return {
      error: `${file.name}: couldn't read this image (unsupported format?)`,
    };
  }

  const { width, height } = decoded;
  if (!width || !height) {
    return { error: `${file.name}: couldn't read this image` };
  }
  if (width < MIN_IMAGE_EDGE || height < MIN_IMAGE_EDGE) {
    return {
      error: `${file.name}: image too small (min ${MIN_IMAGE_EDGE}px per edge)`,
    };
  }

  // Scale so the longest edge is at most DOWNSCALE_MAX_EDGE.
  const scale = Math.min(1, DOWNSCALE_MAX_EDGE / Math.max(width, height));
  const targetW = Math.max(1, Math.round(width * scale));
  const targetH = Math.max(1, Math.round(height * scale));

  const canvas = document.createElement("canvas");
  canvas.width = targetW;
  canvas.height = targetH;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return { error: `${file.name}: canvas unavailable` };
  }
  decoded.draw(ctx, targetW, targetH);

  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, "image/jpeg", 0.85)
  );
  if (!blob) {
    return { error: `${file.name}: failed to encode` };
  }

  const data = await blobToBase64(blob);
  const bytes = decodedBytesFromBase64(data);
  if (bytes > MAX_IMAGE_BYTES) {
    return {
      error: `${file.name}: still ${mb(bytes)} after downscale (max ${mb(MAX_IMAGE_BYTES)})`,
    };
  }

  return {
    attachment: { data, mediaType: "image/jpeg" },
    previewUrl: URL.createObjectURL(blob),
    bytes,
  };
}

/**
 * Enforce message-level caps against a proposed set of attachments (existing
 * pending + newly added). Returns the accepted subset and per-file rejection
 * reasons; never mutates the input.
 */
export function validateAttachments(pending: PendingAttachment[]): {
  accepted: PendingAttachment[];
  errors: string[];
} {
  const accepted: PendingAttachment[] = [];
  const errors: string[] = [];
  let total = 0;

  for (const item of pending) {
    if (accepted.length >= MAX_IMAGES_PER_MESSAGE) {
      errors.push(
        `${item.name}: over the ${MAX_IMAGES_PER_MESSAGE}-image limit`
      );
      continue;
    }
    if (total + item.bytes > MAX_TOTAL_IMAGE_BYTES) {
      errors.push(
        `${item.name}: over the ${mb(MAX_TOTAL_IMAGE_BYTES)} total-size limit`
      );
      continue;
    }
    total += item.bytes;
    accepted.push(item);
  }

  return { accepted, errors };
}

function mb(bytes: number): string {
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}
