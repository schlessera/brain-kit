/** Host-only, bounded inspection of the provider's initial Messages SSE usage. */
export interface InferenceUsage {
  inputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}
const MAX_INITIAL_USAGE_BYTES = 64 * 1024;

/** No parsing or await occurs on a chunk's forwarding path. Unknown data is absent. */
export function inferenceUsageObserver(record: (usage: InferenceUsage) => void) {
  const decoder = new TextDecoder();
  let buffer = "", retained = 0, done = false, skipLF = false;
  const parse = (chunk: Uint8Array) => {
    if (done) return;
    try {
      // SSE permits LF, CRLF and bare CR, including endings split across chunks.
      for (const char of decoder.decode(chunk, { stream: true })) {
        if (skipLF && char === "\n") { skipLF = false; continue; }
        skipLF = char === "\r";
        buffer += skipLF ? "\n" : char;
      }
      let boundary: number;
      while ((boundary = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
        const lines = frame.split("\n"), event = lines.find(line => line.startsWith("event:"))?.slice(6).trim();
        const data = lines.filter(line => line.startsWith("data:")).map(line => line.slice(5).replace(/^ /, "")).join("\n");
        if (!data) continue; // Blank/comment-only frames do not start a message.
        let value: any;
        try { value = JSON.parse(data); } catch { done = true; return; }
        if (value?.type === "ping" && (!event || event === "ping")) continue;
        // Only the first substantive frame can supply initial usage. Both the
        // SSE label (when supplied) and JSON type must identify message_start.
        done = true;
        if (value?.type !== "message_start" || (event && event !== "message_start")) return;
        const usage = value?.message?.usage;
        if (!usage || typeof usage !== "object" || Array.isArray(usage)) return;
        const result: InferenceUsage = {};
        for (const [source, target] of [["input_tokens", "inputTokens"], ["cache_read_input_tokens", "cacheReadTokens"], ["cache_creation_input_tokens", "cacheCreationTokens"]] as const) {
          const count = usage[source];
          if (count === undefined || count === null) continue;
          if (!Number.isSafeInteger(count) || count < 0) return;
          result[target] = count;
        }
        if (Object.keys(result).length) record(result);
        return;
      }
    } catch { done = true; /* Diagnostics never break the response. */ }
  };
  return (chunk: Uint8Array) => {
    if (done || retained >= MAX_INITIAL_USAGE_BYTES) return;
    const observed = chunk.subarray(0, MAX_INITIAL_USAGE_BYTES - retained);
    retained += observed.byteLength;
    queueMicrotask(() => parse(observed));
  };
}
