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
  let buffer = "", retained = 0, done = false;
  const parse = (chunk: Uint8Array) => {
    if (done) return;
    try {
      buffer += decoder.decode(chunk, { stream: true });
      buffer = buffer.replace(/\r\n/g, "\n");
      let boundary: number;
      while ((boundary = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
        const lines = frame.split("\n"), event = lines.find(line => line.startsWith("event:"))?.slice(6).trim();
        const data = lines.filter(line => line.startsWith("data:")).map(line => line.slice(5).replace(/^ /, "")).join("\n");
        let value: any;
        try { value = JSON.parse(data); } catch { if (event === "message_start") { done = true; return; } continue; }
        if (event !== "message_start" && value?.type !== "message_start") continue;
        done = true;
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
