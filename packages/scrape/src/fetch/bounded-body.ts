/**
 * The one bounded body reader of this package (#4768).
 *
 * It counts bytes as the stream delivers them, refuses the chunk that takes
 * the total past the limit without waiting for the rest, and cancels the
 * stream on every exit, so a refused body stops arriving rather than being
 * drained. An abort signal stops the read the same way. Decoding is the
 * caller's policy: `ScrapeClient`'s text helpers and robots.txt decode
 * leniently, as `Response.text()` does.
 *
 * Packages that do not depend on scrape carry their own copy of the loop
 * (`packages/geo/src/server/io.ts`, `packages/compute-boat/src/client.ts`,
 * `packages/common/src/apify/authority.ts`), as does module-travel's route
 * download, which reads the body after its own redirect check.
 */

/** A body that was refused because it grew past its byte limit. */
export class BodyTooLargeError extends Error {
  constructor(readonly what: string, readonly maxBytes: number) {
    super(`${what} exceeds ${maxBytes} bytes`);
    this.name = "BodyTooLargeError";
  }
}

/**
 * Refuses a byte bound that is not a whole number of bytes, zero or more
 * (#4963). `bytes > maxBytes` is never true for `NaN` or `Infinity`, which
 * would read the whole body, so each entry point checks its option once,
 * before any request, and names it.
 */
export function checkMaxBytes(maxBytes: number, option: string): void {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0)
    throw new RangeError(`${option} must be a whole number of bytes, 0 or more; got ${maxBytes}`);
}

/** Read at most `maxBytes` of `response`'s body, refusing a longer one. */
export async function readBoundedBody(
  response: Response,
  maxBytes: number,
  options: { signal?: AbortSignal; what?: string } = {}
): Promise<Uint8Array> {
  const { signal, what = "response body" } = options;
  signal?.throwIfAborted();
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array(0);
  const stop = () => { void reader.cancel(signal?.reason).catch(() => {}); };
  signal?.addEventListener("abort", stop, { once: true });
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      signal?.throwIfAborted();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes) throw new BodyTooLargeError(what, maxBytes);
      chunks.push(chunk.value);
    }
  } finally {
    signal?.removeEventListener("abort", stop);
    await reader.cancel().catch(() => {});
  }
  const buffer = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return buffer;
}

/** A bounded body decoded as UTF-8 the way `Response.text()` decodes it. */
export async function readBoundedText(
  response: Response,
  maxBytes: number,
  options: { signal?: AbortSignal; what?: string } = {}
): Promise<string> {
  return new TextDecoder().decode(await readBoundedBody(response, maxBytes, options));
}
