import type { Context } from "hono";

/** Ordinary JSON control-plane requests never need to be large. */
export const JSON_BODY_LIMIT_BYTES = 256 * 1024;

/** Render requests may contain inlined images and SVG. */
export const RENDER_BODY_LIMIT_BYTES = 5_000_000;

/** A body read within its limit: the chunks as streamed, and their total size. */
export interface BodyBytes {
  chunks: Uint8Array[];
  bytes: number;
}

/**
 * Read a request body, refusing to buffer more than `maxBytes`.
 *
 * A declared Content-Length over the limit refuses before the stream is
 * touched. Content-Length is only a hint (chunked and HTTP/2 bodies omit it,
 * and a client may lie), so the bytes are also counted off the stream itself.
 * The reader is cancelled and released on every exit: overflow, a failed read
 * and the end of the body alike. The chunks are returned as they arrived, not
 * concatenated, so a multipart caller need not copy the payload a second time;
 * `copyChunks` copies each chunk out of the reader's view first, for a caller
 * that keeps them beyond the read.
 *
 * Returns null when the body is over the limit. No body reads as zero bytes.
 */
export async function readBodyBytes(
  request: Request,
  maxBytes: number,
  options: { copyChunks?: boolean } = {}
): Promise<BodyBytes | null> {
  const declaredBytes = Number(request.headers.get("content-length") ?? undefined);
  if (Number.isFinite(declaredBytes) && declaredBytes > maxBytes) return null;

  const reader = request.body?.getReader();
  if (!reader) return { chunks: [], bytes: 0 };

  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      bytes += value.byteLength;
      if (bytes > maxBytes) return null;
      chunks.push(options.copyChunks ? value.slice() : value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    try { reader.releaseLock(); } catch { /* already released */ }
  }
  return { chunks, bytes };
}

/** The documented 413 for a body over its limit (`docs/http-api.md`). */
export function bodyTooLarge(c: Context): Response {
  return c.json({ error: "Request body too large" }, 413);
}

/**
 * Read and parse a JSON request without replacing the request object.
 *
 * The bytes are read through `readBodyBytes`, so a declared or streamed body
 * over the cap is refused without buffering it. Returning the 413 response
 * lets route-local invalid-JSON handling remain distinct from an oversized
 * request: an empty or invalid body throws, as `JSON.parse` does.
 */
export async function readJsonBody<T = unknown>(
  c: Context,
  maxBytes = JSON_BODY_LIMIT_BYTES
): Promise<T | Response> {
  const body = await readBodyBytes(c.req.raw, maxBytes);
  if (!body) return bodyTooLarge(c);
  return JSON.parse(decodeUtf8(body)) as T;
}

/** Decode a body read by `readBodyBytes` as UTF-8, replacing malformed sequences. */
export function decodeUtf8(body: BodyBytes): string {
  return new TextDecoder().decode(Buffer.concat(body.chunks, body.bytes));
}
