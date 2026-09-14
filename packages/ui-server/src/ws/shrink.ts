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
 * Progressive shrink passes. Each tightens display strings and array tails;
 * the loop stops when the serialized UTF-8 payload fits. Identity strings
 * remain intact, and typed arrays never receive an untyped elision marker.
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

/** JSON's UTF-8 wire size, including escaped control characters. */
export function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

// These strings identify protocol objects rather than display text.
const IDENTITY_FIELDS = new Set([
  "id", "type", "kind", "role", "name", "sessionId", "turnId", "draftId",
  "requestId", "toolUseId", "parentToolUseId", "providerId", "backendId",
]);

/**
 * Recursively walk `value`, head-truncating any string longer than
 * `stringCap` and head-clipping any array longer than `arrayLimit`. Returns a
 * freshly built deep clone; short strings/numbers/booleans pass through.
 */
function shrinkWalk(value: unknown, stringCap: number, arrayLimit: number, opaque = false): unknown {
  if (typeof value === "string") {
    if (value.length <= stringCap) return value;
    let headLen = Math.max(0, stringCap - STRING_ELISION_RESERVE);
    // Never split a UTF-16 surrogate pair at the truncation boundary.
    const last = value.charCodeAt(headLen - 1);
    if (last >= 0xd800 && last <= 0xdbff) headLen--;
    return `${value.slice(0, headLen)}\n…[${value.length - headLen} chars elided]`;
  }
  if (Array.isArray(value)) {
    const keep = Math.min(value.length, arrayLimit);
    const out: unknown[] = new Array(keep);
    for (let i = 0; i < keep; i++) out[i] = shrinkWalk(value[i], stringCap, arrayLimit, opaque);
    return out;
  }
  if (value && typeof value === "object") {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    // Arbitrary tool input can exceed the cap through key count alone. Clip
    // its records recursively, while preserving fields on protocol objects.
    const keys = Object.keys(src);
    for (const k of opaque ? keys.slice(0, arrayLimit) : keys) {
      out[k] = !opaque && IDENTITY_FIELDS.has(k) && typeof src[k] === "string"
        ? src[k]
        : shrinkWalk(src[k], stringCap, arrayLimit, opaque || k === "input");
    }
    // History parts refer to toolCalls by array index. Head clipping preserves
    // retained indices, but references to removed tools must go with them.
    if (!opaque && (src.role === "assistant" || src.role === "user") && Array.isArray(out.toolCalls)) {
      const toolCount = out.toolCalls.length;
      if (Array.isArray(out.parts)) {
        out.parts = out.parts.filter((part) =>
          !part || part.kind !== "tool" ||
          (Number.isInteger(part.toolIndex) && part.toolIndex >= 0 && part.toolIndex < toolCount)
        );
      }
      if (Array.isArray(src.toolCalls) && src.toolCalls.length > toolCount && typeof out.content === "string") {
        const notice = `\n…[${src.toolCalls.length - toolCount} tool calls elided]`;
        out.content += notice;
        if (Array.isArray(out.parts)) out.parts.push({ kind: "text", text: notice });
      }
    }
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
export function shrinkForReplication<T>(value: T, maxBytes = MAX_WS_MESSAGE_BYTES): T {
  if (jsonBytes(value) <= maxBytes) return value;
  let shrunk: unknown = value;
  for (const pass of SHRINK_PASSES) {
    shrunk = shrinkWalk(value, pass.stringCap, pass.arrayLimit);
    if (jsonBytes(shrunk) <= maxBytes) return shrunk as T;
  }
  return shrunk as T;
}
