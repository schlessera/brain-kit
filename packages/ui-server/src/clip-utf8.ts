/**
 * `text` cut to at most `limit` UTF-8 bytes, at the last complete sequence at
 * or below the limit. An incomplete trailing sequence is dropped rather than
 * replaced, so a bounded stored value never exceeds its bound.
 */
export function clipUtf8(text: string, limit: number): string {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= limit) return text;
  for (let end = limit; end >= limit - 3; end--) {
    try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, end)); } catch { /* try the prior boundary */ }
  }
  return "";
}
