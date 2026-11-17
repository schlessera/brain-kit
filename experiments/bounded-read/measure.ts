/**
 * Plain measurement helpers for retrieval-tool experiments (#3641, reusable by
 * the multi-query search spike #3645). Functions over values; no runner, no
 * registry, no orchestration seam.
 *
 * Units, stated once:
 * - `chars`: UTF-16 code units, JavaScript's `string.length`. The unit every
 *   brain-kit result budget uses (`brainReadBaseResult`, Pi `clip`,
 *   `estimateTokens`) and the one the Claude Agent SDK applies to tool output.
 * - `bytes`: UTF-8 bytes, what crosses a pipe or a socket.
 * - `estTokens`: core's `estimateTokens` rule, ceil(chars / 4). An estimate
 *   for budgeting, never a provider token count.
 */
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

export const chars = (text: string): number => text.length;
export const bytes = (text: string): number => Buffer.byteLength(text, "utf8");
export const estTokens = (text: string): number => Math.ceil(text.length / 4);
/** Chars a string adds inside a JSON document, escaping included, quotes excluded. */
export const escapedChars = (text: string): number => JSON.stringify(text).length - 2;

/** Size of a text in all three units. */
export function sizeOf(text: string): { chars: number; bytes: number; estTokens: number } {
  return { chars: chars(text), bytes: bytes(text), estTokens: estTokens(text) };
}

/**
 * Dimensions an offline harness cannot observe. A result row carries this
 * object instead of a zero or a guess, so a reader never mistakes absence of
 * evidence for a measured saving.
 */
export const UNAVAILABLE = {
  providerInputTokens: "unavailable: no real provider request was made (scripted or no provider)",
  providerOutputTokens: "unavailable: no real provider request was made",
  providerCacheTokens: "unavailable: no real provider request was made",
  cost: "unavailable: no real provider request was made",
  modelUsability: "unavailable: no authorized real-model trial; scripted tool choices prove mechanics only",
} as const;

/** Wall time of one async operation, in milliseconds. */
export async function timed<T>(fn: () => Promise<T> | T): Promise<{ value: T; ms: number }> {
  const start = performance.now();
  const value = await fn();
  return { value, ms: performance.now() - start };
}

export function median(values: number[]): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Largest number of intervals open at once. */
export function maxOverlap(intervals: Array<{ start: number; end: number }>): number {
  const edges = intervals.flatMap(i => [[i.start, 1], [i.end, -1]] as const).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let open = 0, max = 0;
  for (const [, d] of edges) { open += d; max = Math.max(max, open); }
  return max;
}

/** Every JSON-RPC message one MCP client transport sent and received, as serialized JSON. */
export interface WireLog { sent: string[]; received: string[] }

/**
 * Record a connected MCP client transport's traffic. Call after
 * `client.connect(transport)`, which installs the `onmessage` this wraps.
 * Each entry is `JSON.stringify` of the message: the stdio line without its
 * newline, since the SDK frames each message as one JSON line.
 */
export function recordWire(transport: Transport): WireLog {
  const log: WireLog = { sent: [], received: [] };
  const onmessage = transport.onmessage;
  if (!onmessage) throw new Error("connect the client before recording its transport");
  transport.onmessage = (message, extra) => { log.received.push(JSON.stringify(message)); onmessage.call(transport, message, extra); };
  const send = transport.send.bind(transport);
  transport.send = async (message, options) => { log.sent.push(JSON.stringify(message)); return send(message, options); };
  return log;
}

/** Bytes and chars of a slice of a wire log. */
export function wireTotals(lines: string[]): { messages: number; chars: number; bytes: number } {
  return { messages: lines.length, chars: lines.reduce((a, l) => a + l.length, 0), bytes: lines.reduce((a, l) => a + bytes(l) + 1, 0) };
}

/**
 * Overhead of one tool response: its serialized size minus the payload text it
 * carries, measured as the payload adds itself inside JSON (escaping counted).
 */
export function envelopeOverhead(serialized: string, payloads: string[]): number {
  return serialized.length - payloads.reduce((a, p) => a + escapedChars(p), 0);
}
