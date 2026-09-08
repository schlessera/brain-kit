import type { Context } from "hono";

/** Ordinary JSON control-plane requests never need to be large. */
export const JSON_BODY_LIMIT_BYTES = 256 * 1024;

/** Render requests may contain inlined images and SVG. */
export const RENDER_BODY_LIMIT_BYTES = 5_000_000;

/**
 * Read and parse a JSON request without replacing the request object.
 *
 * Content-Length can reject an oversized request before its stream is touched.
 * Lengthless and chunked bodies are counted while streaming and cancelled as
 * soon as they cross the cap. Returning the 413 response lets route-local
 * invalid-JSON handling remain distinct from an oversized request.
 */
export async function readJsonBody<T = unknown>(
  c: Context,
  maxBytes = JSON_BODY_LIMIT_BYTES
): Promise<T | Response> {
  const contentLength = c.req.header("content-length");
  if (contentLength !== undefined) {
    const declaredBytes = Number(contentLength);
    if (Number.isFinite(declaredBytes) && declaredBytes > maxBytes) {
      return c.json({ error: "Request body too large" }, 413);
    }
  }

  const reader = c.req.raw.body?.getReader();
  if (!reader) return JSON.parse("") as T;

  const decoder = new TextDecoder();
  let bytesRead = 0;
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytesRead += value.byteLength;
    if (bytesRead > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return c.json({ error: "Request body too large" }, 413);
    }
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  return JSON.parse(text) as T;
}
