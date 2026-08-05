import type { ChatImageAttachment } from "@schlessera/brain-ui-sdk/protocol";
import {
  ALLOWED_IMAGE_MEDIA_TYPES,
  MAX_IMAGE_BYTES,
  MAX_IMAGES_PER_MESSAGE,
  MAX_TOTAL_IMAGE_BYTES,
} from "@schlessera/brain-ui-sdk/protocol";

export function estimateDecodedBase64Bytes(data: string): number {
  const normalized = data.replace(/\s/g, "");
  const padding = normalized.endsWith("==")
    ? 2
    : normalized.endsWith("=")
      ? 1
      : 0;
  return Math.floor((normalized.length * 3) / 4) - padding;
}

export function validateAttachments(
  attachments: unknown
): { ok: true; attachments: ChatImageAttachment[] } | { ok: false; reason: string } {
  if (attachments === undefined) {
    return { ok: true, attachments: [] };
  }

  if (!Array.isArray(attachments)) {
    return { ok: false, reason: "Attachments must be an array" };
  }

  if (attachments.length > MAX_IMAGES_PER_MESSAGE) {
    return {
      ok: false,
      reason: `Too many images attached; maximum is ${MAX_IMAGES_PER_MESSAGE}`,
    };
  }

  let totalBytes = 0;
  const validated: ChatImageAttachment[] = [];

  for (const attachment of attachments) {
    if (
      !attachment ||
      typeof attachment !== "object" ||
      typeof (attachment as ChatImageAttachment).data !== "string"
    ) {
      return { ok: false, reason: "Each attachment must include base64 image data" };
    }

    const data = (attachment as ChatImageAttachment).data;
    if (
      data.length === 0 ||
      data.length % 4 !== 0 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(data)
    ) {
      return { ok: false, reason: "Attachment data is not valid base64" };
    }

    const mediaType = (attachment as ChatImageAttachment).mediaType;
    if (!ALLOWED_IMAGE_MEDIA_TYPES.includes(mediaType)) {
      return {
        ok: false,
        reason: `Unsupported image type: ${String(mediaType)}`,
      };
    }

    const bytes = estimateDecodedBase64Bytes((attachment as ChatImageAttachment).data);
    if (bytes > MAX_IMAGE_BYTES) {
      return {
        ok: false,
        reason: `Image is too large; maximum decoded size is ${MAX_IMAGE_BYTES} bytes`,
      };
    }

    totalBytes += bytes;
    if (totalBytes > MAX_TOTAL_IMAGE_BYTES) {
      return {
        ok: false,
        reason: `Attached images are too large; maximum total decoded size is ${MAX_TOTAL_IMAGE_BYTES} bytes`,
      };
    }

    validated.push(attachment as ChatImageAttachment);
  }

  return { ok: true, attachments: validated };
}
