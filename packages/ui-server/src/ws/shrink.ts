/**
 * Size-bounding for outbound WebSocket frames.
 *
 * A single oversized frame — typically a multi-megabyte tool result (a big
 * `Read`/`Bash`/`Grep` output), a tool_use with a large input, or a tool
 * result whose content array holds thousands of blocks — can exceed the
 * socket's per-frame limit, drop the connection, and (because the client
 * reconnects and re-requests the same history) wedge into a reconnect loop.
 *
 * This helper bounds any JSON-serializable payload below
 * {@link MAX_WS_MESSAGE_BYTES} by head-truncating long strings AND
 * head-clipping long arrays, leaving small metadata (ids, types, statuses)
 * untouched. Both axes matter: string truncation alone leaves the cap
 * unenforced for a payload built of many short strings. The model already
 * received the full tool output server-side — this only bounds what the
 * browser renders.
 *
 * Ported from oh-my-pi's collab replication-shrink.
 */

/** Per-frame ceiling for server → client messages. Well under Bun's 16 MB
 * default and typical reverse-proxy WebSocket limits. */
export const MAX_WS_MESSAGE_BYTES = 512_000;

/** Target byte size for one `session_history` chunk. Below the frame cap so a
 * batch plus its wrapper stays comfortably under {@link MAX_WS_MESSAGE_BYTES}. */
export const HISTORY_CHUNK_BYTES = 400_000;

interface ShrinkPass {
  stringCap: number;
  arrayLimit: number;
}

/**
 * Progressive shrink passes. Each tightens both the per-string cap and the
 * per-array head limit; the loop stops at the first pass whose output fits
 * {@link MAX_WS_MESSAGE_BYTES}. The final pass clamps every string to 64 B and
 * every array to one element, so even pathological mixes converge.
 */
const SHRINK_PASSES: readonly ShrinkPass[] = [
  { stringCap: 64 * 1024, arrayLimit: 256 },
  { stringCap: 16 * 1024, arrayLimit: 128 },
  { stringCap: 4 * 1024, arrayLimit: 64 },
  { stringCap: 1 * 1024, arrayLimit: 32 },
  { stringCap: 256, arrayLimit: 16 },
  { stringCap: 256, arrayLimit: 4 },
  { stringCap: 64, arrayLimit: 1 },
];

const STRING_ELISION_RESERVE = 80;

/**
 * Recursively walk `value`, head-truncating any string longer than
 * `stringCap` and head-clipping any array longer than `arrayLimit`. Returns a
 * freshly built deep clone; short strings/numbers/booleans pass through.
 */
function shrinkWalk(value: unknown, stringCap: number, arrayLimit: number): unknown {
  if (typeof value === "string") {
    if (value.length <= stringCap) return value;
    const headLen = Math.max(0, stringCap - STRING_ELISION_RESERVE);
    return `${value.slice(0, headLen)}\n…[${value.length - headLen} chars elided]`;
  }
  if (Array.isArray(value)) {
    const keep = Math.min(value.length, arrayLimit);
    const elided = value.length - keep;
    const out: unknown[] = new Array(elided > 0 ? keep + 1 : keep);
    for (let i = 0; i < keep; i++) out[i] = shrinkWalk(value[i], stringCap, arrayLimit);
    if (elided > 0) out[keep] = `…[${elided} items elided]`;
    return out;
  }
  if (value && typeof value === "object") {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k in src) out[k] = shrinkWalk(src[k], stringCap, arrayLimit);
    return out;
  }
  return value;
}

/**
 * Return `value` unchanged when its JSON serialization already fits
 * {@link MAX_WS_MESSAGE_BYTES}; otherwise return a deep-cloned shadow shrunk
 * along both string and array axes until it fits. The wire shape is preserved:
 * only string leaves and array tails change — discriminator fields, ids, and
 * other small metadata pass through untouched.
 */
export function shrinkForReplication<T>(value: T): T {
  if (JSON.stringify(value).length <= MAX_WS_MESSAGE_BYTES) return value;
  let shrunk: unknown = value;
  for (const pass of SHRINK_PASSES) {
    shrunk = shrinkWalk(value, pass.stringCap, pass.arrayLimit);
    if (JSON.stringify(shrunk).length <= MAX_WS_MESSAGE_BYTES) return shrunk as T;
  }
  return shrunk as T;
}
